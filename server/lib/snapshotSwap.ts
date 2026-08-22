import { Table } from 'surrealdb'

import { withDbRetry } from './query.ts'

// -----------------------------------------------------------------------------
// Atomic snapshot replacement for the open-data ingests.
//
// THE PROBLEM
//
// Every ingest used to do `DELETE <table>` and then insert in batches. Readers
// arriving in that window got an empty result set, which the pages render as
// "0 EUR" and empty charts -- a wrong number, not a loading state.
//
// This was observed in production on 2026-08-17, not theorised: the first probe
// of the live API right after the v0.7.0 deploy returned
// `anno: null, totalCount: 0, totalePagato: 0` while a re-ingest was mid-flight.
//
// It used to be almost unreachable, because the ingests only ran when their
// table was empty. Once lib/openDataRefresh.ts started re-running them daily on
// a staleness window, it became a routine exposure -- once per upstream release
// per source, and the wider the source the longer the window (appalti is 48k
// rows, tens of seconds).
//
// THE FIX
//
// Load the new rows into a staging table, then move them across in ONE
// transaction. Readers see the old snapshot until the instant the new one is
// complete, and never anything in between.
//
//   1. DELETE <table>_staging, insert the new rows there. Nothing reads
//      staging, so this phase is invisible however long it takes.
//   2. BEGIN TRANSACTION; DELETE <table>; INSERT INTO <table> (SELECT * FROM
//      <table>_staging); COMMIT TRANSACTION;
//   3. Drop the staging rows.
//
// Step 2 stays small and fast whatever the row count, because the rows move
// server-side: the SQL never carries them.
//
// WHY THIS IS SOUND HERE, verified against this SurrealDB rather than assumed:
//
//  - Atomicity: a statement that throws inside the transaction leaves the
//    target untouched (probed with `THROW` between the DELETE and the INSERT;
//    the pre-existing rows survived).
//  - Isolation: a reader on a separate connection polling once a second while a
//    transaction held the table deleted for six seconds (via `SLEEP 6s`) saw
//    the old row count the whole time -- never zero, never partial.
//  - Record ids are REBOUND to the target table by `INSERT INTO t (SELECT * FROM
//    t_staging)`: `t_staging:abc` lands as `t:abc`. So the id suffix carries
//    over and nothing needs remapping.
//
// LIMIT WORTH KNOWING
//
// This protects a re-ingest of *equivalent* data. It cannot help a schema
// migration that changes what the read queries match: if the live rows lack a
// column the new filters require, holding on to them serves zero rows just the
// same. That case is inherent, one-off per migration, and is what
// `needsReingest` in openDataRefresh.ts exists to get through quickly.
// -----------------------------------------------------------------------------

/** One table's worth of new rows, replacing whatever that table holds now. */
export interface TableSnapshot {
  table: string
  rows: Array<Record<string, unknown>>
}

const STAGING_SUFFIX = '_staging'

// Table names are internal constants, never user input, but they are
// interpolated into SQL so they get validated anyway rather than trusted by
// convention.
const SAFE_TABLE_NAME = /^[a-z][a-z0-9_]*$/

function stagingName(table: string): string {
  if (!SAFE_TABLE_NAME.test(table)) {
    throw new Error(`snapshotSwap: refusing unsafe table name "${table}"`)
  }
  return `${table}${STAGING_SUFFIX}`
}

const BATCH_SIZE = 500

/**
 * Replace the contents of one or more tables with a new snapshot, atomically.
 *
 * Pass several snapshots together when they are read as a set: Fondi Europei
 * spreads one upstream response across five tables, and a reader must never see
 * three of them updated and two stale. They are moved in a single transaction.
 *
 * `ingested_at` is stamped here rather than left to the live table's
 * `DEFAULT time::now()`, so the timestamp does not depend on how defaults
 * behave for rows created by an INSERT ... SELECT. openDataRefresh reads this
 * field to decide staleness, so it has to be right.
 */
export async function swapSnapshots(snapshots: TableSnapshot[]): Promise<number> {
  if (snapshots.length === 0) return 0
  const now = new Date()
  const staged = snapshots.map((s) => ({ ...s, staging: stagingName(s.table) }))

  let total = 0
  for (const { staging, rows } of staged) {
    await withDbRetry(async (db) => db.query(`DELETE ${staging};`))
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows
        .slice(i, i + BATCH_SIZE)
        .map((r) => ({ ingested_at: now, ...r }))
      await withDbRetry(async (db) => db.insert(new Table(staging), batch))
    }
    total += rows.length
  }

  // One transaction for every table, so a multi-table source cannot be seen
  // half-updated. Idempotent on retry: staging still holds the same rows, so
  // re-running the swap after a transport error reproduces the same result.
  const swap =
    'BEGIN TRANSACTION;\n' +
    staged
      .map(
        ({ table, staging }) =>
          `DELETE ${table};\nINSERT INTO ${table} (SELECT * FROM ${staging});`,
      )
      .join('\n') +
    '\nCOMMIT TRANSACTION;'
  await withDbRetry(async (db) => db.query(swap))

  // Best-effort tidy-up. Leaving staging rows behind is harmless (the next
  // ingest wipes them first) but it doubles the on-disk size of the widest
  // table, so it is worth doing and worth a warning when it fails.
  try {
    await withDbRetry(async (db) =>
      db.query(staged.map(({ staging }) => `DELETE ${staging};`).join(' ')),
    )
  } catch (err) {
    console.warn(
      '[snapshot] could not clear staging tables (harmless, next ingest will):',
      err instanceof Error ? err.message : err,
    )
  }

  return total
}
