import { parse } from 'csv-parse/sync'
import { unzipSync, strFromU8 } from 'fflate'

import { cleanString } from '../parse.ts'
import { regionFromProvinceCode } from '../regions.ts'
import { swapSnapshots } from '../snapshotSwap.ts'

// -----------------------------------------------------------------------------
// Appalti -- ingest of ANAC "Stazioni Appaltanti".
//
// Source: ANAC (Autorita Nazionale Anticorruzione) open data catalog
//   https://dati.anticorruzione.it/opendata/dataset/stazioni-appaltanti
//
// One row per contracting authority ("stazione appaltante") in the
// national registry. About 48k rows, 13 MB uncompressed (3 MB zipped).
//
// ANAC publishes multiple much bigger datasets (CIG, aggiudicazioni,
// aggiudicatari, smartcig) that contain actual contract-level data, but
// each monthly file of those is 50-200 MB compressed and hundreds of MB
// uncompressed. We deliberately avoid them for a first slice and ingest
// the bounded registry instead. The registry alone supports the real
// story "how fragmented is Italian public procurement?" which is the
// brainstorm's framing.
//
// Quirks worth knowing:
//  - ANAC's web tier sits behind a WAF that rejects curl's default UA
//    and plain `fetch` requests with no headers, returning a 200 HTML
//    page titled "Request Rejected" with an F5 support ID. We have to
//    send a realistic browser User-Agent and Accept headers. Node's
//    `fetch` does the former by default now, but we set both
//    explicitly so an accidental downgrade in Node does not break us.
//  - The file is a single-entry zip. We use fflate's synchronous
//    unzipSync because the payload is 3 MB and doing it in one shot
//    keeps the code obvious. A bigger source would need streaming.
//  - Columns are semicolon-separated and quoted. UTF-8 throughout.
//  - `provincia_codice` ships as "IT-MI"; our regionFromProvinceCode
//    helper normalises both the IT- prefix and the bare form.
//  - Boolean columns come as the literal strings "true" / "false".
// -----------------------------------------------------------------------------

const ANAC_ZIP_URL =
  'https://dati.anticorruzione.it/opendata/download/dataset/stazioni-appaltanti/filesystem/stazioni-appaltanti_csv.zip'

const ANAC_CATALOG_URL = 'https://dati.anticorruzione.it/opendata/dataset/stazioni-appaltanti'

// CSV header -> record-field mapping is applied directly inline in
// `mapRow` below. The literal header strings (`codice_fiscale`,
// `flag_inHouse`, `citta_nome`, ...) are the contract with the ANAC
// publisher: keep them in sync with the upstream column names when the
// schema shifts.
interface StazioneRecord {
  codice_fiscale: string | null
  partita_iva: string | null
  denominazione: string | null
  codice_ausa: string | null
  natura_giuridica_codice: string | null
  natura_giuridica: string | null
  provincia_codice: string | null
  provincia: string | null
  regione: string | null
  citta: string | null
  codice_istat: string | null
  cap: string | null
  flag_in_house: boolean | null
  flag_partecipata: boolean | null
  stato: string | null
  fonte_url: string
}

function parseBool(raw: unknown): boolean | null {
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  if (s === 'true' || s === 'si' || s === 's' || s === '1') return true
  if (s === 'false' || s === 'no' || s === 'n' || s === '0') return false
  return null
}

function titleCaseItalian(raw: string | null): string | null {
  if (!raw) return raw
  // Source data is mostly SHOUTY UPPERCASE. Apply a simple Italian title
  // case: first letter of each word becomes upper, rest lower. Skip short
  // words (<= 3 chars) that are usually articles/prepositions in the
  // middle of a phrase ("DI", "DEL", "E", "LA").
  const lower = raw.toLowerCase()
  return lower.replace(/(^|[\s'/(-])(\p{L})/gu, (_m, sep: string, ch: string) =>
    sep + ch.toUpperCase(),
  )
}

function mapRow(row: Record<string, string>): StazioneRecord {
  const denominazione = cleanString(row['denominazione'])
  const naturaCode = cleanString(row['natura_giuridica_codice'])
  const naturaDesc = cleanString(row['natura_giuridica_descrizione'])
  const provCode = cleanString(row['provincia_codice'])
  const provName = cleanString(row['provincia_nome'])
  const citta = cleanString(row['citta_nome'])
  const regione = regionFromProvinceCode(provCode)

  return {
    codice_fiscale: cleanString(row['codice_fiscale']),
    partita_iva: cleanString(row['partita_iva']),
    denominazione: denominazione ? titleCaseItalian(denominazione) : null,
    codice_ausa: cleanString(row['codice_ausa']),
    natura_giuridica_codice: naturaCode,
    natura_giuridica: naturaDesc ? titleCaseItalian(naturaDesc) : null,
    provincia_codice: provCode,
    provincia: provName ? titleCaseItalian(provName) : null,
    regione,
    citta: citta ? titleCaseItalian(citta) : null,
    codice_istat: cleanString(row['citta_codice']),
    cap: cleanString(row['cap']),
    flag_in_house: parseBool(row['flag_inHouse']),
    flag_partecipata: parseBool(row['flag_partecipata']),
    // ANAC switched stato to UPPERCASE ("ATTIVO" / "CESSATO") in early 2026.
    // We keep it as shipped because the read-side queries already filter on
    // the uppercase value; no UI surface displays this field directly.
    stato: cleanString(row['stato']),
    fonte_url: ANAC_CATALOG_URL,
  }
}

async function fetchZip(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: {
      // ANAC's WAF rejects non-browser User-Agents outright.
      'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      accept: 'application/zip,application/octet-stream,*/*',
    },
  })
  if (!res.ok) {
    throw new Error(`ANAC download failed: HTTP ${res.status} ${res.statusText}`)
  }
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}

function unzipSingleCsv(zip: Uint8Array): string {
  const files = unzipSync(zip)
  const entry = Object.entries(files).find(([name]) => name.toLowerCase().endsWith('.csv'))
  if (!entry) {
    throw new Error('ANAC zip does not contain a .csv file')
  }
  return strFromU8(entry[1])
}

export interface IngestResult {
  source: string
  rowsParsed: number
  rowsIngested: number
  rowsActive: number
  durationMs: number
}

export async function ingestAppalti(): Promise<IngestResult> {
  const started = Date.now()
  console.log('[ingest:appalti] downloading ANAC stazioni-appaltanti zip...')
  const zip = await fetchZip(ANAC_ZIP_URL)
  console.log(`[ingest:appalti] download ok (${zip.length} bytes compressed)`)

  const csv = unzipSingleCsv(zip)
  console.log(`[ingest:appalti] unzipped (${csv.length} bytes)`)

  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    delimiter: ';',
    relax_column_count: true,
    relax_quotes: true,
  }) as Array<Record<string, string>>
  console.log(`[ingest:appalti] parsed ${rows.length} rows`)

  // Strip null/undefined fields so SurrealDB's option<T> schema accepts
  // the inserts (option<T> means "absent or T", not "null or T").
  const records = rows.map(mapRow).map((record) =>
    Object.fromEntries(
      Object.entries(record).filter(([, v]) => v !== null && v !== undefined),
    ),
  )

  const rowsActive = records.filter(
    (r) => (r as { stato?: string }).stato === 'ATTIVO',
  ).length

  // Staged swap rather than wipe-and-reinsert. This is the source that needed
  // it most: 48k rows take tens of seconds to load, and for all of that time
  // the old code left the table empty, so the whole Appalti page read zero.
  // The staging load is invisible; only the final move is visible, and it is
  // atomic. See lib/snapshotSwap.ts.
  const ingested = await swapSnapshots([{ table: 'appalti_stazioni', rows: records }])

  const durationMs = Date.now() - started
  console.log(
    `[ingest:appalti] upserted ${ingested} rows (${rowsActive} attive) in ${durationMs} ms`,
  )

  return {
    source: ANAC_ZIP_URL,
    rowsParsed: rows.length,
    rowsIngested: ingested,
    rowsActive,
    durationMs,
  }
}
