# Parlamento ref linking

## Overview

Make law / decree / Costituzione / atto Camera (AC) / atto Senato (AS)
references inside transcript interventi clickable. Each reference resolves
to its official document on Normattiva (laws, decrees), camera.it (AC
bills) or senato.it (AS bills).

The hard architectural decision: do parsing **at ingest** (server-side,
results persisted into a queryable `parlamento_riferimenti` table), not
in the React renderer. Reasons:

- Fits the project's "ingest once, render many" ethos.
- Unlocks aggregation queries we will want anyway: most-cited laws,
  per-law page listing citing sedute, faceted search.
- Senato `S.NUM -> idDdl` SPARQL lookups happen once per AS reference,
  not on every reader visit.
- Search snippets get linkified for free via the same data.
- The parser stays as pure server-side TS, never ships in the client
  bundle.

## Current solution

### Schema (`server/lib/schema.ts`)

Two new SCHEMALESS tables:

- `parlamento_riferimenti` -- one row per detected reference. Fields:
  `intervento` (record link), `seduta` (record link, denormalised so
  "all refs in this seduta" is one indexed query), `tipo`
  (`legge`|`decreto.legge`|`decreto.legislativo`|`dpr`|`costituzione`
  |`ac`|`as`), `anno?`, `numero?`, `urn?`, `url?`, `resolve_status`
  (`ok`|`pending`|`failed`), `start`, `end` (char offsets in the
  intervento's `testo`), `raw`, `parser_version`. Indexes on
  `intervento`, `seduta`, `(tipo, anno, numero)`, `resolve_status`.
- `parlamento_senato_ddl_idmap` -- cache of Senato `S.NUM -> idDdl`
  lookups. Fields: `leg`, `numero`, `id_ddl`, `url`, `updated_at`.
  Unique index on `(leg, numero)`.

Two new fields on existing tables:

- `parlamento_interventi.testo_hash` -- sha-1 of testo, computed at
  body-pass insert. Used to detect stale `riferimenti` whose offsets
  no longer match the current testo (in case the body parser ever
  changes whitespace handling).
- `parlamento_sedute.refs_status`, `refs_parser_version` -- per-seduta
  checkpoint so the refs ingest pass can resume and re-extract on
  parser-version bumps.

### Deterministic ref ids

`parlamento_riferimenti` rows use a deterministic id:
`parlamento_riferimenti:[<intervento_id>, <parser_version>, <start>]`.

This makes idempotency a true UPSERT instead of delete-then-insert:
- Re-running the parser on the same intervento with the same version
  produces the same ids -> overwrites in place.
- A version bump produces new ids -> old rows are still valid until
  the per-intervento sweep deletes them.
- No window where a reader request sees zero refs while the ingest
  rewrites the set.

### Parser (`server/lib/parlamento/refs/`)

Pure server-side TS module, no DB / network calls:

```
version.ts      export const PARSER_VERSION = 1
patterns.ts     regex bank
parse.ts        (testo) => RawRef[]
normalize.ts    RawRef -> CanonicalRef ({tipo, anno?, numero?, urn?})
url.ts          (CanonicalRef, ctx) => string|null
                  (Camera deterministic; AS returns null, resolved later)
index.ts
```

`url.ts` for laws / decrees uses the Normattiva URN-NIR scheme:
`https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:{tipo}:{anno};{numero}`.
Year-only URNs work, so we don't require the full date.

`url.ts` for Camera bills uses `idDocumento` directly: it equals the
AC ordinal, verified against `https://www.camera.it/leg19/126?leg=19&idDocumento=N`.

`url.ts` for Senato bills returns null -- AS resolution is deferred.

### Bare "Costituzione" is skipped

Plain "Costituzione" mentions are too noisy to link. Only `art. N (della)
Costituzione` / `art. N Cost.` becomes a reference, with the URN
`urn:nir:stato:costituzione:1947-12-27!~art{N}` so the link lands on the
specific article.

### Senato resolver (`server/lib/parlamento/senato-ddl-resolver.ts`)

`resolveSenatoBill(leg, numero)`:

1. Cache hit on `parlamento_senato_ddl_idmap` -> return.
2. SPARQL against `dati.senato.it/sparql` matching `osr:numero` +
   `osr:legislatura`.
3. On success: persist to idmap, return.
4. On SPARQL failure / no match: return null. Caller marks the ref
   `resolve_status = 'failed'` and the frontend renders it as a fallback
   link to the senato search page.

Concurrency-limited to 4 in flight. Failures don't throw; AS extraction
is decoupled from AS resolution so a flaky SPARQL endpoint doesn't block
the rest of the refs pass.

### Ingest pipeline

Two integration points:

- **Inline in body pass** (`cameraSession.ts`): every newly-inserted
  intervento gets its `testo_hash` + parser run + riferimenti written
  in the same write batch. New sedute land linkified.
- **Sibling subcommand** (`scripts/ingest.ts parlamento refs`): walks
  sedute where `refs_status != 'ok'` OR `refs_parser_version <
  PARSER_VERSION`. Per intervento: skip if `parser_version` matches and
  `testo_hash` unchanged; else re-extract (deterministic ids -> upsert).
  Then collects pending AS refs and resolves them via the SPARQL
  resolver. Marks seduta `refs_status='ok'` on completion. Resumable.

Flags: `--chamber=`, `--legislatura=`, `--reparse` (ignore staleness
checks), `--reresolve` (retry `failed` AS lookups).

### Daily scheduler

`server/lib/scheduler.ts` already runs `ingestParlamento` daily; after
that we fire `parlamento refs --reresolve`. Cheap no-op when nothing to
do; catches drifted parser versions and pending Senato lookups nightly.

### API (`server/routes/parlamento.ts`)

- `GET /sedute/:chamber/:numero/interventi` returns each intervento with
  its `riferimenti[]` (one batched query, joined in app code by
  intervento id).
- `GET /search` adds optional `?cita=tipo:anno:numero` for structured
  filter (no BM25 needed when set without `q`).
- `GET /refs/leggi-piu-citate?chamber=&from=&to=` -- GROUP BY
  `(tipo, anno, numero)` ORDER BY count DESC LIMIT 50. Endpoint shipped
  now, leaderboard page later.

### Frontend

- `src/components/parlamento/Linkified.tsx` -- dumb splicer that takes
  `{text, refs}` and emits a mix of text nodes and `<a>` elements at
  known offsets. No client-side regex, no raw-HTML render path -- pure
  React text/element nodes, same XSS posture as the existing reader.
- `InterventoBlock.tsx` -- replace the bare `{p}` text node with
  `<Linkified text={p} refs={refsInThisParagraph}/>`. Offset arithmetic
  to slice paragraph-local refs from intervento-level refs is memoised
  once per intervento.
- `services/parlamento.ts` -- extend `Intervento` type with
  `riferimenti: Riferimento[]`.
- Search snippet linkification deferred (overlap with `<mark>` tags is
  fiddly). Snippets land on the seduta where the inline links work.

## "disegno di legge n. NUM" -> ac/as resolution by chamber

Italian bills are numbered separately in each chamber: Camera bill 1946
and Senato bill 1946 are different documents. The phrase "disegno di
legge n. NUM" in transcript prose does NOT specify which chamber the
number belongs to.

**v1 heuristic (`server/lib/parlamento/refs/index.ts`):** when a
"disegno di legge n. NUM" reference is detected (internal tipo
`ddl_ambiguous`), parseRefs() resolves it to:

- `ac` if the seduta is a Camera transcript
- `as` if the seduta is a Senato transcript

**Why this heuristic:** the speaker is usually referring to the bill
currently before their own chamber, so the chamber-of-transcript is the
most likely match. In practice, when a Camera deputy says "esame del
disegno di legge n. 1946" they are talking about Camera bill 1946 in
99%+ of cases.

**When it goes wrong:** a deputy occasionally references a bill that
ORIGINATED in the other chamber, by its origin-chamber number, without
the explicit `S.` or `A.S.` marker that would disambiguate. In those
cases the link points to the wrong chamber's bill of the same number.

**What to do about it:** v1 ships with the heuristic as-is. If
production data shows a meaningful rate of broken links, options to
tighten:
- Look for cue phrases nearby ("approvato dal Senato", "trasmesso alla
  Camera") that imply origin-chamber.
- Cross-check the Camera bill page exists for the number; on 404, fall
  back to the Senato URL.
- Add a `verified_at` field to riferimenti and a small periodic job that
  HEAD-checks URLs and marks dead ones.

The internal `ddl_ambiguous` tipo never persists -- only resolved `ac`
or `as` reach the database. So switching the heuristic is a parser
change (PARSER_VERSION bump) and a backfill, not a schema migration.

## Coverage asymmetry: Senato debates have no refs

Because all 417 leg-19 Senato sedute have `body_status = "waf_blocked"`
(see project-kb/Parlamento section.md, "Senato body content is
unreachable"), there is no transcript text to scan and zero refs are
extracted from Senato debates. This is the existing AWS-WAF situation,
not something the refs feature introduced.

Implications for any UI that aggregates over `parlamento_riferimenti`:

- The "leggi più citate" leaderboard (commit 7) shows Camera-only
  citations. A law debated extensively in Senato but only briefly in
  Camera looks under-represented.
- Faceted search via `?cita=tipo:anno:numero` returns Camera
  interventi only. Per-law pages (when built) miss the Senato side of
  the debate.
- The Senato reader UI keeps the "transcript unavailable" disclaimer
  card; there is nothing to linkify. No regression, just the feature
  is invisible there.

Refs TO Senato bills (AS) are still extracted from Camera transcripts
when a deputy explicitly says "A.S. 1236", "atto Senato 1236", or
"disegno di legge S. 1236". So the asymmetry is "Senato side is
silent", not "Senato is unrepresented in the data" -- Camera deputies
talk about Senato bills regularly and those mentions land.

If Senato content ever becomes reachable (Playwright route, manual
import), `parlamento-refs --reparse --chamber senato` fills in the gap.
No schema migration needed; the asymmetry resolves itself once the
underlying interventi rows exist.

## Open questions

- **Per-article anchors on laws** (`!~art{N}` in the URN). Easy
  extension once the base parser is in. Not in v1.
- **Cross-legislatura AC/AS detection** ("AC 1234 della XVIII legislatura").
  Detecting the legislatura context from prose is fragile. v1 defaults
  to the seduta's legislatura.
- **Regional laws, EU directives, CdC referti.** Each has its own portal
  and citation format. Out of scope for v1.

## History

- **2026-05-05** -- Branch `feat/parlamento-ref-links` created off
  develop after PR #18 merged. Plan agreed:
  - Server-side parsing at ingest (not client-side rendering).
  - Deterministic riferimenti ids.
  - Bare "Costituzione" mentions skipped (only `art. N Cost.` linkified).
  - Sibling `parlamento refs` subcommand (cleaner CLI help vs. flag on
    the existing subcommand).
  Audit also surfaced fondi/spesa per-request aggregation work that
  should move to ingest; tracked as a sibling PR after this branch
  merges (option C). Scope of this branch stays focused on parlamento.
