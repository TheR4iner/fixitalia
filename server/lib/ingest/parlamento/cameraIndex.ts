import { Table } from 'surrealdb'

import { getDb } from '../../db.ts'
import { runQuery } from '../../query.ts'
import { fetchWithRetry } from './parseHelpers.ts'
import { parseItalianDate } from './cameraHistoricalIndex.ts'

// -----------------------------------------------------------------------------
// Camera dei Deputati -- session index pass.
//
// Goal: populate `parlamento_sedute` with one row per Camera assembly
// session, with metadata only (chamber, leg, numero, data, source URLs).
// The body pass (cameraSession.ts) then fills in OdG and interventi.
//
// Strategy: every Camera assembly session has a deterministic transcript URL:
//   https://documenti.camera.it/leg{N}/resoconti/assemblea/html/sed{NNNN}/stenografico.htm
// (The /xml/ variant exists but serves the same XHTML body; the /html/ form
// is the canonical one for leg19.) We probe seduta numbers sequentially
// (1..high) and read the head of the response to extract:
//   - the seduta date from `<meta name="date" content="YYYYMMDD" />`
//   - the seduta title from `<meta name="title" content="..." />`
// Probing concurrency is capped at 4 so the upstream is not hammered.
// -----------------------------------------------------------------------------

const HIGH_WATER_PROBE = 800 // upper bound -- legislatures rarely exceed ~700 sittings

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

function pad4(n: number): string {
  return String(n).padStart(4, '0')
}

function htmlUrl(leg: number, num: number): string {
  return `https://documenti.camera.it/leg${leg}/resoconti/assemblea/html/sed${pad4(num)}/stenografico.htm`
}

function sourceUrl(leg: number, num: number): string {
  return `https://www.camera.it/leg${leg}/410?idSeduta=${pad4(num)}&tipo=stenografico`
}

async function probeSession(leg: number, num: number): Promise<SedutaHeader | null> {
  const url = htmlUrl(leg, num)
  // 404 is a perfectly valid answer ("no such seduta yet") so we mark it
  // passthrough -- it must not trigger retry logic.
  const res = await fetchWithRetry(url, {
    timeoutMs: 15_000,
    attempts: 3,
    passthroughStatuses: [404],
  })
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`probe HTTP ${res.status} on ${url}`)
  }
  // We only need the first ~4KB to read the meta tags. Stream a few chunks
  // and stop once the head section is in.
  const reader = res.body?.getReader()
  if (!reader) {
    throw new Error('no response body for ' + url)
  }
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    for (let i = 0; i < 8; i += 1) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > 8000) break
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // ignore -- we got what we needed
    }
  }
  const titolo = parseHeaderTitle(buffer)
  // Primary: the numeric `<meta name="date" content="YYYYMMDD">`. Fallback: the
  // Italian descrittore in the title meta. The source occasionally ships a
  // malformed numeric date -- e.g. leg15 sed276 has content="2008220" (the
  // month "02" lost its leading zero -> 7 digits), which the strict \d{8} regex
  // rejects. The title ("... 20 febbraio 2008 ...") still carries the real date.
  let data = parseHeaderDate(buffer)
  if (!data && titolo) data = parseItalianDate(titolo)
  if (!data) {
    // The page EXISTS (200) but no date could be parsed. Make it LOUD: a silent
    // null here is how leg15 sed276 went missing for months.
    console.warn(
      `[ingest:parlamento:camera-index] sed ${num} exists (200) but date UNPARSEABLE -- dropped; extend the date parser: ${url}`,
    )
    return null
  }
  return {
    numero: num,
    data,
    titolo,
    source_url: sourceUrl(leg, num),
    html_url: url,
  }
}

// Camera leg19 transcripts ship with `<meta name="date" content="YYYYMMDD" />`
// in the XHTML head. Older legislatures occasionally used `<meta name="date"
// content="DD/MM/YYYY" />`, so we match both vintages.
const DATE_META_RE = /<meta\s+name="date"\s+content="(\d{8})"/i
const DATE_META_RE_ALT = /<meta\s+name="date"\s+content="(\d{2})\/(\d{2})\/(\d{4})"/i
// The `title` meta carries the full descrittore (e.g. "Camera dei Deputati ... -
// Seduta n. 10 di mercoledì 16 novembre 2022 - Resoconto stenografico").
const TITLE_META_RE = /<meta\s+name="title"\s+content="([^"]+)"/i

function parseHeaderDate(htmlChunk: string): Date | null {
  const m = htmlChunk.match(DATE_META_RE)
  if (m) {
    const ymd = m[1]
    return new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`)
  }
  const alt = htmlChunk.match(DATE_META_RE_ALT)
  if (alt) return new Date(`${alt[3]}-${alt[2]}-${alt[1]}T00:00:00Z`)
  return null
}

function parseHeaderTitle(htmlChunk: string): string | null {
  const m = htmlChunk.match(TITLE_META_RE)
  if (!m) return null
  // The descrittore is a long sentence; grab just the "Seduta n. X di ..."
  // portion when present, otherwise return the whole thing.
  const seduta = m[1].match(/Seduta n\.[^-]*-\s*Resoconto/i)
  return seduta ? seduta[0].replace(/\s*-\s*Resoconto$/i, '').trim() : m[1].trim()
}

/**
 * Enumerate Camera sessions for one legislatura. Idempotent: existing
 * rows are left in place; we only insert sedute we have not seen.
 *
 * The probe walks 1..HIGH_WATER_PROBE sequentially. On the first run
 * for a legislature this is ~600-800 HEAD-ish requests; the per-request
 * latency is small but we cap concurrency at 4 to stay polite.
 */
export async function ingestCameraIndex(
  legislatura: number = 19,
  options: { from?: number; to?: number } = {},
): Promise<IndexResult> {
  const started = Date.now()
  const lo = options.from ?? 1
  const hi = options.to ?? HIGH_WATER_PROBE

  // Fetch the set of (numero) we already have so we skip re-probing.
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
    `[ingest:parlamento:camera-index] leg=${legislatura} probing ${candidates.length} candidates (${seen.size} already known)`,
  )

  const CONCURRENCY = 4
  const headers: SedutaHeader[] = []
  let consecutive404 = 0
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (n) => {
        try {
          return await probeSession(legislatura, n)
        } catch (err) {
          console.warn(`[ingest:parlamento:camera-index] probe ${n} failed:`, err)
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
    // If we hit a long stretch of misses past the lowest known seduta, stop.
    if (consecutive404 >= 40 && headers.length > 0) {
      console.log(
        `[ingest:parlamento:camera-index] hit ${consecutive404} consecutive 404s, stopping early at numero=${batch.at(-1)}`,
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
          `[ingest:parlamento:camera-index] batch ${i / BATCH_SIZE + 1} insert failed (${batch.length} rows skipped):`,
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  // Record the index run. Best-effort: a checkpoint write that fails
  // doesn't justify aborting the body pass. We log and continue.
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
      '[ingest:parlamento:camera-index] checkpoint write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:camera-index] inserted ${actuallyInserted}/${rows.length} new sedute in ${durationMs} ms`,
  )

  return {
    chamber: 'camera',
    legislatura,
    rowsSeen: candidates.length,
    rowsInserted: actuallyInserted,
    durationMs,
  }
}
