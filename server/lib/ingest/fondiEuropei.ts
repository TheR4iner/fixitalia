import { parseNumericValue, stripNulls } from '../parse.ts'
import { swapSnapshots } from '../snapshotSwap.ts'

// -----------------------------------------------------------------------------
// Fondi Europei -- ingest.
//
// Source: OpenCoesione "aggregati" REST API
//   https://opencoesione.gov.it/it/api/aggregati/
//
// OpenCoesione is a huge portal (1.79M projects, 1.1GB project-level CSV)
// but its aggregati endpoint returns a single pre-computed 46KB JSON with
// cumulative totals, regional breakdowns (20 regions), theme breakdowns
// (11 themes), and a year-by-year impegni/pagamenti time series. We land
// all three rollups in SurrealDB from a single HTTP call.
//
// Scope: the figures are cumulative across all cohesion cycles
// (2000-2006, 2007-2013, 2014-2020, 2021-2027 and FSC / PAC), not just
// the current 2021-2027 window. That is the correct framing for "how
// much EU money has ever flowed through each Italian region".
//
// Quirks worth knowing:
//  - Numeric fields are strings with Italian decimal comma
//    ("22935693912,00"). Our shared parseNumericValue handles both
//    Italian and US conventions so no special case is needed here.
//  - Region labels come UPPERCASED ("LOMBARDIA"). We title-case them
//    at ingest time so the chart axis reads naturally. The slug key
//    (e.g. "lombardia-regione") is preserved as `codice`.
//  - Province aggregates also ship (107 rows) but we deliberately do
//    not ingest them -- provinces are a second slice.
//  - The yearly time series includes years as far back as 1990. Most
//    of the useful signal is in the last ~10 years.
// -----------------------------------------------------------------------------

const OPENCOESIONE_AGGREGATI_URL = 'https://opencoesione.gov.it/it/api/aggregati/'
const OPENCOESIONE_CATALOG_URL = 'https://opencoesione.gov.it/it/opendata/'

// Shape of the OpenCoesione aggregati response (only the fields we use).
interface AggregatiResponse {
  data_aggiornamento?: string
  aggregati: {
    totali: RawTotals
    stati_progetti: Record<string, RawEntry>
    territori: {
      regioni: Record<string, RawEntry>
      province?: Record<string, RawEntry>
    }
    temi: Record<string, RawEntry>
    impegni_e_pagamenti_per_anno: Array<{
      anno: number
      ammontare_impegni: number | string
      ammontare_pagamenti: number | string
    }>
  }
}

// Stable display order for project status rows. The API dictionary is
// insertion-ordered but we want a narrative left-to-right ordering from
// "most finished" to "least finished" so a stacked bar reads naturally.
const STATO_ORDER: Record<string, number> = {
  concluso: 1,
  liquidato: 2,
  in_corso: 3,
  non_avviato: 4,
  non_determinabile: 5,
}

interface RawTotals {
  costo_pubblico: string
  costo_pubblico_coesione: string
  pagamenti: string
  pagamenti_coesione: string
  progetti: string | number
}

interface RawEntry {
  label: string
  link?: string
  totali: RawTotals
}

// ---- helpers ---------------------------------------------------------------

// Normalise "LOMBARDIA" -> "Lombardia", "VALLE D'AOSTA/VALLEE D'AOSTE" ->
// "Valle d'Aosta/Vallee d'Aoste". Italian title case is tricky (elisions,
// accents, articles) but the OpenCoesione labels are plain upper ASCII
// with apostrophes and slashes, which this cheap casing handles cleanly.
function titleCaseRegion(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/(^|[\s'/-])(\p{L})/gu, (_, sep, ch: string) => sep + ch.toUpperCase())
}

function rawTotalsToRecord(totals: RawTotals): {
  costo_pubblico: number | null
  costo_pubblico_coesione: number | null
  pagamenti: number | null
  pagamenti_coesione: number | null
  progetti: number | null
} {
  return {
    costo_pubblico: parseNumericValue(totals.costo_pubblico),
    costo_pubblico_coesione: parseNumericValue(totals.costo_pubblico_coesione),
    pagamenti: parseNumericValue(totals.pagamenti),
    pagamenti_coesione: parseNumericValue(totals.pagamenti_coesione),
    progetti: parseNumericValue(totals.progetti),
  }
}

// ---- ingest ----------------------------------------------------------------

async function fetchAggregati(): Promise<AggregatiResponse> {
  const res = await fetch(OPENCOESIONE_AGGREGATI_URL, {
    headers: {
      'user-agent': 'fixitalia-ingest/0.1 (+https://github.com/TheR4iner/fixitalia)',
      accept: 'application/json',
    },
  })
  if (!res.ok) {
    throw new Error(`OpenCoesione download failed: HTTP ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as AggregatiResponse
}

export interface IngestResult {
  source: string
  regioniIngested: number
  temiIngested: number
  yearlyIngested: number
  stati: number
  totaliIngested: number
  durationMs: number
}

export async function ingestFondiEuropei(): Promise<IngestResult> {
  const started = Date.now()
  console.log('[ingest:fondi] fetching OpenCoesione aggregati...')
  const response = await fetchAggregati()
  console.log(`[ingest:fondi] received (data_aggiornamento=${response.data_aggiornamento ?? '?'})`)

  const agg = response.aggregati

  // Regions.
  const regioneRecords = Object.entries(agg.territori.regioni).map(([slug, entry]) => ({
    codice: slug,
    nome: titleCaseRegion(entry.label),
    ...rawTotalsToRecord(entry.totali),
    fonte_url: OPENCOESIONE_CATALOG_URL,
  }))

  // Themes.
  const temiRecords = Object.entries(agg.temi).map(([slug, entry]) => ({
    codice: slug,
    nome: entry.label,
    ...rawTotalsToRecord(entry.totali),
    fonte_url: OPENCOESIONE_CATALOG_URL,
  }))

  // Yearly impegni + pagamenti.
  const yearlyRecords = agg.impegni_e_pagamenti_per_anno.map((row) => ({
    anno: parseNumericValue(row.anno),
    ammontare_impegni: parseNumericValue(row.ammontare_impegni),
    ammontare_pagamenti: parseNumericValue(row.ammontare_pagamenti),
    fonte_url: OPENCOESIONE_CATALOG_URL,
  }))

  // Project completion status breakdown.
  const statiRecords = Object.entries(agg.stati_progetti).map(([slug, entry]) => ({
    codice: slug,
    nome: entry.label,
    ordine: STATO_ORDER[slug] ?? 99,
    ...rawTotalsToRecord(entry.totali),
    fonte_url: OPENCOESIONE_CATALOG_URL,
  }))

  // Top-level totals. These CANNOT be reconstructed by summing the
  // regional rows because multi-region projects are counted in each of
  // their regions, so SUM(fondi_regioni.costo_pubblico) overstates the
  // true pipeline value by ~50%. We store the API-level totals in their
  // own table and use those for the KPI card.
  const totaliRecord = stripNulls({
    ...rawTotalsToRecord(agg.totali),
    data_aggiornamento: response.data_aggiornamento ?? null,
    fonte_url: OPENCOESIONE_CATALOG_URL,
  })

  const regioni = regioneRecords.map((r) => stripNulls(r))
  const temi = temiRecords.map((r) => stripNulls(r))
  const yearly = yearlyRecords.map((r) => stripNulls(r))
  const stati = statiRecords.map((r) => stripNulls(r))

  // All five tables move in ONE transaction, which matters more here than
  // anywhere else: the page reads them together, so a reader must never catch
  // the KPI totals from the new snapshot next to regional rows from the old
  // one. Passing them to swapSnapshots as a set is what guarantees that.
  await swapSnapshots([
    { table: 'fondi_regioni', rows: regioni },
    { table: 'fondi_temi', rows: temi },
    { table: 'fondi_yearly', rows: yearly },
    { table: 'fondi_stati', rows: stati },
    { table: 'fondi_totali', rows: [totaliRecord] },
  ])

  const durationMs = Date.now() - started
  console.log(
    `[ingest:fondi] upserted ${regioni.length} regioni + ${temi.length} temi + ${yearly.length} yearly + ${stati.length} stati + 1 totali in ${durationMs} ms`,
  )

  return {
    source: OPENCOESIONE_AGGREGATI_URL,
    regioniIngested: regioni.length,
    temiIngested: temi.length,
    yearlyIngested: yearly.length,
    stati: stati.length,
    totaliIngested: 1,
    durationMs,
  }
}
