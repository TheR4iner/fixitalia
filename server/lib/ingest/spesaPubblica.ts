import { parse } from 'csv-parse/sync'

import { ckanPackageSearchAll, ckanPackageShow, type CkanPackage } from '../ckan.ts'
import { parseNumericValue, cleanString, stripNulls } from '../parse.ts'
import { swapSnapshots } from '../snapshotSwap.ts'

// -----------------------------------------------------------------------------
// Spesa Pubblica -- ingest.
//
// Source: BDAP (Banca Dati Amministrazioni Pubbliche, Ragioneria Generale
// dello Stato), Open Data catalog. The dataset is
//   "Pagamenti Bilancio dello Stato per Missione"
// which groups the state's payments in a given fiscal year by *missione*,
// the functional classification of Italian state spending (Health,
// Education, Defense, etc.). One row per mission.
//
// SNAPSHOT SEMANTICS -- read this before touching the resolution logic.
//
// BDAP publishes one package per accounting month, each holding the
// *cumulative* payments from January through that month:
//   spd_<mmm>_spe_pbs_mis_01_<yyyy>_01     (cumulative through <mmm>)
//   spd_rnd_spe_pbs_mis_01_<yyyy>          (end-of-year consuntivo)
//
// This means a single "latest package" is NOT a yearly total: picking
// whichever package was most recently published yields a partial
// year-to-date figure. That is exactly the bug this module used to have --
// production showed 195.477.227.576 EUR labelled "pagamenti del Bilancio
// dello Stato nel 2025", which was in fact January-February *2026*, while
// the real 2025 total is 1.154.165.459.884 EUR.
//
// So we resolve TWO snapshots and tag every row with which one it came
// from, letting the read side label each honestly:
//
//   periodo = 'annuale'      the December package of the most recent year
//                            that has one -> a genuine full-year total.
//   periodo = 'progressivo'  the most recent monthly package overall ->
//                            year-to-date for the year in progress.
//
// When the newest monthly package IS a December, the two coincide and we
// only ingest the annual one.
//
// Why December and not the `rnd` consuntivo: they carry identical figures
// (verified for 2024 and 2025 -- both 1.154.165.459.883,84 for 2025), but
// the `rnd` files drop the `Mese contabile` column and spell the amount
// header `Totale pagato` with a lowercase p. Selecting `rnd` therefore used
// to produce 34 rows with no amount at all and a silent 0 EUR on the page.
// We exclude `rnd` from selection and tolerate both header spellings.
//
// Notes on the upstream:
//  - The CKAN metadata exposes datastore/dump URLs with scheme `http://`
//    but port 80 is effectively dead on bdap-opendata.rgs.mef.gov.it; we
//    must explicitly upgrade to HTTPS.
//  - The CSV is semicolon-separated, UTF-8, and uses US-style numbers
//    with dot as decimal separator. Amounts are in euro.
//  - Early-year snapshots legitimately carry fewer than 34 rows (a mission
//    with no payments yet is simply absent), so the mission count is a
//    property of the snapshot and must never be hard-coded in the UI.
//  - We originally planned to use SoldiPubblici (soldipubblici.gov.it)
//    for this section but that site is currently redirecting to an AgID
//    maintenance page, so we switched to BDAP which is the authoritative
//    upstream anyway.
// -----------------------------------------------------------------------------

const BDAP_CKAN_BASE = 'https://bdap-opendata.rgs.mef.gov.it/SpodCkanApi'
const BDAP_CATALOG_BASE = 'https://bdap-opendata.rgs.mef.gov.it/catalog'

// Monthly missione packages only. `rnd` is deliberately NOT matched here --
// see the header comment. The `_01` suffix and the `mis_01` segment are what
// distinguish the plain missione rollup from the finer-grained variants
// (`misam`, `misce`, `amice`, ...) that share the same prefix.
const BDAP_MONTHLY_NAME_RE =
  /^spd_(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)_spe_pbs_mis_01_(\d{4})_01$/i

const MONTH_NUMBERS: Record<string, number> = {
  gen: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  mag: 5,
  giu: 6,
  lug: 7,
  ago: 8,
  set: 9,
  ott: 10,
  nov: 11,
  dic: 12,
}

const MONTH_LABELS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
]

/** Which coverage a row's snapshot represents. Persisted on every row. */
export type SpesaPeriodo = 'annuale' | 'progressivo'

// Map from raw CSV header to our curated field name. Lookup is normalised
// (lowercased, whitespace-collapsed) so a publisher-side capitalisation
// change cannot silently blank a column.
const COLUMN_MAP: Record<string, string> = {
  'esercizio finanziario': 'anno',
  'mese contabile': 'mese_contabile',
  'codice missione': 'codice_missione',
  missione: 'missione',
  'op erario': 'op_erario',
  'op tesoreria': 'op_tesoreria',
  'op esterno': 'op_esterno',
  'oa tesoreria': 'oa_tesoreria',
  'oa spesa funz deleg': 'oa_spesa_deleg',
  'rsf stipendi': 'rsf_stipendi',
  'rsf altro': 'rsf_altro',
  'totale pagato': 'totale_pagato',
}

const NUMERIC_FIELDS = new Set([
  'anno',
  'op_erario',
  'op_tesoreria',
  'op_esterno',
  'oa_tesoreria',
  'oa_spesa_deleg',
  'rsf_stipendi',
  'rsf_altro',
  'totale_pagato',
])

// A type alias rather than an interface on purpose: TypeScript only grants an
// implicit index signature to type aliases, and `stripNulls` is constrained to
// `Record<string, unknown>`.
type SpesaMissioneRecord = {
  codice_missione: string | null
  missione: string | null
  anno: number | null
  mese_contabile: string | null
  mese_numero: number | null
  periodo: SpesaPeriodo
  op_erario: number | null
  op_tesoreria: number | null
  op_esterno: number | null
  oa_tesoreria: number | null
  oa_spesa_deleg: number | null
  rsf_stipendi: number | null
  rsf_altro: number | null
  totale_pagato: number | null
  pacchetto: string
  fonte_url: string
}

function normalizeHeader(raw: string): string {
  return raw.replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Project one CSV row onto our field names via the normalised header map.
 *
 * Returns a partial record: every mapped field is present (possibly null),
 * unmapped CSV columns are dropped. The caller supplies the snapshot-level
 * fields, which are authoritative over anything the CSV says, because they
 * come from the package name we deliberately selected.
 */
function mapRow(
  row: Record<string, string>,
  snapshot: ResolvedBDAPSnapshot,
): SpesaMissioneRecord {
  const mapped: Record<string, string | number | null> = {}
  for (const [rawHeader, rawValue] of Object.entries(row)) {
    const field = COLUMN_MAP[normalizeHeader(rawHeader)]
    if (!field) continue
    mapped[field] = NUMERIC_FIELDS.has(field)
      ? parseNumericValue(rawValue)
      : cleanString(rawValue)
  }
  return {
    codice_missione: (mapped.codice_missione as string | null) ?? null,
    missione: (mapped.missione as string | null) ?? null,
    // Prefer the year encoded in the package name: it is the year we chose,
    // and it cannot drift from the snapshot the row belongs to.
    anno: snapshot.anno,
    mese_contabile: MONTH_LABELS[snapshot.mese - 1] ?? null,
    mese_numero: snapshot.mese,
    periodo: snapshot.periodo,
    op_erario: (mapped.op_erario as number | null) ?? null,
    op_tesoreria: (mapped.op_tesoreria as number | null) ?? null,
    op_esterno: (mapped.op_esterno as number | null) ?? null,
    oa_tesoreria: (mapped.oa_tesoreria as number | null) ?? null,
    oa_spesa_deleg: (mapped.oa_spesa_deleg as number | null) ?? null,
    rsf_stipendi: (mapped.rsf_stipendi as number | null) ?? null,
    rsf_altro: (mapped.rsf_altro as number | null) ?? null,
    totale_pagato: (mapped.totale_pagato as number | null) ?? null,
    pacchetto: snapshot.packageName,
    fonte_url: snapshot.packageUrl,
  }
}

export interface ResolvedBDAPSnapshot {
  periodo: SpesaPeriodo
  anno: number
  mese: number
  csvUrl: string
  packageName: string
  packageUrl: string
  modified: string | null
}

function parseMonthlyName(name: string): { anno: number; mese: number } | null {
  const m = BDAP_MONTHLY_NAME_RE.exec(name)
  if (!m) return null
  const mese = MONTH_NUMBERS[m[1]!.toLowerCase()]
  const anno = Number.parseInt(m[2]!, 10)
  if (!mese || !Number.isFinite(anno)) return null
  return { anno, mese }
}

/**
 * Resolve the CSV dump URL of a package, re-fetching the full record when
 * the search response omitted the resources array.
 *
 * BDAP packages typically include three resources: the actual CSV
 * datastore dump, an XML alternate, and a methodology PDF that is
 * (incorrectly) tagged with format=CSV. Filter on URL shape too: the
 * canonical bulk download is always at /datastore/dump/<UUID>.csv.
 */
async function resolveCsvUrl(pkg: CkanPackage): Promise<string> {
  // package_show requires the UUID, not the slug -- pass `id`, not `name`.
  const full =
    Array.isArray(pkg.resources) && pkg.resources.length > 0
      ? pkg
      : await ckanPackageShow(BDAP_CKAN_BASE, pkg.id)
  const csv = full.resources.find((r) => {
    if ((r.format || '').toLowerCase() !== 'csv') return false
    if (!r.url) return false
    if (!/\.csv(\?|$)/i.test(r.url)) return false
    return /\/datastore\/dump\//i.test(r.url)
  })
  if (!csv) {
    throw new Error(
      `BDAP: package "${pkg.name}" has no datastore CSV resource (have: ` +
        full.resources.map((r) => `${r.format ?? '?'}=${r.url}`).join(', ') +
        ')',
    )
  }
  // Force HTTPS: port 80 on this host accepts connections but never responds.
  return csv.url.replace(/^http:/, 'https:')
}

/**
 * Choose which two packages to ingest, from the names alone.
 *
 * Selection is by the year and month encoded in the package *name*, never by
 * `metadata_modified`: BDAP re-touches old packages (the 2025 consuntivo was
 * modified 2026-07-13, after several 2026 monthlies were already out), so
 * publication order does not track accounting coverage. Sorting by
 * `metadata_modified` and taking the first is precisely the bug that put a
 * two-month figure on the page under a full-year caption.
 *
 * Pure and exported so the choice is unit-testable without touching CKAN.
 */
export function selectSnapshots<T extends { name: string }>(
  packages: readonly T[],
): { annuale: T & { anno: number; mese: number }; progressivo: (T & { anno: number; mese: number }) | null } {
  const candidates: Array<T & { anno: number; mese: number }> = []
  for (const pkg of packages) {
    const parsed = parseMonthlyName(pkg.name)
    if (parsed) candidates.push({ ...pkg, ...parsed })
  }
  if (candidates.length === 0) {
    throw new Error(
      'BDAP: no spd_<month>_spe_pbs_mis_01_<year>_01 package matched. ' +
        'Has the publisher renamed the series? Check the catalog directly.',
    )
  }

  candidates.sort((a, b) => b.anno - a.anno || b.mese - a.mese)

  const latest = candidates[0]!
  const december = candidates.find((c) => c.mese === 12)
  if (!december) {
    throw new Error(
      'BDAP: no December (spd_dic_...) package in the missione series, so no ' +
        'full-year total can be derived. Latest available coverage is ' +
        `${latest.anno}-${String(latest.mese).padStart(2, '0')}.`,
    )
  }
  return {
    annuale: december,
    progressivo: latest.name === december.name ? null : latest,
  }
}

/**
 * Resolve the two chosen packages down to downloadable snapshots, fetching
 * each one's CSV dump URL from CKAN.
 */
async function resolveSnapshots(): Promise<{
  annuale: ResolvedBDAPSnapshot
  progressivo: ResolvedBDAPSnapshot | null
}> {
  const pkgs = await ckanPackageSearchAll(
    BDAP_CKAN_BASE,
    '"Pagamenti Bilancio dello Stato per Missione"',
  )
  const chosen = selectSnapshots(pkgs)

  const toSnapshot = async (
    pkg: CkanPackage & { anno: number; mese: number },
    periodo: SpesaPeriodo,
  ): Promise<ResolvedBDAPSnapshot> => ({
    periodo,
    anno: pkg.anno,
    mese: pkg.mese,
    csvUrl: await resolveCsvUrl(pkg),
    packageName: pkg.name,
    packageUrl: `${BDAP_CATALOG_BASE}/${pkg.name}`,
    modified: pkg.metadata_modified ?? null,
  })

  return {
    annuale: await toSnapshot(chosen.annuale, 'annuale'),
    progressivo: chosen.progressivo
      ? await toSnapshot(chosen.progressivo, 'progressivo')
      : null,
  }
}

async function fetchCsv(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'fixitalia-ingest/0.1 (+https://github.com/TheR4iner/fixitalia)' },
  })
  if (!res.ok) {
    throw new Error(`BDAP download failed: HTTP ${res.status} ${res.statusText}`)
  }
  return await res.text()
}

/**
 * Parse one snapshot's CSV into records, refusing to return anything that
 * would render as a wrong number.
 *
 * The validation is the point of this function. A publisher-side header
 * rename used to flow all the way to the page as "0 EUR" with no error
 * anywhere, because three layers of tolerance stack up: an unknown header
 * yields `undefined`, `parseNumericValue(undefined)` yields `null`, and the
 * `option<T>` null-stripping drops the field. So we assert on the parsed
 * result instead of trusting the pipeline.
 */
export function parseSnapshot(
  csv: string,
  snapshot: ResolvedBDAPSnapshot,
): SpesaMissioneRecord[] {
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    delimiter: ';',
    relax_column_count: true,
  }) as Array<Record<string, string>>

  if (rows.length === 0) {
    throw new Error(`BDAP: package "${snapshot.packageName}" parsed to zero rows`)
  }

  const records = rows.map((row) => mapRow(row, snapshot))
  const withAmount = records.filter((r) => r.totale_pagato != null)
  if (withAmount.length === 0) {
    throw new Error(
      `BDAP: package "${snapshot.packageName}" produced ${records.length} rows but not ` +
        'one resolved a "Totale Pagato" amount. The upstream header set is ' +
        `[${Object.keys(rows[0]!).join(', ')}] -- update COLUMN_MAP.`,
    )
  }
  const total = withAmount.reduce((sum, r) => sum + (r.totale_pagato ?? 0), 0)
  if (!(total > 0)) {
    throw new Error(
      `BDAP: package "${snapshot.packageName}" summed to ${total}, which cannot be a ` +
        'valid payments total. Refusing to publish it.',
    )
  }
  if (!records.every((r) => r.codice_missione)) {
    throw new Error(
      `BDAP: package "${snapshot.packageName}" has rows without a "Codice Missione"; ` +
        'the mission rollup shape changed upstream.',
    )
  }
  // Not fatal: a mission with no payments yet is legitimately absent from an
  // early-year snapshot. Worth a line in the log so an unexpected drop in a
  // *December* snapshot is visible.
  if (records.length !== 34) {
    console.warn(
      `[ingest:spesa] "${snapshot.packageName}" has ${records.length} missioni, not the ` +
        'usual 34 (normal for early-year snapshots, suspicious for December).',
    )
  }
  console.log(
    `[ingest:spesa] ${snapshot.periodo}: ${snapshot.packageName} -> ${records.length} missioni, ` +
      `cumulato gen-${MONTH_LABELS[snapshot.mese - 1]} ${snapshot.anno} = ` +
      `${total.toLocaleString('it-IT', { maximumFractionDigits: 0 })} EUR`,
  )
  return records
}

export interface IngestResult {
  source: string
  rowsParsed: number
  rowsIngested: number
  durationMs: number
}

export async function ingestSpesaPubblica(): Promise<IngestResult> {
  const started = Date.now()
  console.log('[ingest:spesa] resolving BDAP missione snapshots via CKAN...')
  const { annuale, progressivo } = await resolveSnapshots()
  const snapshots = progressivo ? [annuale, progressivo] : [annuale]
  console.log(
    `[ingest:spesa] selected ${snapshots
      .map((s) => `${s.periodo}=${s.packageName}`)
      .join(', ')}`,
  )

  // Parse everything before touching the DB. A validation failure on the
  // second snapshot must not leave the table holding only the first one.
  const parsed: SpesaMissioneRecord[] = []
  for (const snapshot of snapshots) {
    const csv = await fetchCsv(snapshot.csvUrl)
    console.log(
      `[ingest:spesa] download ok for ${snapshot.packageName} (${csv.length} bytes)`,
    )
    parsed.push(...parseSnapshot(csv, snapshot))
  }

  // SurrealDB's `option<T>` means "absent or T", not "null or T", so null
  // fields have to be stripped rather than bound.
  const records = parsed.map(stripNulls)

  // Staged swap, not delete-then-insert: readers keep the previous snapshot
  // until the new one is complete. See lib/snapshotSwap.ts.
  const ingested = await swapSnapshots([{ table: 'spesa_missioni', rows: records }])

  const durationMs = Date.now() - started
  console.log(`[ingest:spesa] upserted ${ingested} rows in ${durationMs} ms`)

  return {
    source: annuale.csvUrl,
    rowsParsed: parsed.length,
    rowsIngested: ingested,
    durationMs,
  }
}
