# Meilisearch search layer

## Overview

Dedicated full-text search engine for the parlamento corpus, **replacing the
retired SurrealDB BM25 index** (`idx_int_text`). SurrealDB stays the source of
truth; Meilisearch is a disposable search replica that can be rebuilt from
scratch at any time and is kept current incrementally by the ingest pipeline.

**Status: IMPLEMENTED (2026-06-16).** Single index `parlamento_interventi` over
~1.85M speech rows. Sub-second ranked search with cropped + `<mark>`-highlighted
snippets, typo tolerance, Italian stemming, and chamber/leg/persona facets.

## Why BM25 was retired

- Its rebuild OOM-killed every time on this corpus: a `DEFINE INDEX` is one
  transaction that materialises the whole index resident at COMMIT (>40 GiB,
  inflated by HIGHLIGHTS), past RAM+swap on the 31 GiB host. Not fixable by
  adding memory.
- Its postings + HIGHLIGHTS blobs were a major contributor to the 401 GB blob
  bloat (see [[SurrealDB blob bloat]]).
- `search::score()`/`search::highlight()` walk the full posting list, so common
  terms were multi-second even before bloat, and unusable (>16 min, never
  returned) on the bloated HDD store.

## Architecture (as built)

```
SurrealDB (source of truth)            Meilisearch (search replica, port 7700)
parlamento_interventi  ── per-seduta ──> index: parlamento_interventi
                          replace                (full testo, denormalised
                                                  seduta/persona/odg fields)
```

- **One index only.** Speaker autocomplete (`/persona/search`) stays a cheap
  SurrealDB substring scan over the 4184-row `parlamento_persona` table -- a
  second Meili index there would add a sync pipeline for zero user-visible gain.
  The 1.85M-row intervento text search is the only thing BM25 was needed for.
- **Full `testo` is indexed** (not a 300-char excerpt as the old plan said), so
  Meili crops + highlights a snippet around the actual match even when it sits
  deep in a long speech. ~1.6 GB of text indexes fine.

## Files

- `server/lib/meilisearch.ts` -- REST client (global `fetch`, no SDK). Index
  settings, the shared `INTERVENTO_DOC_PROJECTION` + `mapInterventoRow` (one
  mapper for both the cold sync and the hook, so they emit identical docs),
  write ops (`addInterventiDocs`, `deleteSedutaDocs`), `searchInterventi`,
  `ensureInterventiIndex`, `waitForTask`, `meiliHealth`, `MeiliError`.
- `server/lib/ingest/parlamento/meiliSync.ts` -- `syncSedutaToMeili(sedutaId,
  label)`: per-seduta delete-then-upsert, best-effort (logs, never throws).
- `server/scripts/meili-sync.ts` -- one-shot cold (re)build. `--fresh` deletes
  the index first.
- Wired into `cameraSession.ts`, `senatoSession.ts`,
  `cameraHistoricalSession.ts` (after the body-pass insert) and `server.ts`
  (`ensureInterventiIndex` at boot, best-effort).
- Compose: `fixitalia-meili` in `docker-compose.override.yml` (dev,
  `MEILI_ENV=development`, no key, host port 7711) and `docker-compose.prod.yml`
  (prod, `MEILI_ENV=production`, `MEILI_MASTER_KEY` from `.env`, internal net).

## Index settings (parlamento_interventi)

- primaryKey `id` (sanitised from the SurrealDB record id: non `[A-Za-z0-9_-]`
  -> `_`). `sid` keeps the original record-id string.
- searchable: `testo`, `oratore_nome`, `odg_titolo` (in priority order).
- filterable: `chamber`, `legislatura`, `gruppo`, `oratore_id_persona`,
  `seduta`, `seduta_data`. (`seduta` backs the per-seduta delete; `seduta_data`
  is epoch seconds for range filter + sort.)
- sortable: `seduta_data`. Italian stopwords. Default ranking rules.

## Route behaviour

- `/api/parlamento/search`:
  - q-only -> **Meili** (`mode: 'meili'`), chamber as a facet filter, crop +
    `<mark>` highlight. Falls back to the SurrealDB substring scan (`mode:
    'substring'`) on `MeiliError` (engine down / mid-rebuild).
  - cita-only -> SurrealDB `parlamento_riferimenti` (`mode: 'cita'`, unchanged).
  - q + cita -> SurrealDB substring (cita filter lives in riferimenti, which
    Meili docs don't carry; rare, bounded by the cita id set).
- `/persona/:chamber/:idPersona?q=` -> Meili filtered by `oratore_id_persona`
  (+ leg / date), substring fallback. Replaces the always-failing BM25 attempt.

## Cold-sync performance gotcha (important)

The first sync version SELECTed per seduta with `seduta_id.*`, `mandato_id.*`,
`odg_id.*` projections -- each of 1.85M rows triggered 3 random record-link
reads, thrashing the 2 GB block cache. It decelerated from ~1.3 to ~0.3
sedute/s, heading for ~7 h. Fix: resolve the three small dimension tables
(sedute, mandati, odg) into in-memory JS maps ONCE, then read interventi
per-seduta with **no link traversal** and assemble doc fields from the maps.
Result: ~8 sedute/s, steady, full rebuild in ~20 min. Same lesson as: never traverse record links in a hot loop;
resolve ids up front and bind them. (Also: bind the RecordId, not its string,
into `WHERE seduta_id = $sid`, or it matches nothing.)

## Operations

- Rebuild from scratch: `dev exec backend npx tsx scripts/meili-sync.ts --fresh`.
- A seduta left stale by a failed incremental sync is recovered by re-ingesting
  it (`--refresh`) or a full rebuild.
- Prod master key: `MEILI_MASTER_KEY` in `.env` (compose substitution, like the
  SurrealDB creds), >=16 bytes, `openssl rand -base64 32`. Manage via a GitHub
  repo secret + deploy sync, same pattern as the other deploy-time values
  (see the local operator notes under `project-kb/private/`).

## Open questions / future

- Speaker autocomplete could move to Meili for typo tolerance if the substring
  scan ever feels limiting (not currently).
- Reconciliation: a failed incremental sync currently relies on a manual
  rebuild. If drift becomes a concern, add a light "sync recently-changed
  sedute" pass to the daily scheduler.
- `estimatedTotalHits` is capped at Meili's default `maxTotalHits` (1000),
  which suits the "20+" UI semantics; raise the index setting if exact large
  totals are ever needed.

## History

- **2026-06-16** -- Implemented. Promoted the compact GC-rebuilt SurrealDB to
  live (see [[SurrealDB blob bloat]]), added the Meili sidecar (dev+prod),
  client, per-seduta hook, cold-sync script, and rewired `/search` +
  persona-detail search to Meili with SurrealDB substring fallback. Scoped to a
  single interventi index. Cold sync hit the link-traversal perf trap; fixed
  with up-front dimension maps (~20 min rebuild). 92 backend tests + lint green.
- **2026-06-13** -- Revised priority downward after auditing actual DB content
  (the 300 GB was blob GC garbage, not real text). Plan kept for when triggered.
