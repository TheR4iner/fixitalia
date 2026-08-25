import { parseHTML } from 'linkedom'
import { RecordId } from 'surrealdb'

import { runQuery } from '../../query.ts'
import { cleanString, stripNulls } from '../../parse.ts'
import { fetchWithRetry, slugify } from './parseHelpers.ts'

// -----------------------------------------------------------------------------
// Camera dei Deputati -- committee stenographic transcripts, index pass.
//
// Camera exposes one chronological listing per month:
//
//   documenti.camera.it/apps/commonServices/getDocumento.ashx
//     ?idLegislatura={leg}&sezione=commissioni&tipoDoc=elencoResoconti
//     &annoMese={YYYYMM}&view=filtered&tipoElenco=sediCronologico
//
// It needs no cookie and no browser (unlike Senato), and it is richly
// structured -- for every sitting it carries the committee name, the date, the
// sitting title, the resoconto number, and the parameters needed to build the
// transcript URL. So the index pass is a pure parse of ~1 request per month.
//
// The listing markup nests as:
//   div#sede.{tipologia} > strong.titoloTipologiaStenografico   (kind label)
//     ul.commissioni > li.commissione > strong                  (committee name)
//       ul.sedute > li
//         span.dataSeduta                                       (Italian date)
//         ul.titoliResocontoStenografico > li                   (sitting title)
//         ul.stenograficoList > li
//           span.testo "Resoconto stenografico num. 16"
//           a[href*="tipoDoc=stenografico&"]                     (the document)
//
// From that anchor's query string we take idCommissione, tipologia,
// sottotipologia, anno/mese/giorno and numero, which compose the static
// transcript URL that the body pass fetches:
//
//   documenti.camera.it/leg{leg}/resoconti/commissioni/stenografici/html
//     /{idCommissione}/{tipologia}[/{sottotipologia}]/{YYYY}/{MM}/{DD}
//     /stenografico.{NNNN}.html
//
// Note the sottotipologia segment is ABSENT for tipologia=altro. Getting that
// wrong yields a clean 404 rather than a wrong document, which is why the body
// pass treats 404 as a hard error worth reporting.
//
// COVERAGE LIMIT: this service only answers for legislatures 17, 18 and 19.
// Legs 13-16 return a ~15KB stub with no sittings. See
// project-kb/Parlamento commissioni.md.
// -----------------------------------------------------------------------------

/** Legislatures for which the committee transcript service returns real data. */
export const CAMERA_COMMISSIONI_LEGS = [17, 18, 19] as const

const BASE = 'https://documenti.camera.it/apps/commonServices/getDocumento.ashx'

const MONTHS_IT: Record<string, number> = {
  gennaio: 1,
  febbraio: 2,
  marzo: 3,
  aprile: 4,
  maggio: 5,
  giugno: 6,
  luglio: 7,
  agosto: 8,
  settembre: 9,
  ottobre: 10,
  novembre: 11,
  dicembre: 12,
}

export interface CameraCommissioneEntry {
  idCommissione: string
  commissioneNome: string
  tipologia: string
  sottotipologia: string | null
  numero: number
  data: Date
  titolo: string | null
  tipoSeduta: string | null
  htmlUrl: string
  sourceUrl: string
}

interface IndexResult {
  chamber: 'camera'
  legislatura: number
  monthsScanned: number
  rowsSeen: number
  rowsInserted: number
  durationMs: number
}

function listingUrl(leg: number, annoMese: string): string {
  return (
    `${BASE}?idLegislatura=${leg}&sezione=commissioni&tipoDoc=elencoResoconti` +
    `&annoMese=${annoMese}&breve=&view=filtered&idCommissione=&tipoElenco=sediCronologico`
  )
}

/** The reader-facing Camera page for one month's committee transcripts. */
function monthSourceUrl(leg: number, annoMese: string): string {
  return `https://www.camera.it/leg${leg}/471?annoMese=${annoMese}&tipoElenco=sediCronologico`
}

/**
 * Build the static transcript URL. `sottotipologia` is omitted from the path
 * when the source omits it (tipologia=altro), which is the single irregularity
 * in an otherwise fully deterministic scheme.
 */
export function cameraCommissioneHtmlUrl(
  leg: number,
  e: Pick<
    CameraCommissioneEntry,
    'idCommissione' | 'tipologia' | 'sottotipologia' | 'data' | 'numero'
  >,
): string {
  const yyyy = e.data.getUTCFullYear()
  const mm = String(e.data.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(e.data.getUTCDate()).padStart(2, '0')
  const sotto = e.sottotipologia ? `/${e.sottotipologia}` : ''
  const num = String(e.numero).padStart(4, '0')
  return (
    `https://documenti.camera.it/leg${leg}/resoconti/commissioni/stenografici/html` +
    `/${e.idCommissione}/${e.tipologia}${sotto}/${yyyy}/${mm}/${dd}/stenografico.${num}.html`
  )
}

/**
 * Deterministic, collision-free token for one committee sitting.
 *
 * Keyed on (leg, committee, tipologia, sottotipologia, numero) because that is
 * the tuple the upstream numbering is unique within: committee 03 ran both
 * `indag/c03_commercio` num. 6 and `indag/c03_discriminazioni` num. 16 in the
 * same month, so numero alone -- or even numero plus committee -- collides.
 */
export function cameraCommissioneScope(
  leg: number,
  e: Pick<CameraCommissioneEntry, 'idCommissione' | 'tipologia' | 'sottotipologia' | 'numero'>,
): string {
  const sotto = e.sottotipologia ? slugify(e.sottotipologia) : 'none'
  return `cc-${leg}-${e.idCommissione}-${slugify(e.tipologia)}-${sotto}-${e.numero}`
}

function parseItalianDate(raw: string): Date | null {
  const m = raw.toLowerCase().match(/(\d{1,2})\s+(\p{L}+)\s+(\d{4})/u)
  if (!m) return null
  const day = Number(m[1])
  const month = MONTHS_IT[m[2]]
  const year = Number(m[3])
  if (!month || !day || !year) return null
  return new Date(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00Z`,
  )
}

function queryParam(href: string, key: string): string | null {
  // Accept '&', '?' or the ';' that ends an HTML-escaped '&amp;', and stop at
  // any of the same. linkedom decodes entities in attribute values so hrefs
  // read here are usually already unescaped, but the raw-string callers above
  // are not, and one regex that handles both is cheaper than remembering which
  // is which.
  const m = href.match(new RegExp(`[?&;]${key}=([^&;"]*)`, 'i'))
  if (!m) return null
  const v = decodeURIComponent(m[1])
  return v === '' ? null : v
}

async function fetchListing(url: string): Promise<string> {
  const res = await fetchWithRetry(url, { timeoutMs: 45_000, attempts: 3 })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`committee listing fetch failed: HTTP ${res.status} on ${url}`)
  }
  return await res.text()
}

/**
 * Read the month picker embedded in any listing page to learn exactly which
 * months this legislature published. Beats iterating a guessed date range:
 * it costs one request and cannot drift when a legislature ends early.
 */
export async function listCameraCommissioniMonths(leg: number): Promise<string[]> {
  // The seed request MUST leave annoMese empty. A syntactically valid but
  // non-existent month (000000 was the obvious guess) makes the service render
  // an error shell with no month picker at all, so discovery silently returns
  // zero months and the whole legislature looks empty. An empty annoMese makes
  // it render its default view, picker included.
  const html = await fetchListing(listingUrl(leg, ''))
  const months = new Set<string>()
  // NOT /[?&]annoMese=/: the picker's hrefs are HTML-escaped, so the character
  // before the parameter is the ';' of '&amp;', never a bare '&'. Requiring a
  // query separator matched nothing and made every legislature look empty.
  for (const m of html.matchAll(/annoMese=(\d{6})/g)) months.add(m[1])
  const sorted = [...months].sort()
  if (sorted.length === 0) {
    // Loud, because "no months" and "legislature not covered upstream" look
    // identical from the outside and only one of them is a bug.
    console.warn(
      `[ingest:parlamento:camera-commissioni-index] leg=${leg} month picker was EMPTY -- ` +
        `either the legislature is outside the service's coverage or the listing markup changed`,
    )
  }
  return sorted
}

/** Parse one monthly listing page into entries. */
export function parseCameraCommissioniListing(
  leg: number,
  html: string,
): CameraCommissioneEntry[] {
  const { document } = parseHTML(html)
  const entries: CameraCommissioneEntry[] = []

  for (const li of Array.from(document.querySelectorAll('li.commissione'))) {
    const commissioneNome =
      cleanString(li.querySelector('strong')?.textContent ?? '') ?? ''

    for (const seduta of Array.from(li.querySelectorAll('ul.sedute > li'))) {
      const dataRaw = cleanString(seduta.querySelector('.dataSeduta')?.textContent ?? '') ?? ''
      const data = parseItalianDate(dataRaw)
      const titolo =
        cleanString(
          seduta.querySelector('.titoloResocontoStenografico')?.textContent ?? '',
        ) || null

      for (const item of Array.from(seduta.querySelectorAll('ul.stenograficoList > li'))) {
        const anchor = item.querySelector('a[href*="tipoDoc=stenografico&"]')
        const href = anchor?.getAttribute('href') ?? ''
        if (!href) continue

        const idCommissione = queryParam(href, 'idCommissione')
        const tipologia = queryParam(href, 'tipologia')
        const numeroRaw = queryParam(href, 'numero')
        if (!idCommissione || !tipologia || !numeroRaw) continue
        const numero = Number(numeroRaw)
        if (!Number.isFinite(numero)) continue

        // Prefer the date carried by the link itself over the rendered
        // Italian one: it is already numeric and cannot be tripped up by an
        // unexpected month spelling.
        const anno = queryParam(href, 'anno')
        const mese = queryParam(href, 'mese')
        const giorno = queryParam(href, 'giorno')
        const linkDate =
          anno && mese && giorno
            ? new Date(`${anno}-${mese.padStart(2, '0')}-${giorno.padStart(2, '0')}T00:00:00Z`)
            : null
        const effectiveDate = linkDate ?? data
        if (!effectiveDate || Number.isNaN(effectiveDate.getTime())) {
          // Loud, not silent: a sitting we can see but cannot date is a
          // parser gap, and the assembly ingest learned the hard way that a
          // quiet `continue` here hides missing sedute for months.
          console.warn(
            `[ingest:parlamento:camera-commissioni-index] leg=${leg} undatable entry, dropped: ${href}`,
          )
          continue
        }

        const tipoSeduta =
          cleanString(item.querySelector('.tipoSeduta')?.textContent ?? '')?.replace(
            /^[\s-]+/,
            '',
          ) || null

        const entry: CameraCommissioneEntry = {
          idCommissione,
          commissioneNome,
          tipologia,
          sottotipologia: queryParam(href, 'sottotipologia'),
          numero,
          data: effectiveDate,
          titolo,
          tipoSeduta,
          htmlUrl: '',
          sourceUrl: '',
        }
        entry.htmlUrl = cameraCommissioneHtmlUrl(leg, entry)
        entry.sourceUrl = href.startsWith('//') ? `https:${href}` : href
        entries.push(entry)
      }
    }
  }
  return entries
}

/**
 * Enumerate Camera committee sittings for one legislature and upsert
 * metadata-only rows into parlamento_sedute.
 *
 * Idempotent by construction: every row carries a deterministic record id, so
 * re-running the index pass overwrites metadata in place and never duplicates.
 * The body pass is what fills in the transcript, and it skips anything already
 * marked ok.
 */
export async function ingestCameraCommissioniIndex(
  legislatura: number,
  options: { months?: string[] } = {},
): Promise<IndexResult> {
  const started = Date.now()

  if (!(CAMERA_COMMISSIONI_LEGS as readonly number[]).includes(legislatura)) {
    console.warn(
      `[ingest:parlamento:camera-commissioni-index] leg=${legislatura} is outside the ` +
        `service's coverage (${CAMERA_COMMISSIONI_LEGS.join(', ')}) -- nothing to do`,
    )
    return {
      chamber: 'camera',
      legislatura,
      monthsScanned: 0,
      rowsSeen: 0,
      rowsInserted: 0,
      durationMs: Date.now() - started,
    }
  }

  const months = options.months ?? (await listCameraCommissioniMonths(legislatura))
  console.log(
    `[ingest:parlamento:camera-commissioni-index] leg=${legislatura} scanning ${months.length} months`,
  )

  const all: CameraCommissioneEntry[] = []
  for (const annoMese of months) {
    try {
      const html = await fetchListing(listingUrl(legislatura, annoMese))
      const entries = parseCameraCommissioniListing(legislatura, html)
      all.push(...entries)
      if (entries.length > 0) {
        console.log(
          `[ingest:parlamento:camera-commissioni-index] ${annoMese}: ${entries.length} sittings`,
        )
      }
    } catch (err) {
      // One unreachable month must not abort the legislature: the run is
      // resumable and the next pass will pick the month back up.
      console.warn(
        `[ingest:parlamento:camera-commissioni-index] ${annoMese} failed (continuing):`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // De-duplicate within the run. The same sitting can legitimately be listed
  // under more than one month page when a sitting straddles midnight.
  const byScope = new Map<string, CameraCommissioneEntry>()
  for (const e of all) byScope.set(cameraCommissioneScope(legislatura, e), e)

  // stripNulls is not cosmetic: SurrealDB's option<T> REJECTS an explicitly
  // bound null (it accepts a missing key or NONE, never null), so a sitting
  // with no sottotipologia -- every tipologia=altro one -- fails the whole
  // write with "Found NULL for field ... but expected a option<string>".
  // Omitting the key also means MERGE leaves any existing value alone, which
  // is correct here because the scope encodes these fields: a given scope's
  // tipologia never changes.
  const docs = [...byScope.entries()].map(([scope, e]) => ({
    id: new RecordId('parlamento_sedute', scope),
    doc: stripNulls({
      chamber: 'camera',
      legislatura,
      numero: e.numero,
      data: e.data,
      titolo: e.titolo,
      source_url: monthSourceUrl(
        legislatura,
        `${e.data.getUTCFullYear()}${String(e.data.getUTCMonth() + 1).padStart(2, '0')}`,
      ),
      html_url: e.htmlUrl,
      organo: 'commissione',
      organo_cod: e.idCommissione,
      organo_nome: e.commissioneNome,
      organo_slug: `camera-${e.idCommissione}`,
      tipo_resoconto: 'stenografico',
      tipologia: e.tipologia,
      sottotipologia: e.sottotipologia,
    }),
  }))

  // UPSERT ... MERGE rather than INSERT, because the index pass re-runs every
  // time we look for new sittings and must refresh metadata on rows that
  // already exist. MERGE (not CONTENT) is the load-bearing part: CONTENT
  // replaces the whole record and would wipe body_status, silently queueing
  // every already-ingested sitting for a full re-fetch.
  let inserted = 0
  const BATCH = 200
  for (let i = 0; i < docs.length; i += BATCH) {
    const slice = docs.slice(i, i + BATCH)
    try {
      await runQuery(`FOR $r IN $rows { UPSERT $r.id MERGE $r.doc; };`, { rows: slice })
      inserted += slice.length
    } catch (err) {
      console.warn(
        `[ingest:parlamento:camera-commissioni-index] batch ${i / BATCH + 1} failed; per-row fallback:`,
        err instanceof Error ? err.message : err,
      )
      for (const r of slice) {
        try {
          await runQuery(`UPSERT $id MERGE $doc;`, { id: r.id, doc: r.doc })
          inserted += 1
        } catch (rowErr) {
          console.warn(
            `[ingest:parlamento:camera-commissioni-index] upsert failed for ${String(r.id)}:`,
            rowErr instanceof Error ? rowErr.message : rowErr,
          )
        }
      }
    }
  }

  // Queue newly-discovered sittings for the body pass. Done as one statement
  // after the fact rather than inside the UPSERT so an existing row's status
  // (ok / partial / error) is never touched.
  try {
    await runQuery(
      `UPDATE parlamento_sedute SET body_status = "pending"
       WHERE organo = "commissione" AND chamber = "camera"
         AND legislatura = $leg AND body_status IS NONE;`,
      { leg: legislatura },
    )
  } catch (err) {
    console.warn(
      '[ingest:parlamento:camera-commissioni-index] could not queue pending sittings:',
      err instanceof Error ? err.message : err,
    )
  }

  try {
    await runQuery(
      `UPSERT parlamento_ingest_state
       SET chamber = $chamber, legislatura = $leg,
           index_run_at = time::now(), updated_at = time::now()
       WHERE chamber = $chamber AND legislatura = $leg;`,
      { chamber: 'camera-commissioni', leg: legislatura },
    )
  } catch (err) {
    console.warn(
      '[ingest:parlamento:camera-commissioni-index] checkpoint write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:camera-commissioni-index] leg=${legislatura} upserted ${inserted}/${docs.length} sittings from ${months.length} months in ${durationMs} ms`,
  )

  return {
    chamber: 'camera',
    legislatura,
    monthsScanned: months.length,
    rowsSeen: docs.length,
    rowsInserted: inserted,
    durationMs,
  }
}
