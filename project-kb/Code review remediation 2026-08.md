# Code review remediation 2026-08

## Overview

Full-codebase review (`/webdev:review`, ~27k lines) followed by a fix-everything
pass. This note records the findings whose *reasoning* is worth keeping --
mostly the ones where the obvious diagnosis was wrong, or where the fix
established a pattern later work should follow. Per-topic detail lives in the
topic notes; see [[Parlamento read-path performance]] for the `/odg/search`
benchmark story and [[Le tue tasse simulator]] for the cuneo-fiscale change.

## Current solution

### The ESLint gap (the highest-leverage finding)

`eslint.config.js` scoped every rule block to `files: ['src/**/*.{ts,tsx}']`.
Flat config skips files that match no config object, emitting only a per-file
`File ignored because no matching configuration was supplied` warning. So
`npm run lint` exited 0 while silently skipping the **entire 14.5k-line
`server/` tree**. Two `eslint-disable` comments already sat in `server/`,
showing the gap was never intentional.

Adding a `server/**/*.ts` block (Node globals, no React plugins) surfaced 12
real errors immediately. Five were in throwaway debug scripts (deleted); the
rest were `no-useless-escape`, `prefer-const`, and an *unused* eslint-disable
directive in `server.ts` that had never done anything.

**Lesson:** a green lint run proves nothing unless you have confirmed the linter
can see the files. `npx eslint --no-ignore <file>` tells you what it thinks.

### Parameter parsing is now centralised and strict

`server/lib/http-params.ts` holds `clampInt` (was duplicated byte-identically in
four route files, plus a fifth variant in `scheduler.ts`) and strict parsers
that distinguish "not supplied" from "supplied but malformed".

Malformed filters used to return an unfiltered HTTP 200, which reads to the
caller as "the filter matched everything". `?leg=abc` now 400s. The nastiest
case was `/refs/legge/:tipo/:anno/:numero` with a non-numeric anno: `Number()`
produced `NaN`, which was bound into the query, matched nothing, and serialised
back as `"anno": null` -- indistinguishable from a genuinely timeless law with
no citations. Routes map `BadParamError` to a 400 via a router-scoped error
handler so every endpoint answers malformed input identically.

### SurrealDB returns `DateTime`, not `Date`

When denormalising the seduta date onto odg rows, the obvious typing
(`data: Date`) type-checked but was wrong: the SDK hands back its own
`DateTime` wrapper class for a `datetime` column. It has `.toDate()`. Verified
empirically rather than assumed -- `d instanceof DateTime` is true,
`d instanceof Date` is false. Insert sites call `.toDate()`.

### Dead code that was silently load-bearing

`loadInterventiForPersona` still built a BM25 predicate (`testo @0@ $q`) years
after the BM25 index was retired for Meilisearch. It was unreachable as a
query -- but the substring fallback rewrote the WHERE clause by **string
equality against the literal `'testo @0@ $q'`**. Change that string and the
fallback stops filtering by search term while still returning HTTP 200. Removed
the dead branches and replaced the sentinel with an explicit predicate list.

**Lesson:** dead code that a string comparison depends on is not dead, it is
load-bearing and undiscoverable.

### Frontend: two real bugs behind plausible-looking code

1. **`useQuery.refetch()` permanently disabled TTL caching.** The freshness
   check was `if (isFresh && refreshNonce === 0)`. `refreshNonce` is component
   state that never resets, so one click of a retry button left it >0 forever
   and every later key change (page turn, filter tweak) bypassed the TTL for
   the life of the component. Now compares against the nonce the last fetch
   actually ran under. Regression test in `useQuery.test.ts`.

2. **The localStorage cache was append-only.** One entry per query key forever,
   with `JSON.stringify(cache)` over the whole thing on every write. The reader
   fetches whole sedute (`pageSize=5000`, full `testo`), so a few transcript
   visits could exceed the ~5MB quota -- at which point `setItem` throws, the
   catch logs a warning nobody reads, and persistence silently stops for the
   session. Now: per-entry ceiling (256KB, so one transcript cannot evict every
   cheap listing) plus LRU eviction against a 3MB budget. Eviction is computed
   on a copy, so the in-memory cache stays complete for the session and only
   what survives a reload is trimmed.

### The O(n^2) render

`SedutaPage` ran `odg.find(...)` + `interventi.findIndex(...)` +
`interventi.indexOf(it)` **per intervento**, to decide whether an OdG heading
goes above each block. On the largest seduta (2,885 interventi) that is ~16.6M
array steps per render, on the one page that otherwise works hard for render
performance (`React.memo`, CSS custom properties instead of prop drilling). Two
precomputed `Map`s in `useMemo` make it linear.

### React keys omitted `legislatura`

Seduta numbers restart at 1 each legislature, so `${chamber}-${numero}` is
ambiguous. Worst on `SearchResultsPage`, where results are explicitly
cross-legislature and relevance-ranked, so colliding keys land on one page and
React reuses the wrong DOM node. The codebase's own `sedutaUrl` doc already
stated the key is `(chamber, legislatura, numero)`.

## Open questions

- `/odg/search` still spends 93% of its time on the exact-total count. Two
  documented ways out (drop the exact total, or index odg titles in
  Meilisearch); the first is a product call. See
  [[Parlamento read-path performance]].
- `tmp_db_bak/` holds 2.4 GB in the working tree. Gitignored, but worth
  clearing given past disk-pressure incidents.
- The `bonusCuneoFiscale` argument fix (see below) changes computed output for
  a band of employee incomes and should get a domain check before it ships.

## History

### 2026-08-16 -- review + full remediation

Findings fixed: ESLint server gap; O(n^2) reader render; unbounded localStorage
cache; `refetch` nonce bug; duplicate React keys (2 pages); `LeggePage` filter
state moved from `useState` to the URL (back button and link-sharing were
broken there alone); dead BM25 path; `START`/`LIMIT` moved to bind parameters
(safe in practice via `clampInt`, but the file's own header claimed an
invariant the code did not hold); `/odg/search` denormalisation +
`titolo_lower`; `clampInt` x4 and the legislature list x5 and chamber parsers
x6 consolidated; shared `Pagination` component replacing 4 drifted copies;
~15 hardcoded Italian strings moved into `src/i18n/it.ts`; `getJson` gained a
30s timeout; five throwaway debug scripts deleted.

`bonusCuneoFiscale` was called with `redditoComplessivo` for a parameter named
`redditoLavoroDipendente`, despite the module header warning the two must never
be conflated. Per L. 207/2024 art. 1 c. 4-5 eligibility is gated on reddito
complessivo but the percentage applies to the gross employment income. At RAL
21.500 the old code paid ~937 EUR where the correct answer is 0 (complessivo
~19.524 slips under the 20.000 ceiling the gross exceeds). Now a two-argument
function; regression test added. **Flagged for domain review.**

Verification: ESLint clean across both trees, `tsc --noEmit` clean on both,
93 frontend + 92 backend tests passing, production build green, all section
endpoints smoke-tested, and one real seduta re-ingested end-to-end to prove the
odg write path (19 odg rows, all denormalised columns correct).
