import * as XLSX from 'xlsx'

import { ckanLatestFirst, ckanPackageShow, type CkanResource } from '../ckan.ts'
import { parseNumericValue, cleanString } from '../parse.ts'
import { swapSnapshots } from '../snapshotSwap.ts'
import { regionFromNuts, regionFromIstatRegionCode } from '../regions.ts'

// -----------------------------------------------------------------------------
// MIT Anagrafe delle Opere Pubbliche Incompiute -- ingest.
//
// Source: Ministero delle infrastrutture e dei trasporti, Open Data catalog,
// dataset "opere-incompiute". The canonical landing page is
//   https://dati.mit.gov.it/catalog/dataset/opere-incompiute
//
// MIT switched the publication schema starting from the 2021 reference year:
// the file went from ~80 columns of detail down to ~18 summary columns. We
// can no longer surface the per-row breakdown of importo lavori vs. SAL, but
// we get fresher data and a few new fields ("Stato dell'opera incompiuta",
// "Provincia", and "Importo oneri", which is the legally-required estimate
// of the cost still needed to complete the work).
//
// We parse with SheetJS because exceljs does not support the legacy .xls
// format. We pin to the patched 0.20.x release distributed via SheetJS's
// own CDN, NOT the npm version which has two unpatched high-severity CVEs
// (prototype pollution + ReDoS, both fixed upstream but never backported).
//
// File resolution: rather than hard-coding the UUID of any single year's
// resource, we ask CKAN for the package and pick the most-recently-modified
// xls whose name matches the annual snapshot pattern. This way the next
// reference year's file (whenever MIT publishes it) is picked up by a
// re-ingest, no code change required.
// -----------------------------------------------------------------------------

const MIT_CKAN_BASE = 'https://dati.mit.gov.it/catalog'
const MIT_DATASET_ID = 'opere-incompiute'
const MIT_CATALOG_URL = 'https://dati.mit.gov.it/catalog/dataset/opere-incompiute'

// Match the annual snapshot resource name, e.g.
//   "Opere Incompiute scadenza 30-06-2024 anno riferimento 2023.xls".
// The 2016/2017 historical files use a different naming scheme and we
// deliberately exclude them; their schema is the older 80-column form.
const MIT_ANNUAL_NAME_RE = /scadenza.*anno\s*riferimento\s*(\d{4})/i

// Map from XLS column header (verbatim from the 2023 sheet) to our field
// name. The 2023 schema dropped the per-row Settore / Categoria / Natura /
// Importo lavori / Importo SAL / Indirizzo / Descrizione that the 2017 CSV
// had. We keep the field names in our DB compatible across years -- the
// SCHEMALESS table just leaves dropped fields absent.
const COLUMN_2023 = {
  'Anno di rif.': 'anno_riferimento',
  CUP: 'cup',
  'Graduatoria pubblicata da': 'stazione_appaltante',
  "Provincia dell'intestatario": 'provincia',
  'Stato dell\'opera incompiuta': 'stato',
  'Titolo dell\'opera incompiuta': 'titolo',
  'Localizz. cod. ISTAT': 'codice_istat',
  'Localizz. cod. NUTS': 'cod_nuts',
  "Importo complessivo intervento aggiornato all'ultimo q.e.": 'importo_intervento',
  'Importo oneri': 'importo_oneri',
  '% Avanz.': 'perc_avanzamento',
  "L'opera \u00e8 fruibile dalla collettivit\u00e0?": 'opera_fruibile',
  'Possibile uso ridim.?': 'uso_ridimensionato',
} as const

interface OpereIncompiuteRecord {
  titolo: string | null
  cup: string | null
  stazione_appaltante: string | null
  provincia: string | null
  stato: string | null
  codice_istat: string | null
  cod_nuts: string | null
  regione: string | null
  importo_intervento: number | null
  importo_oneri: number | null
  perc_avanzamento: number | null
  opera_fruibile: string | null
  uso_ridimensionato: string | null
  anno_riferimento: number | null
  fonte_url: string
}

function mapRow(
  row: Record<string, unknown>,
  fallbackYear: number | null,
): OpereIncompiuteRecord {
  const get = (header: keyof typeof COLUMN_2023) => row[header]

  const codIstat = cleanString(get('Localizz. cod. ISTAT'))
  const codNuts = cleanString(get('Localizz. cod. NUTS'))
  // Prefer NUTS-based region lookup. Fall back to the region prefix of the
  // 9-digit MIT ISTAT code when NUTS is missing or unrecognised.
  const regione = regionFromNuts(codNuts) ?? regionFromIstatRegionCode(codIstat)

  return {
    titolo: cleanString(get("Titolo dell'opera incompiuta")),
    cup: cleanString(get('CUP')),
    stazione_appaltante: cleanString(get('Graduatoria pubblicata da')),
    provincia: cleanString(get("Provincia dell'intestatario")),
    stato: cleanString(get("Stato dell'opera incompiuta")),
    codice_istat: codIstat,
    cod_nuts: codNuts,
    regione,
    importo_intervento: parseNumericValue(
      get("Importo complessivo intervento aggiornato all'ultimo q.e."),
    ),
    importo_oneri: parseNumericValue(get('Importo oneri')),
    perc_avanzamento: parseNumericValue(get('% Avanz.')),
    opera_fruibile: cleanString(get("L'opera \u00e8 fruibile dalla collettivit\u00e0?")),
    uso_ridimensionato: cleanString(get('Possibile uso ridim.?')),
    anno_riferimento: parseNumericValue(get('Anno di rif.')) ?? fallbackYear,
    fonte_url: MIT_CATALOG_URL,
  }
}

interface ResolvedMITResource {
  url: string
  name: string
  year: number | null
}

// Walk the CKAN package and pick the freshest annual xls.
//
// We sort by the reference year encoded in the filename
// (e.g. "anno-riferimento-2023.xls"), NOT by last_modified, because MIT
// re-uploads all historical files in one batch when they refresh metadata
// (e.g. all three 2021/2022/2023 files were uploaded within minutes of each
// other on 2024-07-26). Treating last_modified as the freshness signal
// would pick whichever was uploaded last in that batch, which has no
// relationship to data freshness. The reference year is the truth.
async function resolveLatestAnnualXls(): Promise<ResolvedMITResource> {
  const pkg = await ckanPackageShow(MIT_CKAN_BASE, MIT_DATASET_ID)
  const candidates: Array<CkanResource & { year: number }> = []
  for (const r of pkg.resources) {
    const fmt = (r.format || '').toLowerCase()
    if (fmt !== 'xls') continue
    const m = (r.name || r.url || '').match(MIT_ANNUAL_NAME_RE)
    if (!m) continue
    const year = Number(m[1])
    if (!Number.isFinite(year)) continue
    candidates.push({ ...r, year })
  }
  if (candidates.length === 0) {
    throw new Error(
      'MIT opere-incompiute: no annual xls resource matched the snapshot pattern. ' +
        'Has the publisher renamed the file? Check ' +
        MIT_CATALOG_URL,
    )
  }
  candidates.sort((a, b) => b.year - a.year || ckanLatestFirst(a, b))
  const top = candidates[0]!
  return { url: top.url, name: top.name || '', year: top.year }
}

async function fetchXls(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'fixitalia-ingest/0.1 (+https://github.com/TheR4iner/fixitalia)' },
  })
  if (!res.ok) {
    throw new Error(`MIT download failed: HTTP ${res.status} ${res.statusText}`)
  }
  return await res.arrayBuffer()
}

export interface IngestResult {
  source: string
  referenceYear: number
  rowsParsed: number
  rowsIngested: number
  durationMs: number
}

export async function ingestOpereIncompiute(): Promise<IngestResult> {
  const started = Date.now()
  console.log('[ingest:opere] resolving latest annual xls via CKAN...')
  const resolved = await resolveLatestAnnualXls()
  console.log(
    `[ingest:opere] using "${resolved.name}" (anno_riferimento=${resolved.year ?? '?'})`,
  )
  const buf = await fetchXls(resolved.url)
  console.log(`[ingest:opere] download ok (${buf.byteLength} bytes)`)

  const wb = XLSX.read(buf, { type: 'buffer' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) {
    throw new Error('MIT XLS workbook has no sheets')
  }
  const sheet = wb.Sheets[sheetName]
  if (!sheet) {
    throw new Error(`MIT XLS sheet "${sheetName}" is empty`)
  }
  // header: 1 returns rows as arrays so we can take the first row as the
  // header explicitly. defval: null normalises empty cells to null.
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    blankrows: false,
  }) as unknown[][]
  if (aoa.length < 2) {
    throw new Error(`MIT XLS sheet "${sheetName}" has no data rows`)
  }
  const headers = aoa[0]?.map((h) => String(h ?? '').trim()) ?? []
  const dataRows = aoa.slice(1)

  const rowObjects = dataRows
    .filter((row) => row.some((cell) => cell != null && String(cell).trim() !== ''))
    .map((row) => {
      const obj: Record<string, unknown> = {}
      headers.forEach((header, i) => {
        if (header) obj[header] = row[i]
      })
      return obj
    })
  console.log(`[ingest:opere] parsed ${rowObjects.length} data rows`)

  // SurrealDB's `option<T>` schema means the field must be either absent or
  // of type T. A literal NULL value fails the type check, so we strip any
  // null/undefined fields from each record before inserting.
  //
  // We also drop the regional subtotal rows MIT embeds in the sheet
  // ("TOTALE OPERE 16" etc., one per region) which would otherwise inflate
  // every aggregate.
  const records = rowObjects
    .map((row) => mapRow(row, resolved.year))
    .filter((record) => {
      const titolo = record.titolo?.toUpperCase() ?? ''
      return !titolo.startsWith('TOTALE')
    })
    .map((record) =>
      Object.fromEntries(
        Object.entries(record).filter(([, v]) => v !== null && v !== undefined),
      ),
    )

  // Staged swap rather than wipe-and-reinsert: a reader arriving mid-ingest
  // must keep seeing the previous graduatoria, not an empty registry rendered
  // as "0 opere". See lib/snapshotSwap.ts.
  const ingested = await swapSnapshots([{ table: 'opere_incompiute', rows: records }])

  const durationMs = Date.now() - started
  console.log(`[ingest:opere] upserted ${ingested} rows in ${durationMs} ms`)

  return {
    source: resolved.url,
    referenceYear: resolved.year ?? 0,
    rowsParsed: rowObjects.length,
    rowsIngested: ingested,
    durationMs,
  }
}
