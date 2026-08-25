import type { BrowserContext } from 'playwright'
import type { RecordId } from 'surrealdb'

import { runQuery } from '../../query.ts'
import { openSenatoBrowser, SenatoBlockError } from './senatoBrowser.ts'
import {
  ingestCameraCommissioniIndex,
  CAMERA_COMMISSIONI_LEGS,
} from './cameraCommissioniIndex.ts'
import { ingestCameraCommissioneSession } from './cameraCommissioniSession.ts'
import { ingestSenatoCommissioniIndex } from './senatoCommissioniIndex.ts'
import { ingestSenatoCommissioneSession } from './senatoCommissioniSession.ts'

// -----------------------------------------------------------------------------
// Committee-transcript orchestrator.
//
// Same two-phase shape as the assembly ingest in index.ts -- an index pass
// that discovers sittings and a body pass that fills them in -- and the same
// resumability contract: every sitting carries a deterministic record id and a
// body_status, so an interrupted run is resumed simply by running it again.
// Nothing is keyed on run order or on a cursor that can go stale.
//
// It is a separate orchestrator rather than a branch inside the assembly one
// because the two differ in every operational dimension that matters: what a
// "unit of work" is (a numero vs a document scope), which host is being
// talked to, and how expensive a request is.
// -----------------------------------------------------------------------------

export type Chamber = 'camera' | 'senato'

export interface IngestCommissioniOptions {
  chamber: Chamber | 'both'
  legislatura: number
  /** Cap the body pass; the index pass always runs in full. */
  limit?: number
  /** Re-fetch and re-parse sittings already marked ok. */
  refresh?: boolean
  /** Skip discovery and only work through sittings already in the table. */
  skipIndex?: boolean
  /**
   * Run discovery and stop. Index rows are metadata only (a few hundred bytes
   * each), so this surveys how large a corpus a full body pass would build --
   * and how much disk it would need -- before committing to it.
   */
  indexOnly?: boolean
  /** Senato only: restrict to these "{tipo}-{cod}" committee codes. */
  onlyCod?: string[]
  /**
   * Senato only: probe for organi the LOD roster omits (the Giunte). On by
   * default; costs ~64 requests per legislature, once, at index time.
   */
  discoverMissing?: boolean
  /**
   * Camera only: restrict discovery to these YYYYMM months instead of every
   * month the legislature published. This is what makes a routine refresh
   * cheap -- the daily pass only needs the current month, not a full rescan.
   */
  months?: string[]
}

export interface IngestCommissioniResult {
  chamber: Chamber
  legislatura: number
  indexed: number
  bodyAttempted: number
  bodyOk: number
  bodyPartial: number
  bodyEmpty: number
  bodyError: number
  /** Advertised by the source listing but not actually published by it. */
  bodyMissing: number
  durationMs: number
  ok: boolean
  error?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Camera is unauthenticated static HTML; a short gap is plenty. */
const CAMERA_GAP_MS = 400

interface PendingRow {
  id: RecordId<'parlamento_sedute'>
  body_status?: string
}

/**
 * List the sittings still needing a body pass, as record-id scopes.
 *
 * `body_status != "ok"` also picks up rows left at "ingesting" by a crashed
 * run, which is the intended recovery path.
 */
async function listPending(
  chamber: Chamber,
  legislatura: number,
  refresh: boolean,
  onlyCod?: string[],
): Promise<string[]> {
  // "missing" joins "ok" as a terminal state: the document is not published
  // upstream, so re-requesting it daily buys nothing. --refresh ignores the
  // filter entirely and re-attempts everything.
  const statusFilter = refresh ? '' : 'AND body_status NOT IN ["ok", "missing"]'
  // --only-cod has to narrow the BODY pass too, not just discovery. Without
  // this, `--only-cod 4-226 --skip-index` quietly queues every pending sitting
  // in the legislature (6,304 of them for Senato leg 19) instead of the 171
  // the operator asked for -- days of throttled fetching instead of minutes.
  const codFilter = onlyCod?.length ? 'AND organo_cod IN $cods' : ''
  const rows =
    (await runQuery<PendingRow[]>(
      // `data` is projected only because SurrealDB requires an ORDER BY
      // idiom to appear in the selection; the value itself is unused.
      `SELECT id, body_status, data FROM parlamento_sedute
       WHERE organo = "commissione" AND chamber = $chamber AND legislatura = $leg
         ${statusFilter} ${codFilter}
       ORDER BY data ASC;`,
      { chamber, leg: legislatura, ...(onlyCod?.length ? { cods: onlyCod } : {}) },
    )) ?? []
  // The SDK hands back RecordId instances; `.id` is the scope token the
  // session ingests take. Reading it here avoids depending on a SurrealQL
  // id-extraction function whose name has moved between versions.
  return rows.map((r) => String(r.id.id))
}

function emptyResult(
  chamber: Chamber,
  legislatura: number,
  startedAt: number,
  error?: string,
): IngestCommissioniResult {
  return {
    chamber,
    legislatura,
    indexed: 0,
    bodyAttempted: 0,
    bodyOk: 0,
    bodyPartial: 0,
    bodyEmpty: 0,
    bodyError: 0,
    bodyMissing: 0,
    durationMs: Date.now() - startedAt,
    ok: error === undefined,
    error,
  }
}

async function runChamber(
  chamber: Chamber,
  options: IngestCommissioniOptions,
  context: BrowserContext | null,
): Promise<IngestCommissioniResult> {
  const started = Date.now()
  const { legislatura } = options

  // ---- Index pass -------------------------------------------------------
  let indexed = 0
  if (!options.skipIndex) {
    try {
      if (chamber === 'camera') {
        indexed = (await ingestCameraCommissioniIndex(legislatura, { months: options.months }))
          .rowsInserted
      } else {
        if (!context) throw new Error('Senato committee index pass requires a browser context')
        indexed = (
          await ingestSenatoCommissioniIndex(legislatura, context, {
            onlyCod: options.onlyCod,
            discoverMissing: options.discoverMissing,
          })
        ).rowsInserted
      }
    } catch (err) {
      if (err instanceof SenatoBlockError) throw err
      // Index failure is fatal for this chamber -- the body pass would have
      // nothing new to work on -- but must not be reported as a healthy
      // zero-work run.
      console.error(
        `[ingest:commissioni:${chamber}] INDEX PASS failed:`,
        err instanceof Error ? err.message : err,
      )
      return emptyResult(
        chamber,
        legislatura,
        started,
        `index pass failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  if (options.indexOnly) {
    const totals =
      (await runQuery<Array<{ n: number }>>(
        `SELECT count() AS n FROM parlamento_sedute
         WHERE organo = "commissione" AND chamber = $chamber AND legislatura = $leg
         GROUP ALL;`,
        { chamber, leg: legislatura },
      )) ?? []
    const known = totals[0]?.n ?? 0
    console.log(
      `[ingest:commissioni:${chamber}] leg=${legislatura} INDEX ONLY -- ` +
        `${known} sittings known, body pass not run`,
    )
    return { ...emptyResult(chamber, legislatura, started), indexed, ok: true }
  }

  // ---- Body pass --------------------------------------------------------
  let pending: string[]
  try {
    pending = await listPending(
      chamber,
      legislatura,
      options.refresh ?? false,
      options.onlyCod,
    )
  } catch (err) {
    return emptyResult(
      chamber,
      legislatura,
      started,
      `could not list pending sittings: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const queue = options.limit ? pending.slice(0, options.limit) : pending
  console.log(
    `[ingest:commissioni:${chamber}] leg=${legislatura} body pass over ${queue.length} sittings ` +
      `(of ${pending.length} pending, limit=${options.limit ?? 'none'}, refresh=${options.refresh ?? false})`,
  )

  let bodyOk = 0
  let bodyPartial = 0
  let bodyEmpty = 0
  let bodyError = 0
  let bodyMissing = 0

  for (let i = 0; i < queue.length; i += 1) {
    const scope = queue[i]
    // Senato spacing is handled by senatoThrottle inside the fetch path, so
    // only Camera needs a gap here.
    if (i > 0 && chamber === 'camera') await sleep(CAMERA_GAP_MS)
    try {
      const r =
        chamber === 'camera'
          ? await ingestCameraCommissioneSession(scope)
          : await ingestSenatoCommissioneSession(context!, scope)
      if (r.status === 'ok') bodyOk += 1
      else if (r.status === 'partial') bodyPartial += 1
      else if (r.status === 'empty') bodyEmpty += 1
      else if (r.status === 'missing') bodyMissing += 1
      else bodyError += 1
    } catch (err) {
      // A WAF block means every subsequent request also hits the wall and
      // extends the ban. Stop now; the sitting stays != "ok" and the next run
      // resumes from here.
      if (err instanceof SenatoBlockError) {
        console.error(
          `[ingest:commissioni:${chamber}] WAF BLOCK at ${scope} -- aborting run to avoid prolonging the ban`,
        )
        throw err
      }
      bodyError += 1
      console.error(
        `[ingest:commissioni:${chamber}] ${scope} failed:`,
        err instanceof Error ? err.message : err,
      )
      try {
        await runQuery(
          `UPDATE type::thing("parlamento_sedute", $scope)
           SET body_status = "error", body_error = $err;`,
          {
            scope,
            err: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
          },
        )
      } catch (bookErr) {
        console.warn(
          `[ingest:commissioni:${chamber}] could not record error state for ${scope}:`,
          bookErr instanceof Error ? bookErr.message : bookErr,
        )
      }
    }
    if (queue.length <= 20 || (i + 1) % 25 === 0) {
      console.log(
        `[ingest:commissioni:${chamber}] progress ${i + 1}/${queue.length} ` +
          `(ok=${bodyOk}, partial=${bodyPartial}, empty=${bodyEmpty}, missing=${bodyMissing}, error=${bodyError})`,
      )
    }
  }

  const durationMs = Date.now() - started
  console.log(
    `[ingest:commissioni:${chamber}] leg=${legislatura} DONE in ${(durationMs / 1000).toFixed(1)}s -- ` +
      `index +${indexed}, body ok=${bodyOk} partial=${bodyPartial} empty=${bodyEmpty} ` +
      `missing=${bodyMissing} error=${bodyError}`,
  )

  return {
    chamber,
    legislatura,
    indexed,
    bodyAttempted: queue.length,
    bodyOk,
    bodyPartial,
    bodyEmpty,
    bodyError,
    bodyMissing,
    durationMs,
    ok: true,
  }
}

export async function ingestCommissioni(
  options: IngestCommissioniOptions,
): Promise<IngestCommissioniResult[]> {
  const chambers: Chamber[] =
    options.chamber === 'both' ? ['camera', 'senato'] : [options.chamber]
  const results: IngestCommissioniResult[] = []

  for (const chamber of chambers) {
    if (chamber === 'camera' && !(CAMERA_COMMISSIONI_LEGS as readonly number[]).includes(options.legislatura)) {
      console.log(
        `[ingest:commissioni:camera] leg=${options.legislatura} has no committee transcript ` +
          `service upstream (covered: ${CAMERA_COMMISSIONI_LEGS.join(', ')}) -- skipping`,
      )
      results.push(emptyResult('camera', options.legislatura, Date.now()))
      continue
    }

    // One browser per chamber-run, so the solved WAF cookie is reused across
    // the index pass and every document in the body pass.
    let browser: Awaited<ReturnType<typeof openSenatoBrowser>> | null = null
    if (chamber === 'senato') {
      try {
        browser = await openSenatoBrowser()
      } catch (err) {
        console.error(
          '[ingest:commissioni:senato] failed to launch Playwright browser:',
          err instanceof Error ? err.message : err,
        )
        results.push(
          emptyResult(
            'senato',
            options.legislatura,
            Date.now(),
            `Playwright browser failed to launch: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        continue
      }
    }

    try {
      results.push(await runChamber(chamber, options, browser?.context ?? null))
    } catch (err) {
      if (err instanceof SenatoBlockError) {
        await browser?.close().catch(() => {})
        throw err
      }
      console.error(
        `[ingest:commissioni:${chamber}] catastrophic failure:`,
        err instanceof Error ? err.stack ?? err.message : err,
      )
      results.push(
        emptyResult(
          chamber,
          options.legislatura,
          Date.now(),
          `catastrophic failure: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
    } finally {
      await browser?.close().catch(() => {})
    }
  }

  return results
}
