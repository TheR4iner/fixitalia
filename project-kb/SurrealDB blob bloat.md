# SurrealDB blob bloat (RocksDB blob GC disabled)

## Overview

The SurrealDB data directory reached **260 GB** while
holding only **~1.6 GB of actual transcript text** (1,608,062 interventi ×
~1 KB mean `testo`). A ~150× blow-up. The bulk is **dead RocksDB blob garbage**,
not real data and not the BM25 index (which is at most a few GB).

Measured 2026-06-13 (mid senato ingest):

| Component | Size |
|-----------|------|
| `.blob` files (3,503) | 254.6 GB |
| `.sst` (keys + small values + index trees) | 4.1 GB |
| `.log` (WAL) | 1.1 GB |
| Logical raw transcript text | ~1.6 GB |
| Live BM25 index (`idx_int_text`) | a few GB at most |
| **Dead blob garbage (the rest)** | **~240+ GB** |

## Root cause

SurrealDB v2.6.5 runs RocksDB with **BlobDB** (key-value separation): any value
≥ `min_blob_size` (4096 B) goes to a `.blob` file. Two defaults make garbage
accumulate forever:

- `enable_blob_garbage_collection = false`  ← the core problem
- `blob_garbage_collection_force_threshold = 1.0` (a blob file is only collected
  when it is *100%* garbage — effectively never)

Every rewrite of a ≥4 KB value (long speeches, and especially the BM25
postings/HIGHLIGHTS structures, which are rewritten on every re-index) orphans
the old blob, and nothing reclaims it. This workload rewrites constantly:
- block-torched senato reprocessing (leg 16 re-run ~3×, and the original
  multi-leg historical reruns)
- the 146,912-row speaker-linker `mandato_id` updates (see camera backfill)
- `--refresh` re-parses
- repeated ingest restarts

The `HIGHLIGHTS` option on `idx_int_text`
(`BM25(1.2,0.75) ... HIGHLIGHTS`) stores per-term positions/offsets for snippet
highlighting — large index blobs, rewritten on every re-index. A multiplier on
the garbage.

The miss: this should have been caught at ~85 GB (when it filled `/home` and the
DB was moved to a larger disk) by asking "why 85 GB for ~1.6 GB of text?" instead
of just relocating it.

## DECIDED METHOD: export + fresh rebuild (2026-06-14)

Senato ingest is complete; DB has grown to **401 GB** (senato added ~140 GB,
mostly more garbage). User chose the **export + rebuild** method (safest: the
original DB is never modified). Execution scheduled for the **morning of
2026-06-15** (the import is multi-hour). Everything is prepped:

- **Runbook**: `~/temp/reclaim-runbook.md` — full step-by-step, sudo steps marked.
- **New instance**: `docker-compose.reclaim.yml` (GC-enabled SurrealDB on port
  8021, pointed at a fresh data directory).
- **Baseline** (verify after import): sedute 9531, Σinterventi_n 1,850,953,
  Σodg_n 200,208, persona 4184, mandato 6276, appalti 48040, etc. Exact
  interventi/odg/riferimenti counts captured overnight into
  `~/temp/baseline-counts.txt`.
- Validated: `/export` streams clean surql; export batches ~1000 records/INSERT
  (so do NOT verify by grepping `^INSERT`); `import` subcommand works; network
  `fixitalia_default`; 1.3 TB free.

Flow: export live (read-only) → import into clean GC instance → verify counts ==
baseline → swap data dir + add GC env to override.yml → confirm app → delete the
old 401 GB dir. Original kept as `.OLD-bak` backup until confirmed.

## Alternative considered (in-place GC + compaction)

Rejected as less safe (modifies the original; forcing the compaction needs the
external rocksdb `ldb` tool at a matching version — fiddly/risky). Kept here for
reference. Would have been: finish the run first, then in one window:

1. Set in `docker-compose.override.yml` (surreal `environment:`):
   - `SURREAL_ROCKSDB_ENABLE_BLOB_GC: "true"`
   - `SURREAL_ROCKSDB_BLOB_GC_FORCE_THRESHOLD: "0.25"` (collect files ≥25% garbage)
   - consider `SURREAL_ROCKSDB_BLOB_COMPRESSION_TYPE` (zstd) to shrink future blobs
   - consider raising `SURREAL_ROCKSDB_MIN_BLOB_SIZE` so small values stay in SST
2. Restart surreal.
3. Force a full compaction to reclaim the existing ~240 GB (GC happens during
   compaction; a manual full CompactRange forces it immediately rather than
   waiting for leveled compaction to churn through on its own).
4. Re-measure `du` on the data dir; expect a drop to roughly single-digit GB +
   live index.
5. Separately reconsider whether `HIGHLIGHTS` on `idx_int_text` is worth its
   footprint, or whether a smaller `*_ORDER`/cache config suffices.

Full env knob list (from the v2.6.5 binary): `SURREAL_ROCKSDB_ENABLE_BLOB_FILES`,
`_MIN_BLOB_SIZE`, `_BLOB_FILE_SIZE`, `_BLOB_COMPRESSION_TYPE`, `_ENABLE_BLOB_GC`,
`_BLOB_GC_AGE_CUTOFF`, `_BLOB_GC_FORCE_THRESHOLD`, `_BLOB_COMPACTION_READAHEAD_SIZE`.

## Open questions

- Does SurrealDB v2.6.5 expose a way to trigger a manual full compaction (SQL or
  CLI), or must it be done offline with `ldb compact` against a stopped DB?
- Will enabling GC + threshold 0.25 reclaim retroactively on the next compaction,
  or is an explicit full CompactRange required? (Assume the latter; plan for it.)

## Execution notes (deferred-index rebuild)

The naive "import the full dump into a GC instance" **OOM-kills the import**. Two
crashes (10 GB cache @18 GB limit ~1h/150k rows; 4 GB cache @24 GB limit, 14.45
GiB at 117k rows) proved memory grows with rows inserted, so it OOMs at *any*
fixed limit. Cause: inserting into a table with a **live BM25 index** forces
incremental index maintenance whose in-memory build state accumulates unbounded
across a backpressure-free bulk import. The original DB never hit this because it
built `idx_int_text` slowly during the long ingest, with natural network/parse
backpressure between writes.

**Fix — defer the index:**
1. Export live DB: `curl /export` → `dump.surql` (2.6 GB; 401 GB → 2.6 GB
   logical confirms ~99% was dead garbage).
2. Strip ONLY the `DEFINE INDEX idx_int_text` line (saved separately to
   `idx_int_text.surql`) to make a data-only dump. **GOTCHA: do NOT use `grep -v`**
   — these dumps have multi-MB single-line `INSERT` batches and grep silently
   truncated every long line (output was 704 MB vs 2.6 GB, same line count). Use a
   byte-faithful method (`head -n L-1` + `tail -n +L+1`, the index is one
   self-contained line) and **verify output size == input minus exactly the line
   length** (here 269 B).
3. Import the data-only dump → loads with **bounded memory (<5 GiB), ~6 min** for
   1.85M interventi, no OOM.
4. Build the index once over the static table: `DEFINE INDEX idx_int_text ...`.
   This is **synchronous/blocking** in v2.6.5 (index invisible until the build
   commits at the end; `INFO FOR INDEX` errors "does not exist" while building).
   Memory stays **flat (~6.5 GiB)**, CPU ~100% single-core (Italian Snowball
   stemming), multi-hour. The standalone build flushes postings to RocksDB
   periodically, so it does NOT accumulate like the insert path.

Verify-then-trust everywhere: a background bash wrapper's "exit 0" reflects the
wrapper's trailing echo, not the import client's real exit — confirm via row
counts + the client's captured rc, never the notification. (`rm` on this host is
aliased to `trash-put`, which fails across volumes; use
`command rm`.)

## History

- **2026-06-16 (resolution)**: Abandoned the BM25 rebuild entirely. The
  deferred `DEFINE INDEX` also OOM'd at COMMIT (the build materialises the whole
  index resident at once), and a BM25 query on the bloated store never returned
  (>16 min, HDD-bound). Decision: drop SurrealDB full-text search and move it to
  a **Meilisearch sidecar** (see [[Meilisearch search layer]]). **Promoted the
  compact DB to live**: repointed the `fixitalia-surrealdb` service's bind mount
  at the fresh compacted directory and enabled blob GC
  (`ENABLE_BLOB_FILES/ENABLE_BLOB_GC=true`, `BLOB_GC_FORCE_THRESHOLD=0.25`) in
  `docker-compose.override.yml`. Verified live counts == baseline (interventi
  1,857,552 + 2 leg-19 sedute the scheduler then caught up; sedute 9533; persona
  4184). The **old 401 GB directory is retained untouched** as a cold backup -- reclaim it explicitly later once the compact
  store is proven. The compact DB has only the 2 btree indexes (no FTS); search
  is served by Meili with a SurrealDB substring fallback.
- **2026-06-16**: Resumed on the host. Discovered the prior data-only dump was
  grep-truncated; regenerated byte-faithfully (verified -269 B). Wiped/re-created
  the reclaim instance, imported data-only in ~6 min — **all counts match
  baseline exactly** (interventi 1,857,552; odg 200,241; riferimenti 165,658;
  sedute 9531; persona 4184; appalti 48040; fondi 1/36/20/5/11). Launched the
  synchronous BM25 build (memory-stable ~6.5 GiB). Pending: build completion +
  search smoke-test → swap → reclaim.
- **2026-06-15**: Export succeeded (2.6 GB). Full-dump import OOM'd twice →
  diagnosed live-index maintenance as the cause → pivoted to the deferred-index
  approach above. A session restart dropped Claude into the sandbox container
  (no docker, host ports, or the data volume), blocking the host-side work until the
  user moved the session back onto the host.
- **2026-06-14**: Senato ingest done; DB at 401 GB. User chose export+rebuild
  (safest). Prepped everything (runbook, reclaim compose, baseline, overnight
  count job) for a morning run; deliberately did NOT start the multi-hour
  export/import. Validated `/export` + `import` mechanics.
- **2026-06-13**: Discovered during the senato VPN-rotated ingest, prompted by
  the user asking for a text-vs-BM25 breakdown of the 260 GB DB. Measured the
  layout, found `enable_blob_garbage_collection=false` /
  `force_threshold=1.0` as root cause. Decided to hold remediation until the
  senato ingest finishes (user chose option (a)). Wrote this note.
