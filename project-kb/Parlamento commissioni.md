# Parlamento commissioni (committee transcripts)

## Overview

Extends the parlamento corpus from Aula (plenary) sittings to **commissioni
parlamentari**: audizioni, indagini conoscitive and sede-specific committee
work. This is where the people the Parliament summons actually speak --
public-sector managers, companies, unions, technical experts -- so for a
project about public money it is arguably higher-value material than floor
debate.

Two chambers, two very different sources:

| | Camera | Senato |
|---|---|---|
| Document | Resoconto **stenografico** (verbatim) | Resoconto **sommario** (third-person summary) |
| Format | XHTML with CSS classes | Akoma Ntoso XML (`.akn`) |
| Access | Open, no WAF, no cookies | AWS WAF, needs the Playwright path |
| Enumeration | Monthly listing page | SPARQL (WAF-free) + per-year listing (WAF) |
| Coverage | Legs 17-19 only | Legs 13-19 (deeper archive exists) |

Related: [[Parlamento section]], [[Parlamento coverage gaps]],
[[Parlamento body-pass atomicity]], [[Meilisearch search layer]].

## Current solution

### Data model: one table, one discriminator

Committee sittings live in `parlamento_sedute` alongside plenary ones, keyed
by `organo` (`'assemblea'` | `'commissione'`). They are NOT in a sibling table,
because everything downstream of a seduta -- `parlamento_odg`,
`parlamento_interventi`, the refs extractor, the Meilisearch sync, the
persona/mandato speaker model -- is identical for both. A separate table would
have meant duplicating all of it and, worse, leaving committee speeches out of
full-text search until each pipeline was taught about the second table.

**The price of sharing, and it is the single most important thing to know
about this feature:** `(chamber, legislatura, numero)` is NO LONGER UNIQUE.
Committee resoconti are numbered per-committee *and per inquiry*, so
`camera/19/1` names one plenary sitting and also the first sitting of dozens of
committees. Every query that means "a plenary sitting" must say
`organo = "assemblea"` explicitly. The point-lookup handlers in
`routes/parlamento.ts` do; if you add another, it must too.

New fields on `parlamento_sedute`: `organo`, `organo_cod`, `organo_nome`,
`organo_slug`, `tipo_resoconto`, `tipologia`, `sottotipologia`.
`organo` is also denormalised onto `parlamento_odg` and
`parlamento_riferimenti` (same rationale as the existing `chamber` /
`legislatura` denormalisation there: link traversal in a WHERE clause forces a
full scan).

Committee sittings are addressed by **document scope**, a deterministic
record-id suffix, never by numero:

- Camera: `cc-{leg}-{idCommissione}-{tipologia}-{sottotipologia}-{numero}`
- Senato: `sc-{leg}-{docId}`

The scope also namespaces the deterministic ids of child rows (`parlamento_odg`,
`parlamento_riferimenti`), which previously keyed on `numero` and would
otherwise collide across committees. `buildRifRows` grew an optional `idScope`
for exactly this; assembly callers leave it unset so every existing ref id stays
byte-identical.

### Modules

```
server/lib/ingest/parlamento/
  commissioni.ts                  orchestrator (index pass -> body pass)
  commissioniPersist.ts           shared persistence tail for both chambers
  cameraCommissioniIndex.ts       monthly listing -> sitting rows
  cameraCommissioniSession.ts     XHTML transcript parser
  senatoCommissioniIndex.ts       SPARQL roster + per-year listing scrape
  senatoCommissioniSession.ts     Akoma Ntoso parser
  senatoSparqlClient.ts           shared LOD client (extracted from senatoreSparql.ts)
```

Frontend: `SedutaReader` (extracted from `SedutaPage`, now shared by both
readers), `CommissioniPage`, `CommissioneSedutePage`, `CommissioneSedutaPage`.

### Why the Camera parser is not the assembly parser

Three structural differences make `cameraSession.ts` *wrong* here, not merely
suboptimal:

1. **Paragraphs.** On the floor each paragraph is its own sibling
   `<p class="interventoVirtuale">`. In committee the whole speech is ONE
   `<p class="intervento">` with `<br />` separators. A sibling-based parser
   collapses a 30-paragraph speech into one block.
2. **Non-parliamentarian speakers.** Auditees and consultants appear as a bare
   `<a>NAME</a>` with **no href**, because they have no deputy scheda. The
   assembly parser selects on `a[href*="idPersona"]`, so it drops exactly the
   people an audizione exists to hear.
3. **Inline page markers.** `<span class="numeroPagina">Pag. 4</span>` sits
   INSIDE the sentence it interrupts (the Aula puts them in their own `<p>`).

Attribution is parsed as a text prefix (`NAME. body` or `NAME, role. body`)
rather than from the `<em>` element, because the source splits one
qualification across several `<em>` runs when it contains nested emphasis, and
because the first ordinary `<em>` in a speech is otherwise misread as a role.

### Why Senato enumeration is split across two hosts

`dati.senato.it` (SPARQL) is **outside** the AWS WAF that guards
`www.senato.it`. It knows about 74,714 committee sittings and answers a plain
HTTP request, so discovery of *which* committees sat in *which* years is free.
Only the 7-digit document ids are missing from the graph, so the WAF-guarded
site is visited once per (committee x year) -- a few hundred navigations per
legislature instead of a blind crawl.

The `.akn` export is fetched via `context.request.get` on the warmed browser
context (cheaper than a full page navigation) and is explicitly throttled;
`navigateWithWaf` does that for navigations, this path would otherwise bypass
it entirely.

## Corpus size (measured 2026-08-24)

Camera, from a full `--index-only` survey:

| Legislature | Sittings | Months published |
|---|---|---|
| 17 | 3,273 | 61 |
| 18 | 1,592 | 53 |
| 19 | 1,805 | 46 |
| **Total** | **6,670** | across **146** distinct committees |

For scale, the entire plenary corpus (both chambers, legs 13-19) is ~9,800
sittings, so Camera committees alone are roughly two thirds of it again.

Density measured over the first 49 ingested sittings: **~15 interventi per
sitting**, so the full Camera backfill is on the order of 100k interventi.

Senato: the LOD graph reports **74,714** committee sittings across all
legislatures. At the WAF throttle's ~8s per document that is measured in days
of continuous running, not hours -- see limit 5.

## How to re-run on the live DB

Everything is idempotent and resumable. Every sitting has a deterministic
record id and a `body_status`; an interrupted run is resumed by running it
again. Nothing is keyed on run order or a cursor that can go stale.

**0. Schema migration (automatic).** `runSchema()` runs on every boot and
applies the `organo` fields plus a sentinel-guarded one-shot backfill that
labels pre-existing rows `assemblea`. First run takes ~30s on the current
corpus; every subsequent boot is ~100ms. No operator step.

**1. Survey before committing disk.**

```bash
cd server
npx tsx scripts/ingest.ts parlamento-commissioni --chamber camera --all-legislatures --index-only
```

Index rows are metadata only, so this shows how large a corpus a full body
pass would build before any of it is downloaded.

**2. Camera backfill** (no WAF, no VPN, ~1s per sitting):

```bash
npx tsx scripts/ingest.ts parlamento-commissioni --chamber camera --all-legislatures
```

**3. Senato backfill** (needs Chromium + the WAF path; slow by design):

```bash
npx tsx scripts/ingest.ts parlamento-commissioni --chamber senato --legislatura 19
```

Start with one legislature, or one committee via `--only-cod 0-21`. The
throttle is the same `senatoThrottle` the Aula ingest uses (6-12s jitter,
180s cooldown every 30 requests, all env-tunable).

**4. Routine refresh** (cheap; this is what a scheduler should run):

```bash
npx tsx scripts/ingest.ts parlamento-commissioni --chamber camera --legislatura 19 --months $(date +%Y%m)
```

`--months` restricts discovery to the current month instead of rescanning all
46, which is the difference between a few seconds and a few minutes.

### Flags

| Flag | Effect |
|---|---|
| `--chamber camera\|senato\|both` | default `both` |
| `--legislatura N` / `--all-legislatures` | mutually exclusive |
| `--months YYYYMM,...` | Camera only; restricts discovery |
| `--only-cod 0-21,0-1` | Senato only; restricts to committee codes |
| `--index-only` | discover and stop |
| `--skip-index` | body pass only, over what is already known |
| `--limit N` | cap the body pass (smoke tests) |
| `--refresh` | re-fetch and re-parse sittings already `ok` |

### Storage cost

Measured 2026-08-25 against the live corpus, not extrapolated from a rule of
thumb. The unit that transfers between workloads is **bytes of stored database
per byte of source text**, because sittings vary enormously in length while the
storage overhead per character does not.

```
SurrealDB   3.16 GB          raw text in corpus   2.25 GB
Meili      20.75 GB          => 11.43 bytes stored per byte of text
TOTAL      23.91 GB             (Meilisearch alone accounts for 9.92 of those 11.43)
```

**Meilisearch is 87% of the footprint.** It is a rebuildable replica of
SurrealDB, and it currently keeps `testo` as a retrievable attribute as well as
an indexed one -- so the same text is stored twice, once in the source of truth
and once in the replica. Trimming Meili's stored attributes is by a wide margin
the highest-leverage storage action available here, and it is reversible.

Per-sitting text volume, measured:

| Source | chars/sitting | n | note |
|---|---|---|---|
| Camera committee stenografico | 40,405 | 1,799 | verbatim |
| Senato committee sommario | 8,892 | 63 | summaries, and **60% are empty upstream stubs** |

| Workload | Sittings | Text | Storage |
|---|---|---|---|
| Camera legs 17+18 (remaining) | 4,865 | 197 Mc | **2.1 GB** |
| Senato committee, all legislatures | 74,714 | 664 Mc | **7.1 GB** |
| PDF phase (see [[PDF ingest phase]]) | 22,658 | 272 Mc | **2.9 GB** |

**Caveat on the Senato figure:** the 63-sitting sample is entirely from the
Giunta delle elezioni in one legislature, which is procedural and short. The
permanent commissions (Bilancio, Affari costituzionali) will run longer, so
treat 7.1 GB as a floor and 12-15 GB as the realistic ceiling until a permanent
commission has been sampled.

### After a large backfill

Meilisearch documents are written incrementally by the body pass, so no
re-sync is required for correctness. The `organo` filter is deliberately
tolerant of documents indexed before this feature existed
(`organo = "assemblea" OR organo NOT EXISTS`), so search keeps working during
the transition. A full `scripts/meili-sync.ts` rebuild is optional tidying,
not a prerequisite.

## Current limits

Marked clearly because several are upstream, not fixable here.

1. **Camera HTML committee transcripts cover legislatures 17-19 only** --
   but committee data itself goes back to legislature I. The distinction
   matters and an earlier version of this note got it wrong.

   The `elencoResoconti` service answers only for legs 17-19; older
   legislatures render no month picker at all (verified: leg 16 returns a
   ~15KB stub). But `dati.camera.it` publishes **22,658 committee bollettini
   spanning legislatures I to XIX**, every one of them with a direct document
   URL -- and every one of those URLs is a PDF. Confirmed by asking the
   endpoint for any referenced URL that is not a `.pdf`: there are none.

   ```
   legs 13-16:  /_dati/leg{N}/lavori/Bollet/{YYYYMM}/{MMDD}/pdf/intero.pdf
   legs 1-12:   /_dati/leg{N}/lavori/Bollet/{YYYYMMDD}_00.pdf
   ```

   (Note the capital B in `Bollet` -- lowercase 404s, which is why hand-probing
   for the naming convention failed before the LOD endpoint was found. An
   `html/` sibling directory exists next to `pdf/` and returns 403 rather than
   404, so something is in it, but no filename in it has been found and the LOD
   references none.)

   So legs 1-16 are not "unavailable", they are **PDF-only** -- the same phase
   as Senato's verbatim committee record. See the deferred phase below.

2. **Senato committee text is SUMMARY, not verbatim.** A resoconto sommario
   paraphrases speakers in the third person ("Pone domande all'audito il
   senatore GRASSO (Misto-LeU-Eco)..."). It is written by the secretariat.
   Rows carry `tipo_resoconto = 'sommario'` and the UI labels every one of
   them, in the roster, the sitting list, the reader and each search hit.
   **This must never be presented as a quotation.** Senato's verbatim
   committee resoconti are PDF-only -- see the deferred phase below.

3. **The two chambers are therefore asymmetric.** Camera gives verbatim,
   Senato gives summaries. Any cross-chamber statistic over committee text
   (words per speaker, most talkative committee) would be comparing two
   different kinds of document and should not be built without accounting for
   it.

4. **The Senato LOD graph omits the Giunte entirely** -- handled, but worth
   knowing. `osr:SedutaCommissione` covers permanent committees,
   sottocommissioni and bicamerali (33 organi in leg 18) and carries ZERO
   sittings for the Giunte, even though senato.it publishes their sommari
   normally (the Giunta delle elezioni alone has 205 in leg 18).

   The index pass closes this by probing the site's own code space
   (`discoverMissingOrgani`): tipo 0 and 4, cod 1-32, skipping anything SPARQL
   already knows. A code that does not exist costs one "Pagina non
   disponibile" and is skipped, so the probe is ~64 requests per legislature,
   once, at index time. This deliberately replaced a hardcoded list of three
   Giunte: the failure mode of a hardcoded roster is silently missing data,
   which is exactly what it was there to fix.

5. **Senato backfill is slow by construction.** The WAF throttle means roughly
   8s per document. The full LOD-known corpus is ~74k sittings, i.e. weeks of
   wall-clock. Treat a full Senato committee backfill as a background campaign,
   not a run.

6. **Empty upstream documents exist.** senato.it publishes stub sommari (a
   heading, an empty `<an:p/>`, no `<an:speech>`) for procedural sittings.
   These store `body_status = 'ok'` with an explanatory `body_error`, and are
   reported as `empty` in the run summary. Storing `'empty'` would put them
   back in the queue on every run forever, since the pending filter is
   `body_status != "ok"`.

7. **Committee speakers often have no mandato.** Auditees and external experts
   have no `idPersona`, so `mandato_id` is null and they do not appear on
   persona pages. They are fully searchable and render with their stated role
   ("Chief Revenue Officer del Gruppo Lutech"). This is correct, not a gap.

8. **The assembly ingests were not retrofitted onto `commissioniPersist.ts`.**
   `cameraSession.ts` / `senatoSession.ts` / `cameraHistoricalSession.ts` keep
   their own copies of the persistence tail. They are a working production
   path and the churn was not judged worth the risk. If that tail is changed,
   change it in both places.

## Deferred: the PDF phase

> Now planned in detail in [[PDF ingest phase]] -- including the finding that
> Camera already embedded a text layer in its historical scans, so no OCR stage
> is needed.

Two sources are reachable but PDF-only, and are deliberately out of scope for
this phase -- the same call `CLAUDE.md` makes for Corte dei Conti referti.

- **Senato resoconti stenografici delle commissioni.**
  `senato.it/service/PDF/PDFServer/DF/{id}.pdf`. This is the verbatim text
  that would close limit 2 and limit 3 above, so it is the higher-value of
  the two. **Confirmed PDF-only** (2026-08-24): the `.akn` export that exists
  for SommComm 404s for StenComm ids, `showdoc?tipodoc=StenComm` returns
  HTTP 500, and the stenografici listing pages link directly to PDFServer with
  no HTML intermediary. The PDF id space is also disjoint from the SommComm
  show-doc id space.
- **Camera Bollettino delle Giunte e Commissioni, legislatures I-XIX.**
  Enumerable without any scraping: `dati.camera.it/sparql` exposes
  `ocd:bollettino` with `dc:date`, `ocd:rif_leg` and a `dct:isReferencedBy`
  document URL, 22,658 rows. This is the single highest-leverage target in the
  whole PDF phase -- it is the ONLY committee record for legislatures 1-16,
  and enumeration is a single SPARQL query rather than a crawl.

  ```sparql
  PREFIX ocd: <http://dati.camera.it/ocd/>
  PREFIX dct: <http://purl.org/dc/terms/>
  SELECT ?s ?date ?leg ?url WHERE {
    ?s a ocd:bollettino ; dc:date ?date ; ocd:rif_leg ?leg ;
       dct:isReferencedBy ?url .
  }
  ```
  Note an upstream defect: `sezione=bollettini&tipoDoc=elenco` 302-redirects to
  `apps.intra.camera.it`, an internal host that does not resolve publicly, so
  that entry point is unusable.

Both need text extraction plus layout reconstruction, and neither has a
machine-readable alternative. Worth doing as its own phase with its own
accuracy budget.

## Open questions

- Does `www.parlamento.it` mirror the Senato `/static/bgt/...` tree WITHOUT
  the WAF? If so the Playwright + VPN cost for Senato disappears. Untested:
  the domain is absent from `EXTRA_ALLOWED_DOMAINS` in `.workspace/.env`, so
  testing it needs that entry plus a workspace restart.
- Is `ROSTER_SUPPLEMENT` complete? 0-20 / 0-21 / 0-22 were found by hand; no
  authoritative machine-readable roster of Senato Giunte was located.
- Camera legs 13-16: the legacy `_dati` archives respond 403 (present) at the
  directory level, so the content exists. Only the file-naming convention is
  missing.

## History

- **2026-08-24 (initial implementation)** -- Full ingest path for both
  chambers, schema migration, API, reader UI, 30 tests.
  - Verified end to end against the dev DB: 49 Camera leg-19 sittings
    (June 2024) at ~1s each, and 3 Senato leg-18 Giunta sommari through the
    WAF path.
  - Fixed on the way, all caught by running the thing rather than by reading
    it: `option<T>` rejecting bound null (needs `stripNulls`); `ORDER BY`
    requiring its idiom in the projection; a boot-time backfill that scanned
    213k rows on *every* start (1.66s -> 103ms via a sentinel row); record-id
    stringification using BACKTICK delimiters via `type::string()` but ANGLE
    BRACKETS via the JS SDK, which 400'd every reader link; a month-picker
    seed of `annoMese=000000` that renders an error shell with no picker (must
    be empty); and `[?&]annoMese=` failing against HTML-escaped `&amp;`.
  - Also fixed a pre-existing bug found while working: `senatoBrowser.ts`
    hardcoded the distro Chromium path, so every Senato ingest died at launch
    on any machine without that package even with Playwright's own Chromium
    installed. It now falls back to the bundled build.
