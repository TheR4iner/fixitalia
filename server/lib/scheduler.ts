import { ingestParlamento, type IngestParlamentoResult } from './ingest/parlamento/index.ts'
import { ingestCommissioni } from './ingest/parlamento/commissioni.ts'
import { runRefsPass } from './ingest/parlamento/refs.ts'
import { runQuery } from './query.ts'

// -----------------------------------------------------------------------------
// In-process daily scheduler for the Parlamento auto-fetch.
//
// Why in-process and not host cron / external scheduler?
//   1. The whole project lives in one repo + one compose stack. Adding a
//      host-side cron (or an external scheduler container) would split
//      operations across two surfaces with no real benefit.
//   2. The ingest is idempotent (body_status checkpointing in
//      parlamento_sedute), so a restart mid-fetch heals on the next fire.
//   3. We need exactly one daily fire, not a complex cron expression.
//
// Why a 60s polling tick instead of setTimeout(msUntilNext)?
//   - DST transitions are handled "for free": each tick re-reads the wall
//     clock in Europe/Rome and decides whether today's fire is due.
//   - A server restart after the target time still fires today's run
//     (lastRunDate is in-memory, and a process restart wipes it -- we'd
//     then notice "current time >= target AND we have not fired today" on
//     the next tick).
//   - Cost: one wall-clock comparison per minute. Negligible.
//
// All knobs come from env so tests can run scheduler-free and operators
// can shift the fire time without code changes.
// -----------------------------------------------------------------------------

interface SchedulerConfig {
  enabled: boolean
  hour: number
  minute: number
  legislatura: number
  timezone: string
  tickMs: number
  /**
   * Also refresh Camera committee transcripts for the CURRENT MONTH.
   *
   * Opt-in rather than on by default, for one reason: it grows the corpus.
   * The committee archive is several times larger than the plenary one
   * (legislature 17 alone holds 3,273 stenographic sittings), so turning this
   * on is a storage decision an operator should make deliberately rather than
   * discover.
   *
   * Scoped to Camera and to the current month on purpose. Camera is WAF-free
   * and one month's listing is a single request, so the daily cost is small
   * and bounded. Senato committee work is throttled at ~8s per document and
   * belongs in a manual backfill campaign, never in a daily tick.
   */
  commissioni: boolean
}

function readConfig(): SchedulerConfig {
  return {
    enabled: process.env.PARLAMENTO_AUTOFETCH_ENABLED !== 'false',
    hour: clampInt(process.env.PARLAMENTO_AUTOFETCH_HOUR, 6, 0, 23),
    minute: clampInt(process.env.PARLAMENTO_AUTOFETCH_MINUTE, 0, 0, 59),
    legislatura: clampInt(process.env.PARLAMENTO_AUTOFETCH_LEG, 19, 1, 99),
    timezone: process.env.PARLAMENTO_AUTOFETCH_TZ ?? 'Europe/Rome',
    tickMs: 60_000,
    commissioni: process.env.PARLAMENTO_AUTOFETCH_COMMISSIONI === 'true',
  }
}

function clampInt(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  const n = raw === undefined ? NaN : Number(raw)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  return Math.min(Math.max(i, lo), hi)
}

/**
 * Returns the wall-clock date and HH:MM in the given IANA timezone.
 * Pure helper so it can be unit-tested with a mocked Date.
 */
export function wallClockIn(
  tz: string,
  now: Date = new Date(),
): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(now)) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // The 'sv-SE' locale renders hour 24:00 instead of 00:00 at midnight on
    // some Node versions. Normalize to 00:xx so lexicographic >= comparisons
    // against a HH:MM target work uniformly.
    time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
  }
}

/**
 * Decide whether a daily fire is due. Returns true if we are at or past
 * the target time today (in tz) and we have not already fired today.
 */
export function isFireDue(
  cfg: { hour: number; minute: number; timezone: string },
  lastRunDate: string | null,
  now: Date = new Date(),
): boolean {
  const { date, time } = wallClockIn(cfg.timezone, now)
  if (lastRunDate === date) return false
  const target = `${pad2(cfg.hour)}:${pad2(cfg.minute)}`
  return time >= target
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

let lastRunDate: string | null = null
let inFlight = false
let intervalHandle: ReturnType<typeof setInterval> | null = null

// Same-day retry budget after a failed run.
//
// A failed run must not simply wait a full day -- that is how a single bad
// startup turned into a month of stale data. But it must not hammer either:
// the Senato pass drives a real browser against an AWS-WAF-protected site, so
// a tight retry loop risks a ban that would make things worse. Three attempts
// spaced 30 minutes apart covers a transient DB or upstream problem while
// staying far below anything that looks abusive.
const MAX_RETRIES_PER_DAY = 3
const RETRY_COOLDOWN_MS = 30 * 60 * 1000

let retriesToday = 0
let retryNotBefore = 0

/**
 * Arrange for a failed run to be retried later today, within budget. Clearing
 * lastRunDate is what makes the next tick eligible to fire; retryNotBefore is
 * what keeps that from happening on the very next 60s tick.
 */
function scheduleRetry(): void {
  if (retriesToday >= MAX_RETRIES_PER_DAY) {
    console.error(
      `[scheduler] retry budget exhausted (${MAX_RETRIES_PER_DAY} attempts today); ` +
        `waiting for tomorrow's scheduled run. Investigate before then.`,
    )
    return
  }
  retriesToday += 1
  retryNotBefore = Date.now() + RETRY_COOLDOWN_MS
  lastRunDate = null
  console.warn(
    `[scheduler] will retry (${retriesToday}/${MAX_RETRIES_PER_DAY}) in ` +
      `${Math.round(RETRY_COOLDOWN_MS / 60000)} minutes`,
  )
}

async function runIngest(cfg: SchedulerConfig): Promise<void> {
  if (inFlight) {
    console.warn('[scheduler] previous parlamento auto-fetch still running; skipping this tick')
    return
  }
  inFlight = true
  const startedAt = new Date()
  console.log(
    `[scheduler] firing parlamento auto-fetch (leg=${cfg.legislatura}, started=${startedAt.toISOString()})`,
  )
  try {
    const results: IngestParlamentoResult[] = await ingestParlamento({
      chamber: 'both',
      legislatura: cfg.legislatura,
    })
    // Report failures as failures. Previously every chamber printed the same
    // `index +0, body ok=0 ... (0.0s)` shape whether it had found nothing or
    // crashed, so a broken ingest was indistinguishable from a parliamentary
    // recess -- which is how this went unnoticed from 2026-07-16 to 08-16.
    const failed = results.filter((r) => !r.ok)
    for (const r of results) {
      const summary =
        `${r.chamber} index +${r.indexInserted}, body ok=${r.bodyOk} ` +
        `partial=${r.bodyPartial} empty=${r.bodyEmpty} error=${r.bodyError} ` +
        `(${(r.durationMs / 1000).toFixed(1)}s)`
      if (r.ok) console.log(`[scheduler] ${summary}`)
      else console.error(`[scheduler] FAILED ${summary} -- ${r.error ?? 'unknown error'}`)
    }
    if (failed.length > 0) {
      // One loud, greppable line per failed run, so "did the ingest work?" is
      // answerable without reconstructing it from per-chamber output.
      console.error(
        `[scheduler] AUTO-FETCH DEGRADED: ${failed.length}/${results.length} chamber pass(es) failed ` +
          `(${failed.map((f) => f.chamber).join(', ')}). Data may be stale until the next successful run.`,
      )
      scheduleRetry()
    } else {
      retriesToday = 0
    }
    // Camera committee transcripts for the current month, when enabled.
    // Deliberately AFTER the plenary pass and inside its own try/catch: this
    // is an addition to the daily job, and a failure here must not mask or
    // abort the plenary result the rest of this function reports on.
    if (cfg.commissioni) {
      try {
        const now = new Date()
        const month = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`
        const commResults = await ingestCommissioni({
          chamber: 'camera',
          legislatura: cfg.legislatura,
          months: [month],
        })
        for (const r of commResults) {
          const summary =
            `commissioni ${r.chamber} index +${r.indexed}, body ok=${r.bodyOk} ` +
            `partial=${r.bodyPartial} empty=${r.bodyEmpty} missing=${r.bodyMissing} ` +
            `error=${r.bodyError} (${(r.durationMs / 1000).toFixed(1)}s)`
          if (r.ok) console.log(`[scheduler] ${summary}`)
          else console.error(`[scheduler] FAILED ${summary} -- ${r.error ?? 'unknown error'}`)
        }
      } catch (err) {
        console.error(
          '[scheduler] commissioni auto-fetch threw (plenary pass unaffected):',
          err instanceof Error ? err.message : err,
        )
      }
    }

    // After the body pass lands new sedute, run the refs pass with
    // --reresolve so:
    //   - any seduta whose refs_parser_version is now stale gets
    //     re-extracted (the refs subcommand's own checkpoint check
    //     filters this);
    //   - AS bills marked resolve_status='failed' on previous days
    //     get retried (most likely transient SPARQL hiccups).
    // It's a no-op when there is nothing to do, so we can fire it
    // unconditionally without waste.
    try {
      const refs = await runRefsPass({
        chamber: 'both',
        legislatura: cfg.legislatura,
        reparse: false,
        reresolve: true,
      })
      console.log(
        `[scheduler] refs pass: processed=${refs.sedute_processed}, ` +
          `refs_written=${refs.refs_written}, as_resolved=${refs.as_resolved}/` +
          `${refs.as_resolved + refs.as_failed} ` +
          `(${(refs.durationMs / 1000).toFixed(1)}s)`,
      )
    } catch (refsErr) {
      // Don't let a refs failure mark the whole tick as failed --
      // tomorrow will retry, and the body pass already succeeded.
      console.warn(
        '[scheduler] refs pass failed (will retry tomorrow):',
        refsErr instanceof Error ? refsErr.message : refsErr,
      )
    }
  } catch (err) {
    console.error(
      '[scheduler] auto-fetch failed:',
      err instanceof Error ? err.stack ?? err.message : err,
    )
  } finally {
    inFlight = false
  }
}

/**
 * Read the date of the most recent ingest run from `parlamento_ingest_state`,
 * rendered in the scheduler's timezone. Used at boot so a tsx --watch reload
 * (or any same-day restart) does not re-trigger today's ingest.
 *
 * Returns null on any DB error -- the scheduler degrades to "may fire on
 * boot" rather than blocking startup on a transient DB hiccup.
 */
async function lastIngestDateInTz(legislatura: number, tz: string): Promise<string | null> {
  try {
    const rows = await runQuery<Array<{ updated_at: string }>>(
      `SELECT updated_at FROM parlamento_ingest_state
       WHERE legislatura = $leg
       ORDER BY updated_at DESC LIMIT 1;`,
      { leg: legislatura },
    )
    const ts = rows?.[0]?.updated_at
    if (!ts) return null
    return wallClockIn(tz, new Date(ts)).date
  } catch (err) {
    console.warn(
      '[scheduler] could not read last ingest date (will assume no run today):',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/**
 * Start the scheduler. Idempotent: a second call is a no-op.
 * Skipped automatically when PARLAMENTO_AUTOFETCH_ENABLED=false or when
 * NODE_ENV=test (vitest runs would otherwise spawn the cron timer).
 */
export function startParlamentoScheduler(): void {
  if (intervalHandle !== null) return
  if (process.env.NODE_ENV === 'test') return
  const cfg = readConfig()
  if (!cfg.enabled) {
    console.log('[scheduler] PARLAMENTO_AUTOFETCH_ENABLED=false -- not starting')
    return
  }
  console.log(
    `[scheduler] parlamento auto-fetch enabled, target ${pad2(cfg.hour)}:${pad2(cfg.minute)} ${cfg.timezone}, leg=${cfg.legislatura}`,
  )

  // Initialize lastRunDate from the DB so a same-day restart (especially
  // tsx --watch in dev) doesn't re-fire today's ingest. Fire-and-forget:
  // the first 60s tick runs after this resolves in practice.
  void lastIngestDateInTz(cfg.legislatura, cfg.timezone).then((d) => {
    lastRunDate = d
    console.log(
      `[scheduler] initial lastRunDate=${d ?? 'null'} (today=${wallClockIn(cfg.timezone).date})`,
    )
    // Tick immediately so a restart well after the target time still
    // catches up the missed run. The DB-derived lastRunDate guards
    // against re-firing if today has already been ingested.
    void tick(cfg)
  })

  intervalHandle = setInterval(() => void tick(cfg), cfg.tickMs)
  // Don't keep the event loop alive solely for the scheduler. The HTTP
  // server's listen() already does that; once it stops, we stop.
  intervalHandle.unref?.()
}

async function tick(cfg: SchedulerConfig): Promise<void> {
  if (!isFireDue(cfg, lastRunDate)) return
  // A retry scheduled after a failure must observe its cooldown, otherwise
  // clearing lastRunDate would make it fire on the very next 60s tick.
  if (retryNotBefore > 0 && Date.now() < retryNotBefore) return
  retryNotBefore = 0
  lastRunDate = wallClockIn(cfg.timezone).date
  await runIngest(cfg)
}

/** Test seam: stop the timer and reset state so a test can start fresh. */
export function stopParlamentoScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  lastRunDate = null
  inFlight = false
  retriesToday = 0
  retryNotBefore = 0
}
