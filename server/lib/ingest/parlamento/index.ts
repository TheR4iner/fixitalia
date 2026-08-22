import type { BrowserContext } from 'playwright'

import { runQuery } from '../../query.ts'
import { ingestCameraIndex } from './cameraIndex.ts'
import { ingestCameraSession } from './cameraSession.ts'
import { ingestCameraDeputati } from './cameraDeputatiBulk.ts'
import { ingestCameraHistoricalIndex } from './cameraHistoricalIndex.ts'
import { ingestCameraHistoricalSession } from './cameraHistoricalSession.ts'
import { openSenatoBrowser, SenatoBlockError } from './senatoBrowser.ts'
import { ingestSenatoIndex } from './senatoIndex.ts'
import { ingestSenatoSession } from './senatoSession.ts'
import { ingestSenatoSenatori } from './senatoSenatoriBulk.ts'

// Legs whose Camera transcripts live on the leg-N subdomain in 1996-era
// HTML rather than documenti.camera.it XML. Add new entries as new
// historical legs come online (none expected; this is a fixed set).
const CAMERA_HISTORICAL_HTML_LEGS = new Set([13, 14])

function isCameraHistoricalHtml(leg: number): leg is 13 | 14 {
  return CAMERA_HISTORICAL_HTML_LEGS.has(leg)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A cheap DB liveness probe. The body pass uses it to distinguish "this seduta
// genuinely failed" from "the DB is momentarily down" (e.g. a SurrealDB
// OOM-restart on a write-heavy leg). The latter must NOT burn through the queue
// marking every seduta error: when the DB is unreachable, the first per-seduta
// query fails instantly, so without this guard a ~5s restart window torches
// dozens of sedute. Instead we pause and retry the same seduta.
async function dbHealthy(): Promise<boolean> {
  try {
    await runQuery('RETURN 1;')
    return true
  } catch {
    return false
  }
}

// Block until the DB answers again (e.g. after SurrealDB finishes reopening
// rocksdb), or give up after ~10 min so a truly-dead DB doesn't hang forever.
async function waitForDb(): Promise<boolean> {
  for (let i = 0; i < 120; i += 1) {
    if (await dbHealthy()) return true
    if (i === 0) console.warn('[ingest:parlamento] DB unreachable -- pausing body pass until it recovers...')
    await sleep(5_000)
  }
  return false
}

// Max times we will pause-and-retry a single seduta for DB recovery before
// giving up and recording it as an error (so one wedged seduta can't loop).
const MAX_DB_RECOVERY_RETRIES = 12

// -----------------------------------------------------------------------------
// Top-level orchestrator. Two phases per chamber:
//   1. Index pass: enumerate sedute and upsert metadata-only rows.
//   2. Body pass: for every seduta whose body_status != "ok", fetch and
//      parse the transcript, populating parlamento_odg + parlamento_interventi.
//
// The body pass is idempotent and resumable: a seduta that completed
// previously is skipped on the next run. The CLI can also bound the
// run with --limit so an operator can do a smoke test before kicking
// off the full multi-hour ingest.
// -----------------------------------------------------------------------------

export type Chamber = 'camera' | 'senato'

export interface IngestParlamentoOptions {
  chamber: Chamber | 'both'
  legislatura?: number
  limit?: number
  resume?: boolean
  /** Re-run the body pass even for sedute marked ok. */
  refresh?: boolean
  /** Probe range for the Camera index. */
  fromNumero?: number
  toNumero?: number
}

export interface IngestParlamentoResult {
  chamber: Chamber
  legislatura: number
  indexInserted: number
  bodyAttempted: number
  bodyOk: number
  bodyPartial: number
  bodyEmpty: number
  bodyError: number
  durationMs: number
  /**
   * False when the pass could not run to completion (index pass threw, the
   * browser would not launch, the DB was unreachable, ...).
   *
   * This exists because every failure path used to return an all-zero result,
   * which is byte-identical to the healthy "nothing new upstream" result. The
   * scheduler then logged `index +0, body ok=0 ... (0.0s)` for both, so a
   * month of failed ingests looked exactly like a month of quiet recess. See
   * project-kb/Parlamento ingest reliability.md.
   */
  ok: boolean
  /** Why the pass failed, when ok is false. */
  error?: string
}

interface PendingSeduta {
  numero: number
  body_status?: string
}

async function listPending(
  chamber: Chamber,
  legislatura: number,
  refresh: boolean,
): Promise<PendingSeduta[]> {
  // Non-refresh mode skips sedute that finished cleanly. Note that
  // `body_status = "ingesting"` is the recovery flag for crashed body-pass
  // runs (see project-kb/Parlamento body-pass atomicity.md) and is picked up
  // here transparently since it isn't "ok".
  const filter = refresh
    ? `chamber = $chamber AND legislatura = $leg`
    : `chamber = $chamber AND legislatura = $leg AND body_status != "ok"`
  const rows = await runQuery<PendingSeduta[]>(
    `SELECT numero, body_status FROM parlamento_sedute
     WHERE ${filter}
     ORDER BY numero ASC;`,
    { chamber, leg: legislatura },
  )
  return rows ?? []
}

async function runIndex(
  chamber: Chamber,
  legislatura: number,
  opts: IngestParlamentoOptions,
  browserContext: BrowserContext | null,
) {
  if (chamber === 'camera') {
    if (isCameraHistoricalHtml(legislatura)) {
      return ingestCameraHistoricalIndex(legislatura, {
        from: opts.fromNumero,
        to: opts.toNumero,
      })
    }
    return ingestCameraIndex(legislatura, {
      from: opts.fromNumero,
      to: opts.toNumero,
    })
  }
  if (!browserContext) {
    throw new Error('Senato index pass requires a Playwright browser context')
  }
  return ingestSenatoIndex(legislatura, browserContext)
}

async function runBody(
  chamber: Chamber,
  legislatura: number,
  numero: number,
  browserContext: BrowserContext | null,
) {
  if (chamber === 'camera') {
    if (isCameraHistoricalHtml(legislatura)) {
      return ingestCameraHistoricalSession(legislatura, numero)
    }
    return ingestCameraSession(legislatura, numero)
  }
  if (!browserContext) {
    throw new Error('Senato body pass requires a Playwright browser context')
  }
  return ingestSenatoSession(browserContext, legislatura, numero)
}

async function ingestOne(
  chamber: Chamber,
  legislatura: number,
  options: IngestParlamentoOptions,
): Promise<IngestParlamentoResult> {
  // Senato needs a Playwright browser (AWS WAF wall). One browser per
  // chamber-leg, reused across index pass + every seduta in the body pass
  // so the warmed WAF cookie persists.
  let senatoBrowser: Awaited<ReturnType<typeof openSenatoBrowser>> | null = null
  if (chamber === 'senato') {
    try {
      senatoBrowser = await openSenatoBrowser()
    } catch (err) {
      console.error(
        `[ingest:parlamento:senato] failed to launch Playwright browser:`,
        err instanceof Error ? err.message : err,
      )
      return {
        chamber,
        legislatura,
        indexInserted: 0,
        bodyAttempted: 0,
        bodyOk: 0,
        bodyPartial: 0,
        bodyEmpty: 0,
        bodyError: 0,
        durationMs: 0,
        ok: false,
        error: `Playwright browser failed to launch: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  const browserContext = senatoBrowser?.context ?? null

  try {
    return await ingestOneInner(chamber, legislatura, options, browserContext)
  } finally {
    await senatoBrowser?.close().catch(() => {})
  }
}

async function ingestOneInner(
  chamber: Chamber,
  legislatura: number,
  options: IngestParlamentoOptions,
  browserContext: BrowserContext | null,
): Promise<IngestParlamentoResult> {
  const started = Date.now()

  // Index pass: failures here are FATAL for this chamber (no point in
  // running the body pass if we have nothing to point at). They are
  // caught by ingestParlamento at the outer level so the *other* chamber
  // can still proceed.
  let indexResult: { rowsInserted: number }
  try {
    indexResult = await runIndex(chamber, legislatura, options, browserContext)
  } catch (err) {
    // A WAF block is not recoverable by continuing -- abort the whole run.
    if (err instanceof SenatoBlockError) throw err
    console.error(
      `[ingest:parlamento:${chamber}] INDEX PASS failed -- skipping body pass for this chamber:`,
      err instanceof Error ? err.message : err,
    )
    return {
      chamber,
      legislatura,
      indexInserted: 0,
      bodyAttempted: 0,
      bodyOk: 0,
      bodyPartial: 0,
      bodyEmpty: 0,
      bodyError: 0,
      durationMs: Date.now() - started,
      ok: false,
      error: `index pass failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  let pending: PendingSeduta[] = []
  try {
    pending = await listPending(chamber, legislatura, options.refresh ?? false)
  } catch (err) {
    console.error(
      `[ingest:parlamento:${chamber}] failed to list pending sedute:`,
      err instanceof Error ? err.message : err,
    )
    return {
      chamber,
      legislatura,
      indexInserted: indexResult.rowsInserted,
      bodyAttempted: 0,
      bodyOk: 0,
      bodyPartial: 0,
      bodyEmpty: 0,
      bodyError: 0,
      durationMs: Date.now() - started,
      ok: false,
      error: `could not list pending sedute: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const queue = options.limit ? pending.slice(0, options.limit) : pending

  let bodyOk = 0
  let bodyPartial = 0
  let bodyEmpty = 0
  let bodyError = 0

  console.log(
    `[ingest:parlamento:${chamber}] body pass over ${queue.length} sedute (limit=${options.limit ?? 'none'}, refresh=${options.refresh ?? false})`,
  )

  // Be polite to the upstream gov sites: a 500ms gap between session
  // fetches keeps us well below normal browsing rates and gives the
  // upstream's connection pool time to recycle. The default is small
  // enough that a 700-session run takes ~6 minutes of pure throttle.
  const POLITE_GAP_MS = 500

  for (let idx = 0; idx < queue.length; idx += 1) {
    const s = queue[idx]
    if (idx > 0) await sleep(POLITE_GAP_MS)
    let dbRetries = 0
    // Inner loop: retry the SAME seduta while the failure is "DB is down"
    // rather than a real per-seduta error.
    for (;;) {
      try {
        const r = await runBody(chamber, legislatura, s.numero, browserContext)
        if (r.status === 'ok') bodyOk += 1
        else if (r.status === 'partial') bodyPartial += 1
        else if (r.status === 'empty') bodyEmpty += 1
        else bodyError += 1
        break
      } catch (err) {
        // A WAF block means every further request will also hit the wall and
        // prolong the ban. Stop the whole run now; the seduta stays != "ok"
        // and resumes cleanly on the next (post-ban) run.
        if (err instanceof SenatoBlockError) {
          console.error(
            `[ingest:parlamento:${chamber}] WAF BLOCK at seduta ${s.numero} -- aborting run to avoid prolonging the ban`,
          )
          throw err
        }
        // Distinguish "the DB is momentarily down" (e.g. a SurrealDB
        // OOM-restart) from a genuine per-seduta failure. If the DB is
        // unreachable, pause for it to recover and retry the SAME seduta,
        // so a restart window doesn't torch the rest of the queue.
        if (dbRetries < MAX_DB_RECOVERY_RETRIES && !(await dbHealthy())) {
          dbRetries += 1
          console.warn(
            `[ingest:parlamento:${chamber}] seduta ${s.numero}: DB unreachable, waiting to retry (${dbRetries}/${MAX_DB_RECOVERY_RETRIES})`,
          )
          await waitForDb()
          continue // retry the same seduta
        }
        // Genuine per-seduta error (or DB will not recover): record + advance.
        bodyError += 1
        console.error(
          `[ingest:parlamento:${chamber}] seduta ${s.numero} failed:`,
          err instanceof Error ? err.message : err,
        )
        try {
          await runQuery(
            `UPDATE parlamento_sedute SET body_status = "error", body_error = $err
             WHERE chamber = $chamber AND legislatura = $leg AND numero = $num;`,
            {
              chamber,
              leg: legislatura,
              num: s.numero,
              err: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
            },
          )
        } catch (bookErr) {
          console.warn(
            `[ingest:parlamento:${chamber}] could not record error state for seduta ${s.numero}:`,
            bookErr instanceof Error ? bookErr.message : bookErr,
          )
        }
        break
      }
    }
    // Per-seduta progress every 10 sedute (or always for small runs).
    if (queue.length <= 20 || (idx + 1) % 10 === 0) {
      console.log(
        `[ingest:parlamento:${chamber}] progress ${idx + 1}/${queue.length} ` +
          `(ok=${bodyOk}, partial=${bodyPartial}, empty=${bodyEmpty}, error=${bodyError})`,
      )
    }
  }

  // Third phase: enrich every mandato in this (chamber, leg) with profile
  // data. Camera dispatches by leg internally (HTML for current,
  // SPARQL for historical). Senato uses SPARQL across all legs because
  // its profile pages are AWS-WAF-gated and the SPARQL data is richer.
  if (chamber === 'camera') {
    try {
      await ingestCameraDeputati({ legislatura, refresh: options.refresh ?? false })
    } catch (err) {
      console.warn(
        `[ingest:parlamento:camera] deputati bulk pass failed (continuing):`,
        err instanceof Error ? err.message : err,
      )
    }
  } else if (chamber === 'senato') {
    try {
      await ingestSenatoSenatori({ legislatura, refresh: options.refresh ?? false })
    } catch (err) {
      console.warn(
        `[ingest:parlamento:senato] senatori bulk pass failed (continuing):`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:${chamber}] DONE in ${(durationMs / 1000).toFixed(1)}s -- ` +
      `index +${indexResult.rowsInserted}, body ok=${bodyOk} partial=${bodyPartial} empty=${bodyEmpty} error=${bodyError}`,
  )

  return {
    chamber,
    legislatura,
    indexInserted: indexResult.rowsInserted,
    bodyAttempted: queue.length,
    bodyOk,
    bodyPartial,
    bodyEmpty,
    bodyError,
    durationMs,
    ok: true,
  }
}

export async function ingestParlamento(
  options: IngestParlamentoOptions,
): Promise<IngestParlamentoResult[]> {
  const legislatura = options.legislatura ?? 19
  const chambers: Chamber[] =
    options.chamber === 'both' ? ['camera', 'senato'] : [options.chamber]
  const results: IngestParlamentoResult[] = []
  for (const c of chambers) {
    // Even if one chamber's ingest dies catastrophically, we still try
    // the other one. Each chamber's ingestOne already swallows expected
    // errors; this outer try/catch is the last-line guard.
    try {
      results.push(await ingestOne(c, legislatura, options))
    } catch (err) {
      // Propagate a WAF block to the CLI so it can exit with a distinct code
      // and the driver can stop the whole multi-leg run.
      if (err instanceof SenatoBlockError) throw err
      console.error(
        `[ingest:parlamento:${c}] catastrophic failure -- moving on to next chamber:`,
        err instanceof Error ? err.stack ?? err.message : err,
      )
      results.push({
        chamber: c,
        legislatura,
        indexInserted: 0,
        bodyAttempted: 0,
        bodyOk: 0,
        bodyPartial: 0,
        bodyEmpty: 0,
        bodyError: 0,
        durationMs: 0,
        ok: false,
        error: `catastrophic failure: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }
  return results
}
