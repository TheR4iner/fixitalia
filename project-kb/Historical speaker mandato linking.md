# Historical speaker mandato linking

## Overview

Camera legs 13-14 transcripts (1996-2006 HTML era) carry speaker names
but **no `idPersona`**: the 1990s markup uses bookmark anchors
(`<A NAME="Presidente 7643 1">ROSSI, MARIO.</A>`), not hyperlinks to a
deputy scheda. So `cameraHistoricalSession.ts` stores the raw label in
`oratore_nome` and leaves `mandato_id` null.

Consequence: transcript display and full-text speech search work, but
any query that traverses `mandato_id -> persona -> idPersona` (e.g.
"all speeches by person X across legislatures", per-deputy speech
counts) silently skips legs 13-14. Modern legs (15-19) link speakers
because the XML embeds `idPersona` in the speaker anchor href; see
`cameraSession.ts` `resolveMandato`.

Note: null `mandato_id` is not unique to 13-14 -- even modern legs leave
it null for role-only labels ("PRESIDENTE.", "Il Ministro..."), so the
"by person" query already tolerates nulls. Legs 13-14 just hit that
path universally.

This is the people-equivalent of the ISTAT-code rule in CLAUDE.md:
never join on a name string. The fix must attach a canonical id, not
match on display text at query time.

## Current solution

Implemented (2026-06-11) as `server/scripts/link-historical-speakers.ts`
plus the pure matcher in `lib/ingest/parlamento/historicalSpeakerLink.ts`
(unit-tested) and the roster enumerator
`fetchLegRosterViaSparql()` in `cameraHistoricalDeputatoSparql.ts`.

Pipeline:

1. **Roster** per leg from `dati.camera.it/sparql`: enumerate every
   `ocd:deputato` with `ocd:rif_leg repubblica_{N}`, take
   `foaf:firstName`/`foaf:surname` + most-recent group; idPersona is the
   numeric id in the `deputato.rdf/d{id}_{leg}` URI. ~645 deputies/leg.
2. **Scan**: one *sequential keyset* pass over `parlamento_interventi`
   (`WHERE id > $cursor LIMIT N`, no ORDER), filtered to the leg's sedute
   in JS via a seduta-id->leg map. See the read-strategy note below --
   this matters a lot on the HDD.
3. **Match** `oratore_nome` -> deputy, two tiers, both accent/apostrophe
   insensitive and order-independent:
   - **exact**: label token set == (firstName ∪ surname) token set.
   - **relaxed**: surname tokens all present + primary given name present
     + label given-names ⊆ official given-names. This is the key fix:
     the roster's `firstName` is the *full legal* form ("CARLO AMEDEO"),
     transcripts use the everyday form ("CARLO"), so exact-only missed
     thousands of real deputies (Giovanardi, La Russa, ...).
   - homonyms (>1 candidate in either tier) -> left null, never guessed.
4. **Backfill**: upsert persona+mandato (`persona.ts` helpers) and stamp
   `mandato_id` on matched rows; `bumpMandatoInterventi` records counts.

Idempotent: only `mandato_id IS NONE` rows are linked, so re-running after
improving the matcher picks up the remaining tail without double-counting.
Dry-run by default; `--apply` to write.

**Results (2026-06-11 apply):** leg 13 -> 73508 interventi linked across
604 deputies (95.2% of nameful, non-role labels), 3673 unmatched;
leg 14 -> 74570 across 587 deputies (90.3%), 8055 unmatched. **0 ambiguous**
in both -- the matcher never collides.

## Read strategy (HDD-critical)

`parlamento_interventi` has **no `legislatura` column** (filter via
`seduta_id`), and the DB lives on a 5400rpm spinning disk. Two traps:

- Per-seduta lookups (`WHERE seduta_id = X`) are random I/O: rocksdb fetches
  each full row blob (incl. the big `testo`) from scattered locations,
  ~10ms/row -> a 1500-row seduta took ~15s cold. 1300+ sedute = hours.
- `WHERE seduta_id = X AND mandato_id IS NONE` picks the *mandato* index and
  scans every null-mandato row DB-wide -> minutes -> times out.

Fix: keyset-paginate the whole table by primary key with **no ORDER**
(`ORDER id` forces a full sort -> timeout; rocksdb already returns key
order). Warm pages ~100ms/5000 rows; cold pages downshift via adaptive page
sizing + a `/health`-gated reconnect (SurrealDB only sends response headers
when the query finishes, so one slow page past undici's ~5min headers
timeout would otherwise wedge the run). On a *quiet* disk the full 1.37M-row
scan is ~5-6 min. **Never run it alongside another ingest** -- disk
contention makes both crawl and risks the write-path OOM.

## Open questions / remaining tail

- The ~3.7k+8.1k unmatched are mostly **nicknames/diminutives** the roster
  stores formally: BEPPE->Giuseppe, NICHI->Nicola, ROSY->Rosa,
  NINO->Antonino, LELLO, TITTI, NUCCIO, plus a "Gian Paolo"/"Giampaolo"
  spacing variant. Left null on purpose (Nino->Antonino? Antonio?
  Giovannino? -- a guess would corrupt per-person stats).
- **Path to 100% (planned tiers, for a later idempotent re-run -- the
  script only touches `mandato_id IS NONE`, so adding tiers is safe):**
  1. **Surname-uniqueness tier** (highest value, do first): when a label's
     surname tokens match exactly *one* deputy in the leg roster, accept
     the link even if the given name is a nickname -- a unique surname in a
     ~645-person leg is a strong key. Likely clears most of the tail
     (STRANO, VENDOLA, IANNUZZI, ... are unique surnames). Only apply when
     the surname maps to exactly one roster deputy.
  2. **`ocd:nickname`** blank node on the deputato resource -> authoritative
     diminutive->formal mapping from official data (no guessing).
  3. Tiny residue after 1+2 -> manual lookup, one by one.
  Also: legs 1-12 (PDF era) have no transcript data at all yet -- the
  larger completeness frontier, a separate post-MVP phase.
- Senato 13-18: confirmed NOT affected -- the senato pipeline resolves
  `idPersona` during ingest (leg 13 had 317 senator mandati), so this gap
  is Camera-only.

## History

- 2026-06-11: Implemented + ran. Exact-only first pass was 85-89%; adding
  the relaxed (middle-name subset) tier lifted it to 90-95% with zero
  ambiguous. Remaining tail is nicknames. Also recorded the HDD keyset-scan
  read strategy (per-seduta random I/O was unusable).
- 2026-06-09: Gap identified and post-pass scoped. Decision: ship the
  ingest with `mandato_id` null on legs 13-14, run this backfill as a
  separate post-launch pass. Note created.
