# Parlamento read-path performance

## History

### 2026-08-16 -- /odg/search: the real cost was string::lowercase, not link traversal

A code review flagged `/odg/search` for filtering on `seduta_id.body_status`,
`seduta_id.legislatura` and `seduta_id.chamber` and sorting by `seduta_id.data`
-- four record-link dereferences per row over 212,939 odg rows, the antipattern
this file and `server/routes/parlamento.ts` warn about repeatedly. The endpoint
took ~2.5-2.8s against a header comment claiming "<50ms".

**Benchmarking the hypothesis proved it wrong.** Measured on the live corpus:

| query | time |
|---|---|
| `count()`, no predicate | 130ms |
| `titolo CONTAINS $q` | 1147ms |
| `string::lowercase(titolo) CONTAINS string::lowercase($q)` | 2575ms |
| + `legislatura = $leg` (denormalised) | 2667ms |
| + `seduta_id.legislatura = $leg` (traversal) | 2685ms |

The traversal cost **18ms** -- noise. The dominant cost was recomputing a
lowercased copy of every title on every query: ~1.4s of the ~2.5s. The lesson
is the general one: a pattern being a known antipattern elsewhere is not
evidence that it is *this* endpoint's bottleneck. Measure before optimising.

**What was done.** Both, since the traversal is still worth removing on
principle and the denormalised columns are needed for the sort anyway:

1. `parlamento_odg` gained `chamber`, `legislatura`, `data` (immutable facts
   about the owning seduta -- no sync hazard) and `titolo_lower` (titolo
   pre-lowercased at ingest). Written by all three body-pass session ingests;
   existing rows filled by `server/scripts/backfill-odg-denorm.ts` (212,939
   rows in ~48s).
2. `body_status` was deliberately NOT denormalised: unlike the other three it
   is mutable across ingests. Instead the route resolves the non-ok seduta ids
   up front (5 rows out of 9,817 on the live corpus) and excludes them with
   `seduta_id NOT IN $excluded`, keeping semantics byte-identical.

Result: the count query went 3070ms -> 1443ms (2.1x).

**The remaining bottleneck, and why it is still ~2.5s end-to-end.** The handler
runs two queries. Split:

- COUNT query: **1415ms** -- `GROUP ALL` cannot use an index, so it scans.
- ROWS query (LIMIT 20): **111ms** -- seeks `idx_odg_data` and stops early.

So 93% of the endpoint is the exact-total count. Substring search over 212k
rows has no index that can serve it, so an exact count and a fast response are
mutually exclusive here. Two ways out, both open:

- **Drop the exact total**, using the fetch-one-extra `has_more` trick that
  `/search` and the persona endpoint already use in this same file. Gets the
  endpoint to ~111ms. Costs the exact "59 risultati" readout, which becomes
  "20+". `OdgSearchPage` already renders the `+` form, so the UI needs no
  change. This is a product call, not a technical one.
- **Index odg titles in Meilisearch**, mirroring what interventi search already
  does. ~10ms AND keeps an exact total (`estimatedTotalHits`), plus Italian
  stemming and typo tolerance. Bigger change: new index, ingest sync, sync
  script, fallback path.


## Overview

Optimization pass for the parlamento read API + reader UI, done after the
dataset hit ~100% coverage (camera 100%, senato 99.9%; see
[[Parlamento coverage gaps]]). Goal: cut repeat traffic and DB work on the hot
paths (seduta listing + per-seduta reader) without changing behaviour. The
headline finding was that two of the four planned items were already in place,
so the pass focused on the genuine gaps and one correctness bug it surfaced.

## Current solution

**1. HTTP cache headers (NEW).** `server/routes/parlamento.ts` sets
`Cache-Control` on every GET via a router-level middleware:
`public, max-age=300, stale-while-revalidate=86400` by default (listings shift
when the daily ingest runs). The two per-seduta content handlers (detail +
interventi) override to `max-age=3600` on their SUCCESS path only -- placing the
override there (not in the middleware) keeps a long TTL off 404s for sedute that
may be ingested later. All parlamento data is public open data, so `public` is
correct. This complements the client-side cache (see point 3), not replaces it:
the client cache covers warm in-app nav; these headers cover cold loads, new
tabs, and the shared edge Caddy.

**2. Composite index (NEW).** `idx_seduta_chamber_leg_num` ON parlamento_sedute
FIELDS chamber, legislatura, numero (in `server/lib/schema.ts`). Serves the
per-seduta point lookup that every reader load runs twice (detail + interventi:
`WHERE chamber=$c AND legislatura=$l AND numero=$n`), replacing an
idx_seduta_chamber narrow-then-scan with a direct hit. A leading prefix also
covers (chamber, legislatura) per-leg filters. NOTE: the `/sedute` listing keeps
`WITH NOINDEX` for sort correctness (a date-range filter otherwise makes the
planner serve rows in index/ascending order and silently ignore ORDER BY data
DESC -- the old "interventi stop at February" bug), so this index does not touch
that query.

**3. Client caching -- ALREADY DONE (no change).** `src/hooks/useQuery.ts` is a
bespoke localStorage-backed stale-while-revalidate hook: 24h default TTL,
no-refetch-when-fresh, persists across hard reloads, pagination sequence
guarding, and "stale data beats a broken screen" fallback. Adding
@tanstack/react-query would DUPLICATE this and add bundle weight (RQ doesn't even
persist across reloads out of the box). Deliberately NOT added.

**4. Route code-splitting -- ALREADY DONE (no change).** `src/App.tsx` lazy()-
loads every data page with Suspense; HomePage is eager. Build confirms clean
chunking: each page is its own chunk, Recharts isolated in a ~409KB chunk loaded
only on chart pages, vendor split out.

**5. Reader completeness fix (NEW, in lieu of virtualization).** The reader
(`SedutaPage.tsx`) renders the whole transcript as ONE continuous document --
anchor deep-links (`#int-86`), the index sidebar's odg/oratore jumps, and native
Ctrl+F all depend on every block being in the DOM. Virtualization would break all
three for a marginal DOM win on 0.6% of sedute, so it was REJECTED (the inline
choice is documented in the component). But reading it surfaced a real bug: the
reader fetched only `fetchInterventi(..., 1, 1000)` and the backend capped
pageSize at 1000, silently truncating the 57 sedute with >1000 interventi (max
2885 = camera/13/277). Fix: raised the backend interventi pageSize ceiling
1000->5000 and the reader's `READER_FETCH_LIMIT` to 5000. camera/13/277 now
returns all 2885 (3.4 MB raw; one-time fetch, now both client- and HTTP-cached,
gzips small at the edge). InterventoBlock is already React.memo'd with CSS-var
typography, so rendering a few thousand small text blocks is fine.

## Open questions

- The main eager chunk is ~146KB gzip (React + router + Layout + shared UI).
  Acceptable; not chased further this pass.
- 3.4 MB raw for the largest seduta relies on edge gzip/brotli to be cheap over
  the wire. Caddy handles compression in prod. If a future seduta dwarfs 2885,
  revisit (windowed fetch + a virtualization scheme that preserves anchors/find).

## History

- **2026-06-18** -- Ran the pass (task #27). Added cache headers + the composite
  index; found React Query + code-splitting already covered; rejected reader
  virtualization (UX conflict) and instead fixed the >1000-interventi truncation.
  Verified: backend 92 tests + frontend 35 tests pass, tsc + eslint clean, prod
  build clean, camera/13/277 returns 2885, cache headers live (listing 300 /
  detail 3600 / 404 stays 300), index applied at boot.
