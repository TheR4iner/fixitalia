# BM25 index blocks parlamento_interventi inserts (RESOLVED in SurrealDB v2.6.5)

## Status (2026-05-16)

**Fixed in SurrealDB v2.6.5.** A probe (`server/scripts/probe-bm25-insert.ts`)
inserts 50 rows into an isolated table with the same BM25 SEARCH index
shape and confirms the socket-crash is gone. All inserts land, the
post-insert BM25 query returns scored + highlighted rows. The
wipe-bodies index-drop step and the `bm25-rebuild.sh` post-ingest
rebuild are no longer required.

The history below describes the original v2.1.4 behavior; kept for
context in case a future SurrealDB regression reintroduces it (the
probe script will catch it on the next routine version bump).

## Overview (v2.1.4 behavior, since fixed)

On SurrealDB v2.1.4, while `idx_int_text` (the `SEARCH ANALYZER analyzer_it
BM25 HIGHLIGHTS` index on `parlamento_interventi.testo`) is defined, every
`INSERT INTO parlamento_interventi` crashes the SurrealDB HTTP/WS
connection mid-flight. The SDK surfaces this as `fetch failed` /
`UND_ERR_SOCKET` from undici, with no row landing. The crash is in the
index update path, not in the WHERE evaluator, so reads keep working but
**writes are silently lost** unless the caller checks the connection
state.

Net effect on a full re-ingest:

- `parlamento-wipe-bodies.ts` wipes `parlamento_interventi`.
- `ingest.ts parlamento` runs end-to-end, every batch insert raises a
  socket error, the per-row fallback re-raises the same socket error,
  the seduta is marked `body_status = "error"` -- and the table stays
  empty.
- The orchestrator's status summary looks like a parsing regression
  (hundreds of "error" sedute) but the cause is the index, not the
  parser.

It is specific to the BM25/HIGHLIGHTS index. Plain B-tree indexes on
the same table (`idx_int_seduta`, `idx_int_mandato`, `idx_int_oratore`
before its removal) do not trigger it. CONCURRENTLY-built BM25 indexes
on smaller tables behave the same way: it's the runtime maintenance
path, not the build itself.

## Historical workaround (v2.1.4 only, no longer in use)

Out-of-band rebuild. The index was treated as an **append-only
artifact** that did not coexist with ingest:

1. **Before a full body re-ingest**, drop the index.
   `server/scripts/parlamento-wipe-bodies.ts` does this as its first
   step:

   ```ts
   await runQuery(`REMOVE INDEX IF EXISTS idx_int_text ON parlamento_interventi;`)
   ```

2. **Run the ingest** normally. Without the index, `INSERT` succeeds.
   `/api/parlamento/search` falls back to non-BM25 mode during this
   window (it already handles `searchError` gracefully -- the route
   returns rows ordered by recency with no scoring/highlight).

3. **After the ingest finishes**, rebuild the index using
   `./bm25-rebuild.sh` from the repo root. It issues:

   ```sql
   DEFINE INDEX idx_int_text ON parlamento_interventi
     FIELDS testo SEARCH ANALYZER analyzer_it BM25 HIGHLIGHTS CONCURRENTLY;
   ```

   then watches `INFO FOR INDEX idx_int_text` until `building.status =
   "built"`. CONCURRENTLY is mandatory: a non-concurrent build locks the
   table for the duration. Throughput on the full leg-19 corpus is ~30
   docs/sec (initial ~90/sec, halves as tree depth grows), ~60-70 min
   wall-clock for ~112k rows.

4. **Verify** with `./bm25-rebuild.sh --verify`. It runs a BM25 sample
   query and prints score + `<mark>` snippet.

The build is interruptible: Ctrl+C the watch loop, the build keeps
running on the server side. Re-attach with `./bm25-rebuild.sh
--watch-only`. Cancel with `--abort`.

## Open questions

(All resolved by the v2.6.5 upgrade. Kept here as a record of what
*used* to be on the table.)

- ~~Single-row inserts crash the same way batch ones do, so the per-row
  fallback doesn't help against this bug.~~ Moot: inserts succeed.
- ~~Upstream fix~~ landed in (or by) v2.6.5; the probe confirms.
- ~~Daily auto-fetch interaction with a live index~~ no longer a
  concern -- the scheduler can hit `parlamento_interventi` freely.

If a future SurrealDB version regresses, run
`scripts/probe-bm25-insert.ts` to detect it; the script is a 2-second
canary against this specific class of failure.

## History

- **2026-05-16** -- Upgraded the sidecar pin from `v2.1.4` to `v2.6.5`.
  Wiped `server/data/surreal`, recreated the container, re-applied the
  schema on an empty DB, then ran `probe-bm25-insert.ts` to confirm the
  insert path works with the BM25 SEARCH index live. Result: 50/50
  inserts succeeded, post-insert search query returned scored rows with
  `<mark>` snippets. Retired the index-drop in
  `parlamento-wipe-bodies.ts` and the comment that referenced
  `bm25-rebuild.sh` as a mandatory post-wipe step. The rebuild script
  stays in the repo for first-time index builds and disaster recovery
  but is no longer on the routine path.
- **2026-05-15** -- Documented after a re-ingest run of camera/19/321
  produced 0 interventi while the parser worked correctly in isolation.
  Root cause traced to the BM25 index update path crashing the undici
  socket on `INSERT INTO parlamento_interventi`. Mitigation: drop the
  index in `parlamento-wipe-bodies.ts`, rebuild via `./bm25-rebuild.sh`
  after the ingest. Verified end-to-end: same seduta re-ran cleanly to
  269/269 interventi after the index drop. Schema also cleaned up the
  orphan `oratore_id` FIELD + `idx_int_oratore` INDEX left over by
  `REMOVE TABLE parlamento_oratori` (REMOVE TABLE leaves FIELD/INDEX
  references intact in v2.1.4).
