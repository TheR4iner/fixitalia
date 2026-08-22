# Parlamento body-pass atomicity (DELETE+INSERT not transactional)

## Overview

The Camera and Senato body-pass ingests open with:

```
DELETE parlamento_odg WHERE seduta_id = $id;
DELETE parlamento_interventi WHERE seduta_id = $id;
DELETE parlamento_riferimenti WHERE seduta = $id;   -- Camera only
```

and then spend 1-15s parsing the transcript and inserting rows, before
writing the seduta's final `body_status` / `interventi_n` row at the
end. None of this is wrapped in a SurrealDB transaction. A crash, OOM,
container restart, or socket-error-after-retry between the DELETE and
the final UPDATE leaves the seduta in one of these broken states:

1. **Empty children, stale `body_status = "ok"`.** Listing UI shows a
   non-zero `interventi_n` but the reader gets nothing.
2. **Partial interventi, no refs, stale `body_status = "ok"`.**
   `listPending()` skips the seduta because status looks fine.
3. **Full children, missing counter/status update.** Benign:
   pagination falls back to `count()` when `interventi_n` is null.

The orchestrator's `listPending()` filter (`body_status != "ok"`)
doesn't catch (1) and (2) on the next tick, so the broken seduta needs
manual `--refresh` to recover. There's no self-healing today.

## Current solution (option C, 2026-05-16)

**Status-machine recovery, no transaction.** Set
`body_status = "ingesting"` *before* the DELETE, write the final status
at the very end, include `"ingesting"` in `listPending()`'s filter.
This makes a crashed run self-heal on the next orchestrator tick.

This is the cheap, ~10-line patch. Trade-offs:

- **Pro**: no locks, no transaction overhead, no schema changes.
  Recovery cost on the next run is identical to a normal `--refresh`
  of one seduta.
- **Con**: still not atomic in the formal sense. If two operators run
  ingest concurrently against the same seduta, they race. The status
  flag mitigates but does not eliminate this -- both could read
  `body_status = "pending"` simultaneously, both write
  `"ingesting"`, both run the DELETE. We accept this because we have
  exactly one ingest writer (the scheduler) and operator-triggered
  re-runs are rare and supervised.

## Why not option A (SurrealDB BEGIN/COMMIT transaction)

On SurrealDB v2.1.4, transactions are pessimistic single-writer locks
on the touched tables. A 5-15s body-pass transaction would block:

- the daily counters bump (`bumpMandatoInterventi`),
- the refs pass running on a different seduta,
- any read query that touches the same tables under MVCC contention.

The cure is worse than the disease on document-style workloads.

## When to revisit option B (staging table swap)

The staging-table-and-swap approach (ingest into
`parlamento_interventi_staging`, then `INSERT INTO ... SELECT FROM
staging` + DELETE in a final short transaction) becomes the right
answer when **any of these triggers fire**:

- An admin UI or operator-facing maintenance page is planned that
  allows triggering a per-seduta re-ingest while users are reading.
  The current status-machine approach has a visible window where the
  seduta is empty; the staging approach hides that window.
- Concurrent ingest from more than one process (e.g. a worker pool
  splitting sedute) lands on the roadmap. Status-machine recovery
  doesn't handle that race; staging-table swap does.
- We observe stale-state user-facing bugs in production that the
  status-machine approach didn't catch (the symptom would be: a
  seduta loads with an empty reader despite `body_status = "ok"`).

Until one of those triggers fires, the status-machine approach is
sufficient. A future migration to option B is non-breaking: the read
path doesn't care which write path produced the rows.

## Open questions

- Should `"error"` sedute also be auto-retried by `listPending()`?
  Today they're skipped, which is correct for systematic parse
  failures (re-running fixes nothing) but wrong for transient socket
  errors (a re-run would succeed). Possible refinement: distinguish
  `body_error_kind = "transient"` vs `"parse"` and only auto-retry
  transient ones.
- The `"ingesting"` status will be visible to the reader for the
  duration of an ingest run. If the SedutaPage renders something
  reasonable for this state (e.g. "Loading transcript from Senato..."
  instead of "0 interventi"), users see less of a glitch during the
  06:00 nightly run.

## History

- **2026-05-16** -- Adopted option C (status-machine recovery) as the
  short-term answer. Option B (staging table swap) deferred until an
  admin UI, concurrent ingest, or stale-state bug forces the issue.
  Decision driven by the same reasoning that made `withDbRetry()` a
  single retry rather than a loop: prefer recoverable broken states
  over locks that block other writers.
