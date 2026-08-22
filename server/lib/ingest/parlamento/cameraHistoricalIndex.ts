import { Table } from 'surrealdb'

import { getDb } from '../../db.ts'
import { runQuery } from '../../query.ts'
import { fetchWithRetry } from './parseHelpers.ts'

// -----------------------------------------------------------------------------
// Camera dei Deputati -- session index pass for legs 13-14.
//
// The leg-19 cameraIndex.ts probe checks documenti.camera.it/leg{N}/ for
// XML transcripts that don't exist for legs 13-14. Those legs publish
// HTML transcripts on per-legislature subdomains instead:
//
//   https://leg{N}.camera.it/_dati/leg{N}/lavori/stenografici/sed{NUM}/
//
// Probe `sed{NUM}/s000r.htm` (the FRAMESET wrapper) for existence, then
// fetch `s000.htm` (the inner index page) to read the session date from
// its title and centered heading.
//
// For leg 14 we point `html_url` at `sintero.htm` (a single-file
// aggregation of the full transcript). For leg 13 we point at `s000.htm`
// (the chunked index) and let the body parser walk `s010.htm`,
// `s020.htm`, ... from there. The body parser (cameraHistoricalSession.ts)
// inspects the URL to decide which fetch strategy to use.
// -----------------------------------------------------------------------------

const HIGH_WATER_PROBE = 800

interface IndexResult {
  chamber: 'camera'
  legislatura: number
  rowsSeen: number
  rowsInserted: number
  durationMs: number
}

interface SedutaHeader {
  numero: number
  data: Date
  titolo: string | null
  source_url: string
  html_url: string
}

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

// Both "21 novembre 1996" and "21novembre 1996" (leg-13 title has the
// typo) must parse. Tolerate optional whitespace between the day and the
// month name.
//
// First-of-month sessions write the day as an ordinal: "1° aprile 1997"
// ("primo aprile"). The pages are Latin-1, so the `°` (0xB0) often arrives
// as the U+FFFD replacement char ("1� aprile"). Without tolerating that
// ordinal/garbage glyph between the day and the month, every "1°" session
// failed to parse its date and was SILENTLY DROPPED from the index -- the
// root cause of the leg 13/14 numero gaps. Allow an optional run of ordinal
// markers (°, º, ª, replacement char) between the day digits and the month.
const ITALIAN_DATE_RE = /(\d{1,2})\s*[°ºª�]*\s*([a-zà-ù]+)\s+(\d{4})/i

export function parseItalianDate(s: string): Date | null {
  const decoded = s
    .replace(/&egrave;/gi, 'è')
    .replace(/&agrave;/gi, 'à')
    .replace(/&igrave;/gi, 'ì')
    .replace(/&ograve;/gi, 'ò')
    .replace(/&ugrave;/gi, 'ù')
  const m = decoded.toLowerCase().match(ITALIAN_DATE_RE)
  if (!m) return null
  const day = Number(m[1])
  const month = MONTHS_IT[m[2]]
  const year = Number(m[3])
  if (!month || !day || !year) return null
  const dd = String(day).padStart(2, '0')
  const mm = String(month).padStart(2, '0')
  return new Date(`${year}-${mm}-${dd}T00:00:00Z`)
}

// The _dati session directory is zero-padded to THREE digits: sed001, sed099,
// sed100, sed800. The original builder used the raw number (`sed${num}`), which
// is correct for 100+ (already 3 digits) but produced sed1..sed99 for the first
// 99 sessions -> all 404 -> sessions 1-99 of legs 13 and 14 were silently
// missed. padStart(3) is a no-op for 3+ digit numbers, so existing 100+ rows
// are unaffected. (Verified upstream: sed050 -> "Sed. 050 di ... 1996".)
function sedDir(num: number): string {
  return `sed${String(num).padStart(3, '0')}`
}

function baseUrl(leg: number, num: number): string {
  return `https://leg${leg}.camera.it/_dati/leg${leg}/lavori/stenografici/${sedDir(num)}/`
}

function sourceUrl(leg: number, num: number): string {
  // The web-facing browse URL goes through `chiosco.asp`, which wraps the
  // transcript in the per-leg site chrome. We store it on each seduta so
  // the UI can deep-link to camera.it instead of the bare _dati URL.
  return `${baseUrl(leg, num)}s000r.htm`
}

function transcriptUrl(leg: number, num: number): string {
  return leg === 14 ? `${baseUrl(leg, num)}sintero.htm` : `${baseUrl(leg, num)}s000.htm`
}

async function probeSession(leg: number, num: number): Promise<SedutaHeader | null> {
  // Step 1: cheap existence probe on the frameset wrapper.
  const wrapperUrl = `${baseUrl(leg, num)}s000r.htm`
  const wrapper = await fetchWithRetry(wrapperUrl, {
    timeoutMs: 15_000,
    attempts: 3,
    passthroughStatuses: [404],
  })
  if (wrapper.status === 404) {
    await wrapper.body?.cancel().catch(() => {})
    return null
  }
  if (!wrapper.ok) {
    await wrapper.body?.cancel().catch(() => {})
    throw new Error(`probe HTTP ${wrapper.status} on ${wrapperUrl}`)
  }
  await wrapper.body?.cancel().catch(() => {})

  // Step 2: fetch the inner index page for the date and title.
  const innerUrl = `${baseUrl(leg, num)}s000.htm`
  const inner = await fetchWithRetry(innerUrl, {
    timeoutMs: 15_000,
    attempts: 3,
    passthroughStatuses: [404],
  })
  if (!inner.ok) {
    await inner.body?.cancel().catch(() => {})
    return null
  }
  const html = await inner.text()
  const data = parseDateFromIndex(html)
  if (!data) {
    // The page EXISTS (200) but we couldn't parse its date. Returning null
    // here drops a real session -- make it LOUD so it can never be silently
    // missing again (vs. a genuine 404, which is handled above).
    console.warn(
      `[ingest:parlamento:camera-historical-index] sed ${num} exists but DATE UNPARSEABLE -- dropped; extend the date parser: ${innerUrl}`,
    )
    return null
  }
  return {
    numero: num,
    data,
    titolo: parseTitleFromIndex(html, num),
    source_url: sourceUrl(leg, num),
    html_url: transcriptUrl(leg, num),
  }
}

// The session title appears in `<TITLE>Sed. N ...</TITLE>` and again in a
// `<CENTER>Seduta n. N di ...</CENTER>` block. The body version is more
// reliably space-formatted; fall back to the title for very old pages
// that lack the centered heading.
function parseDateFromIndex(html: string): Date | null {
  const center = html.match(/<CENTER>\s*Seduta[^<]*<\/CENTER>/i)?.[0]
  if (center) {
    const d = parseItalianDate(center)
    if (d) return d
  }
  const title = html.match(/<TITLE>([^<]+)<\/TITLE>/i)?.[1]
  if (title) {
    const d = parseItalianDate(title)
    if (d) return d
  }
  return null
}

function parseTitleFromIndex(html: string, numero: number): string {
  const center = html.match(/<CENTER>\s*(Seduta[^<]*?)\s*<\/CENTER>/i)?.[1]
  if (center) return center.replace(/&[a-z]+;/gi, '').replace(/\s+/g, ' ').trim()
  return `Seduta n. ${numero}`
}

export async function ingestCameraHistoricalIndex(
  legislatura: 13 | 14,
  options: { from?: number; to?: number } = {},
): Promise<IndexResult> {
  const started = Date.now()
  const lo = options.from ?? 1
  const hi = options.to ?? HIGH_WATER_PROBE

  const existing = (await runQuery<Array<{ numero: number }>>(
    `SELECT numero FROM parlamento_sedute WHERE chamber = "camera" AND legislatura = $leg;`,
    { leg: legislatura },
  )) ?? []
  const seen = new Set(existing.map((r) => r.numero))

  const candidates = [] as number[]
  for (let n = lo; n <= hi; n += 1) {
    if (!seen.has(n)) candidates.push(n)
  }

  console.log(
    `[ingest:parlamento:camera-historical-index] leg=${legislatura} probing ${candidates.length} candidates (${seen.size} already known)`,
  )

  // Lower concurrency than the leg-19 path: per-leg subdomains run on
  // older infrastructure and we're polite by default. Each probe is two
  // HTTP requests (frameset + inner page), so net QPS is roughly 1 of
  // each per worker.
  const CONCURRENCY = 2
  const headers: SedutaHeader[] = []
  let consecutive404 = 0
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (n) => {
        try {
          return await probeSession(legislatura, n)
        } catch (err) {
          console.warn(
            `[ingest:parlamento:camera-historical-index] probe ${n} failed:`,
            err instanceof Error ? err.message : err,
          )
          return null
        }
      }),
    )
    for (const r of results) {
      if (r) {
        headers.push(r)
        consecutive404 = 0
      } else {
        consecutive404 += 1
      }
    }
    if (consecutive404 >= 40 && headers.length > 0) {
      console.log(
        `[ingest:parlamento:camera-historical-index] hit ${consecutive404} consecutive 404s, stopping early at numero=${batch.at(-1)}`,
      )
      break
    }
  }

  const db = await getDb()
  const table = new Table('parlamento_sedute')
  const rows = headers.map((h) => ({
    chamber: 'camera' as const,
    legislatura,
    numero: h.numero,
    data: h.data,
    titolo: h.titolo,
    source_url: h.source_url,
    html_url: h.html_url,
    body_status: 'pending',
  }))

  let actuallyInserted = 0
  if (rows.length > 0) {
    const BATCH_SIZE = 500
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      try {
        await db.insert(table, batch)
        actuallyInserted += batch.length
      } catch (err) {
        console.error(
          `[ingest:parlamento:camera-historical-index] batch ${i / BATCH_SIZE + 1} insert failed (${batch.length} rows skipped):`,
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  try {
    await runQuery(
      `UPSERT parlamento_ingest_state
       SET chamber = $chamber, legislatura = $leg,
           index_run_at = time::now(), updated_at = time::now()
       WHERE chamber = $chamber AND legislatura = $leg;`,
      { chamber: 'camera', leg: legislatura },
    )
  } catch (err) {
    console.warn(
      '[ingest:parlamento:camera-historical-index] checkpoint write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:camera-historical-index] inserted ${actuallyInserted}/${rows.length} new sedute in ${durationMs} ms`,
  )

  return {
    chamber: 'camera',
    legislatura,
    rowsSeen: candidates.length,
    rowsInserted: actuallyInserted,
    durationMs,
  }
}
