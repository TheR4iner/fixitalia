import { runQuery } from './query.ts'
import { isFireDue, wallClockIn } from './scheduler.ts'
import { ingestOpereIncompiute } from './ingest/opereIncompiute.ts'
import { ingestSpesaPubblica } from './ingest/spesaPubblica.ts'
import { ingestFondiEuropei } from './ingest/fondiEuropei.ts'
import { ingestAppalti } from './ingest/appalti.ts'

// -----------------------------------------------------------------------------
// Periodic refresh for the four open-data sources.
//
// Why this exists: until now these ingests ran *only* when their table was
// empty, so whatever snapshot won the race on the first boot stayed forever.
// Production served BDAP's February-2026 snapshot for months while four newer
// ones had been published, and nothing anywhere said so. An ingest that never
// re-runs is a stale-data generator with extra steps.
//
// Design mirrors the Parlamento scheduler (see scheduler.ts) and reuses its
// wall-clock helpers: one daily fire in Europe/Rome, a 60s polling tick so DST
// and restarts are handled for free, all knobs from env. The differences:
//
//   - Staleness-gated. Each source declares how long its data stays fresh,
//     derived from the publisher's own cadence. A source inside its window is
//     skipped without an HTTP call, so the daily tick usually costs four
//     SurrealDB probes and nothing else.
//   - Sources run sequentially. They are independent, but four concurrent
//     ingests hammering four ministries' portals buys nothing: the whole pass
//     is a few tens of megabytes and has all day to finish.
//   - A `needsReingest` hook lets a source force a refresh when its rows
//     predate a schema change. This is the only mechanism available for that:
//     the VPS deploy key is pinned to `docker compose pull && up -d` and
//     cannot run a migration script, so a schema migration has to be able to
//     announce itself from inside the process.
// -----------------------------------------------------------------------------

interface RefreshSource {
  /** Stable name for logs. */
  name: string
  /**
   * Table used to decide whether the source has any data at all, and whose
   * newest `ingested_at` dates the snapshot. For multi-table sources this is
   * the one row set that proves the ingest completed.
   */
  gateTable: string
  /** How long the data is considered fresh, in days. */
  freshForDays: number
  ingest: () => Promise<unknown>
  /**
   * Optional: return true to force a re-ingest regardless of freshness.
   * Used for schema migrations that can only be detected by looking at the
   * rows already stored.
   */
  needsReingest?: () => Promise<boolean>
}

/**
 * BDAP publishes a new monthly package roughly two months after the month it
 * covers, so a 7-day window means we notice a new snapshot within a week
 * without polling harder than the data changes.
 *
 * MIT publishes the opere incompiute registry once a year; OpenCoesione and
 * ANAC update on the order of weeks. The windows are deliberately much shorter
 * than the publication cadence: the cost of a redundant check is one small
 * download, the cost of a missed one is months of stale figures on a page that
 * claims to be current.
 */
const SOURCES: RefreshSource[] = [
  {
    name: 'spesa_pubblica',
    gateTable: 'spesa_missioni',
    freshForDays: 7,
    ingest: ingestSpesaPubblica,
    // Rows written before the two-snapshot split have no `periodo`, and every
    // read query now filters on it -- without a re-ingest the section would
    // render empty after the deploy that introduced the field.
    // An existence probe, not a count(). This SurrealDB version answers
    // count() from a single index and drops the remaining predicates, so any
    // count with an indexable filter has to be treated as unreliable (see the
    // note in routes/appalti.ts). A LIMIT 1 materialised select cannot be
    // wrong, and "is there at least one legacy row" is all we need.
    needsReingest: async () => {
      const rows = await runQuery<Array<{ id: unknown }>>(
        `SELECT id FROM spesa_missioni WHERE periodo = NONE LIMIT 1;`,
      )
      const legacy = (rows ?? []).length > 0
      if (legacy) {
        console.log(
          '[refresh] spesa_missioni still has rows without `periodo` (pre-split ' +
            'schema); forcing a re-ingest.',
        )
      }
      return legacy
    },
  },
  {
    name: 'opere_incompiute',
    gateTable: 'opere_incompiute',
    freshForDays: 30,
    ingest: ingestOpereIncompiute,
  },
  {
    name: 'fondi_europei',
    gateTable: 'fondi_totali',
    freshForDays: 14,
    ingest: ingestFondiEuropei,
  },
  {
    name: 'appalti',
    gateTable: 'appalti_stazioni',
    freshForDays: 14,
    ingest: ingestAppalti,
  },
]

interface RefreshConfig {
  enabled: boolean
  hour: number
  minute: number
  timezone: string
  tickMs: number
}

function clampInt(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  const n = raw === undefined ? NaN : Number(raw)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  return Math.min(Math.max(i, lo), hi)
}

function readConfig(): RefreshConfig {
  return {
    enabled: process.env.OPENDATA_REFRESH_ENABLED !== 'false',
    // 04:30 keeps this clear of the Parlamento auto-fetch at 06:00, so the two
    // never contend for the same DB connection pool.
    hour: clampInt(process.env.OPENDATA_REFRESH_HOUR, 4, 0, 23),
    minute: clampInt(process.env.OPENDATA_REFRESH_MINUTE, 30, 0, 59),
    timezone: process.env.OPENDATA_REFRESH_TZ ?? 'Europe/Rome',
    tickMs: 60_000,
  }
}

interface SourceState {
  rowCount: number
  newestIngestedAt: Date | null
}

async function readSourceState(table: string): Promise<SourceState> {
  // time::max, NOT math::max. SurrealDB's math::* aggregates are numeric only
  // and return *nothing at all* for a datetime column -- no error, no null,
  // the key is simply absent from the result row. Using math::max here made
  // every source look like it had no ingest timestamp, which would have turned
  // the staleness check into "re-download all four sources on every boot".
  const rows = await runQuery<Array<{ count: number; newest: string | null }>>(
    `SELECT count() AS count, time::max(ingested_at) AS newest
     FROM ${table} GROUP ALL;`,
  )
  const row = rows?.[0]
  const newest = row?.newest ? new Date(row.newest) : null
  return {
    rowCount: row?.count ?? 0,
    newestIngestedAt: newest && Number.isFinite(newest.getTime()) ? newest : null,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Bring one source up to date if it is empty, stale, or flagged by its own
 * migration hook. Returns what it decided, so the caller can log one line per
 * source whether or not anything happened.
 *
 * Errors are caught and reported per source: one unreachable ministry portal
 * must not stop the other three from refreshing.
 */
export async function refreshSource(
  source: RefreshSource,
  now: Date = new Date(),
): Promise<'ingested' | 'fresh' | 'failed'> {
  let reason: string
  try {
    const state = await readSourceState(source.gateTable)
    const ageMs =
      state.newestIngestedAt === null
        ? Number.POSITIVE_INFINITY
        : now.getTime() - state.newestIngestedAt.getTime()
    const ageDays = ageMs / DAY_MS

    if (state.rowCount === 0) {
      reason = 'table is empty'
    } else if (source.needsReingest && (await source.needsReingest())) {
      reason = 'schema migration'
    } else if (ageDays > source.freshForDays) {
      reason =
        state.newestIngestedAt === null
          ? 'no ingested_at recorded'
          : `${ageDays.toFixed(1)}d old, window is ${source.freshForDays}d`
    } else {
      console.log(
        `[refresh] ${source.name}: fresh (${ageDays.toFixed(1)}d old, ` +
          `${state.rowCount} rows) -- skipping`,
      )
      return 'fresh'
    }
  } catch (err) {
    console.error(
      `[refresh] ${source.name}: could not read state, skipping this pass:`,
      err instanceof Error ? err.message : err,
    )
    return 'failed'
  }

  console.log(`[refresh] ${source.name}: re-ingesting (${reason})`)
  try {
    await source.ingest()
    console.log(`[refresh] ${source.name}: ok`)
    return 'ingested'
  } catch (err) {
    // Loud and greppable: a failed refresh means the page keeps serving the
    // previous snapshot, which is the failure mode that went unnoticed for
    // months. It must not look like a successful no-op.
    console.error(
      `[refresh] ${source.name}: INGEST FAILED -- the section keeps serving its ` +
        'previous snapshot until the next successful run:',
      err instanceof Error ? (err.stack ?? err.message) : err,
    )
    return 'failed'
  }
}

let inFlight = false

/** Walk every source once, sequentially. Safe to call concurrently: re-entry is skipped. */
export async function refreshAllSources(now: Date = new Date()): Promise<void> {
  if (inFlight) {
    console.warn('[refresh] previous pass still running; skipping')
    return
  }
  inFlight = true
  const started = Date.now()
  const tally: Record<string, number> = { ingested: 0, fresh: 0, failed: 0 }
  try {
    for (const source of SOURCES) {
      const outcome = await refreshSource(source, now)
      tally[outcome] = (tally[outcome] ?? 0) + 1
    }
  } finally {
    inFlight = false
  }
  const summary =
    `[refresh] pass complete in ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
    `${tally.ingested} re-ingested, ${tally.fresh} still fresh, ${tally.failed} failed`
  if ((tally.failed ?? 0) > 0) console.error(summary)
  else console.log(summary)
}

let lastRunDate: string | null = null
let intervalHandle: ReturnType<typeof setInterval> | null = null

/**
 * Start the daily refresh. Idempotent; skipped under NODE_ENV=test and when
 * OPENDATA_REFRESH_ENABLED=false.
 *
 * The first pass runs immediately at boot rather than waiting for the target
 * time: that is what replaces the old "ingest only if the table is empty"
 * bootstrap, and it is how a deploy carrying a schema migration applies it.
 */
export function startOpenDataRefresh(): void {
  if (intervalHandle !== null) return
  if (process.env.NODE_ENV === 'test') return
  const cfg = readConfig()
  if (!cfg.enabled) {
    console.log('[refresh] OPENDATA_REFRESH_ENABLED=false -- not starting')
    return
  }
  console.log(
    `[refresh] open-data refresh enabled, daily target ` +
      `${String(cfg.hour).padStart(2, '0')}:${String(cfg.minute).padStart(2, '0')} ${cfg.timezone}`,
  )

  // Boot pass. Staleness is read from the DB, so a restart loop cannot turn
  // this into repeated downloads: the first pass stamps `ingested_at` and
  // every subsequent boot sees fresh data and skips.
  lastRunDate = wallClockIn(cfg.timezone).date
  void refreshAllSources()

  intervalHandle = setInterval(() => {
    if (!isFireDue(cfg, lastRunDate)) return
    lastRunDate = wallClockIn(cfg.timezone).date
    void refreshAllSources()
  }, cfg.tickMs)
  // Don't keep the event loop alive solely for this timer; the HTTP server
  // already does that.
  intervalHandle.unref?.()
}

/** Test seam: stop the timer and reset state. */
export function stopOpenDataRefresh(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  lastRunDate = null
  inFlight = false
}
