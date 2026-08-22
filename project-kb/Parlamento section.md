# Parlamento section

## Overview

Reader-style section that surfaces the daily transcripts (resoconti
stenografici) of Camera and Senato. Lets the user browse sessions day by
day, jump within a session by ordine del giorno (OdG) or by speaker, and
search the full corpus of transcripts at once.

This is the first section of fixitalia that ingests **document-style**
data rather than aggregate KPIs. It introduces three patterns that
were not in the project before:

1. A two-phase ingest with a checkpoint table, since a full-legislatura
   crawl is ~1200 sessions and many hours of network + parse time.
2. SurrealDB full-text BM25 search via `DEFINE ANALYZER` +
   `DEFINE INDEX ... SEARCH ANALYZER ... HIGHLIGHTS` -- the project's
   first inverted-index search.
3. A shadcn Sheet-based "reader" UI with persistent typography prefs
   instead of charts + tables.

## Current solution

### Schema (`server/lib/schema.ts`)

Five new SCHEMALESS tables, all idempotent:

- `parlamento_sedute` -- one row per session (chamber, leg, numero, data,
  source URLs, body_status). Indexed by date and by chamber+leg+numero.
- `parlamento_odg` -- one row per agenda item per session, ordered.
- `parlamento_interventi` -- one row per speaker turn. The `testo` field
  encodes paragraph breaks as `\n\n` so the reader can split into
  paragraphs without an HTML round-trip; the SEARCH analyzer collapses
  whitespace before tokenizing, so the markers do not leak into search
  snippets. Indexed by (seduta, posizione) and by oratore.
- `parlamento_oratori` -- deduplicated speakers, slugged as
  `<chamber>-<name>-<role?>` so the same surname across chambers stays
  disjoint.
- `parlamento_ingest_state` -- single-row checkpoint per chamber/leg.

The Italian analyzer is `TOKENIZERS class FILTERS lowercase, ascii,
snowball(italian)`. The SEARCH index over `testo` carries `BM25
HIGHLIGHTS`, which `search::highlight()` and `search::score()` need at
query time.

### Ingest (`server/lib/ingest/parlamento/`)

Per chamber, two phases:

- **Index pass** -- enumerate sedute and upsert metadata-only rows.
  - Camera: probe `documenti.camera.it/leg{N}/resoconti/assemblea/xml/repository/sed{NNNN}/stenografico.xml`
    for numero=1..high, take the first ~8KB to read the date attribute.
    Concurrency=4. Stops after 40 consecutive 404s once at least one
    seduta has been seen.
  - Senato: scrape the chronological listing
    `https://www.senato.it/lavori/assemblea/resoconti-elenco-cronologico?year=Y`
    (past legislatures: `/legislature/{N}/lavori/...?year=Y`) one year at
    a time, walk anchors with `tipodoc=Resaula`, dedupe by numero (final
    beats draft). The page's own year-selector anchors use `?year=YYYY`;
    `?anno=YYYY` is silently ignored and falls back to the current year.
- **Body pass** -- for every seduta whose `body_status != "ok"`, fetch
  the per-session XML/HTML and write OdG + interventi + oratori.
  Idempotent: each run wipes the seduta's prior children before
  inserting. Resumable: a crash mid-run leaves earlier sedute as `ok`
  and continues from the next.

The orchestrator (`index.ts`) ties index + body together. CLI:

```
docker exec -w /app/server fixitalia-dev npx tsx scripts/ingest.ts parlamento [--chamber camera|senato|both] [--legislatura N] [--limit N] [--from N --to N] [--refresh]
```

The auto-bootstrap-on-empty pattern from `server/server.ts` is
deliberately **off** for parlamento -- a server restart should never
kick off a multi-hour crawl. The bootstrap logs a hint instead.

### API (`server/routes/parlamento.ts`)

```
GET /api/parlamento/calendar?from=YYYY-MM&to=YYYY-MM[&chamber=]   -> month-grouped counts
GET /api/parlamento/sedute[?chamber=&page=&pageSize=&from=&to=]  -> session list
GET /api/parlamento/sedute/:chamber/:numero                       -> seduta + odg + oratori
GET /api/parlamento/sedute/:chamber/:numero/interventi[?page=&pageSize=] -> reader content
GET /api/parlamento/search?q=&chamber=&page=                      -> BM25 hits with snippets
GET /api/parlamento/oratori/:slug                                 -> oratore + recent interventi
```

`/search` uses `search::highlight('<mark>', '</mark>', 0)` and
`search::score(0)` and orders by score desc. The 0 is the index of the
matched expression in the WHERE clause -- if we add another `@@`
condition later we'd need to pick the right index.

### Frontend (`src/pages/parlamento/`, `src/components/parlamento/`)

- `ParlamentoPage` -- landing: search bar, chamber filter, recent
  sedute list with `Load more`.
- `SedutaPage` -- the reader at `/parlamento/:chamber/:numero`.
  Two-column on lg+ (transcript + sticky TOC), single-column with a
  Sheet TOC on small screens. Embeds the official video lazily.
- `SearchResultsPage` -- BM25 results with safely-rendered `<mark>`
  highlight nodes (we split on the literal markers and rebuild as
  React nodes; no raw-HTML render path).
- `InterventoBlock` -- one speaker turn. Border-left spine tinted by
  the parliamentary group via `groupColors.ts`. Copy-link button writes
  `?#int-N` to the clipboard.
- `ReaderSettings` -- font / size / line-height popover, persisted via
  `useReaderPrefs` localStorage hook.

### Daily auto-fetch scheduler (`server/lib/scheduler.ts`)

In-process polling scheduler that re-runs `ingestParlamento({chamber:'both',
legislatura: 19})` once per day. Zero external dependencies -- one
`setInterval` ticking every 60s, comparing the wall clock in
`PARLAMENTO_AUTOFETCH_TZ` against `PARLAMENTO_AUTOFETCH_HOUR:MINUTE`.

Default fire time is **06:00 Europe/Rome**: late enough that the previous
day's resoconto (typically published in the evening) has settled, early
enough that no user traffic is competing for backend cycles.

Key design points:

- **Idempotency lives in the ingest layer, not the scheduler.** The cron
  just fires the same orchestrator the CLI uses; the orchestrator's
  `body_status != "ok"` filter handles overlap, restarts, and partial
  failures.
- **DB-derived `lastRunDate`.** On boot, the scheduler reads
  `parlamento_ingest_state.updated_at` for the configured legislatura and
  initializes `lastRunDate` to its date-in-TZ. Without this, a `tsx --watch`
  reload (every save in dev) would re-fire today's ingest. With it, a
  restart that finds today already ingested becomes a no-op.
- **Single-flight guard.** A run still in progress when the next tick
  fires logs a warning and skips -- no stacking.
- **Polling, not `setTimeout(msUntilNext)`.** DST-safe: each tick re-reads
  the wall clock, so spring-forward / fall-back can't double-fire or skip.
- **Skipped automatically in tests** (`NODE_ENV=test`) and when
  `PARLAMENTO_AUTOFETCH_ENABLED=false` (e.g. when running the cron on a
  separate worker host).

Wired in `server/server.ts` after `bootstrapData()`. Env vars in
`.env.example`:

```
PARLAMENTO_AUTOFETCH_ENABLED=true
PARLAMENTO_AUTOFETCH_HOUR=6
PARLAMENTO_AUTOFETCH_MINUTE=0
PARLAMENTO_AUTOFETCH_TZ=Europe/Rome
PARLAMENTO_AUTOFETCH_LEG=19
```

### CSP

`server/server.ts` adds `frameSrc: ["'self'", 'https://webtv.camera.it', 'https://webtv.senato.it']`
so `VideoEmbed` can render an iframe to the official webtv hosts.

### Egress (`init-firewall.sh`)

`.env.example` documents the required `EXTRA_ALLOWED_DOMAINS`:

```
camera.it www.camera.it documenti.camera.it dati.camera.it webtv.camera.it
senato.it www.senato.it dati.senato.it webtv.senato.it parlamento17.openpolis.it
```

The user's `.env` must mirror this for the workspace container to reach
the gov sources at all.

## Senato body content via Playwright -- PoC VERIFIED 2026-05-14

The "terminal finding" below (WAF wall) is **no longer terminal**. Headless
Chromium driven by Playwright solves the AWS WAF challenge and reaches the
actual transcript body. PoC: `server/scripts/senato-playwright-poc.ts`,
verified end-to-end on 2026-05-14 (HTTP 200, ~64KB HTML, transcript header
present including "419a SEDUTA PUBBLICA / RESOCONTO STENOGRAFICO" with
Presidenza details).

Key implementation details:

- **AWS WAF challenge** uses an inline JS bootstrap that loads
  `https://f92e3446b0c3.c1cdd57a.eu-central-1.token.awswaf.com/.../challenge.js`,
  computes a PoW, sets `aws-waf-token` cookie, and reloads. Playwright
  executes this transparently. The workspace egress firewall blocks the
  awswaf.com endpoint by default; add it to `EXTRA_ALLOWED_DOMAINS` to
  test locally. On the VPS no firewall = works out of the box.
- **Dev-environment symptom** when the workspace `.env` is missing the
  awswaf entry: every listing-page navigation returns the WAF
  interstitial body (the `AwsWafIntegration.getToken().then(...)`
  inline JS + the "JavaScript is disabled" fallback text) instead of
  the listing markup, so `scrapeSenatoListing` returns 0 rows per year
  for every leg. `server/scripts/probe-senato-listing.ts` is the
  diagnostic: it dumps the rendered DOM (anchor count, table count,
  body text). If the body starts with "AwsWafIntegration.saveReferrer"
  and shows "JavaScript is disabled", the local `.workspace/.env`
  needs the awswaf token domain added back to `EXTRA_ALLOWED_DOMAINS`
  and the workspace bounced.
- **Run sequence**: navigate to ANY senato.it URL first (e.g.
  `/lavori/assemblea/resoconti-elenco-cronologico?year=Y`) to solve the
  WAF challenge and capture the `aws-waf-token` cookie, then navigate to
  the actual document. The cookie is reused for subsequent requests in
  the same browser context.
- **Detection masking**: only `navigator.webdriver` override needed. AWS
  WAF in "challenge" (not "captcha") mode is JS-only PoW, no UI signals.
- **Performance observed**: WAF challenge solve = ~2s, document load = ~3s.
  Sequential ingest of ~400 leg-19 sedute would be ~30 min wall-clock.
- **System Chromium works** (no Playwright browser download needed). Debian
  bookworm: `apt-get install chromium` -> `/usr/bin/chromium`. Alpine prod
  image: `apk add chromium nss freetype harfbuzz ca-certificates`.

## Senato SPARQL IDs do not match show-doc IDs (CRITICAL FINDING 2026-05-14)

The `html_url` values we persisted via SPARQL ingestion are **wrong**. The
ID scheme used by `dati.senato.it/sedutaassemblea/<ID>` (5-digit, e.g.
24326 for leg-19 numero 419) is a completely different ID space from the
one `show-doc` actually uses today (7-digit, e.g. 1506236).

Every show-doc URL we built from SPARQL returns HTTP 500 with an
"ErrorPage_ShowDOC" page. This 500 was misread as a senato.it server issue
in earlier debugging -- it's actually "document does not exist" with that
ID.

The real seduta link format, discovered by scraping the chronological
listing on `www.senato.it/lavori/assemblea/resoconti-elenco-cronologico`:

```
/show-doc?leg=19&tipodoc=Resaula&id=<7-digit-id>&idoggetto=0
```

The 7-digit IDs are not in the LOD/SPARQL graph at all. They are only
discoverable by scraping the listing page's anchor tags.

**Implication for the Playwright ingest**: the index pass cannot use SPARQL
alone. It must scrape the chronological listing (year by year) to obtain
the correct show-doc URLs, then the body pass fetches each one. We still
keep SPARQL as a metadata source for `numero` / `data` / `tipoSeduta`, but
the resolution from numero -> show-doc URL has to come from the HTML
listing.

## Senato body content is unreachable -- AWS WAF wall (TERMINAL FINDING 2026-05-04 -- SUPERSEDED 2026-05-14)

**TL;DR**: Senato stenografici cannot be ingested programmatically from any
server. Every URL serving the transcript content is fronted by AWS WAF in
"challenge" mode, which returns HTTP 202 + an empty body + an
`x-amzn-waf-action: challenge` header to any client that doesn't carry a
JS-issued cookie. Only a real browser can solve the challenge. The site
behavior is identical from inside the dev container (no firewall) and from
a residential IP via the host: it's an IP/ASN/header signal, not a
network-layer block.

What we tried (all fail with 202 challenge or 403):

- `https://www.senato.it/show-doc?leg=19&id=XXXX&tipodoc=Resaula` -- 202 + empty
- `https://www.senato.it/japp/bgt/showdoc/showText.do?...` -- 202 + empty
- `https://www.senato.it/japp/bgt/showdoc/frame.jsp?...` -- 202 + empty
- `https://www.senato.it/japp/bgt/resoconto/assemblea/sedNNNN/stenografico.xml` -- 202 + empty
- `https://www.senato.it/service/PDF/PDFServer/bol/XXXX.pdf` -- 403
- `https://dati.senato.it/odata/senato/$metadata` -- 404 after redirect chain

The LOD ecosystem (`dati.senato.it/sparql` and `dati.senato.it/sedutaassemblea/{ID}.html`)
**is** reachable, but it only publishes session **metadata** (date, number,
legislatura, tipoSeduta -- 4 predicates total). The transcript text is not
in the RDF graph.

**What we do instead** (Option A, chosen 2026-05-04):

1. The Senato index pass (SPARQL) still runs and ingests session metadata
   for all 417 leg-19 sessions: date, number, type. The reader can show
   them in the calendar and list, with a link to the official viewer for
   anyone who wants to read.
2. The Senato body pass (`senatoSession.ts`) detects the WAF challenge
   (HTTP 202 OR `x-amzn-waf-action: challenge`) and marks the session
   `body_status = "waf_blocked"`. It writes no OdG / interventi rows.
3. The orchestrator's `listPending()` filter excludes `waf_blocked` so
   the daily auto-fetch scheduler doesn't waste cycles re-attempting
   hundreds of WAF-walled URLs every day. To force a re-attempt (e.g. to
   detect that Senato has relaxed the WAF), run with `--refresh`.
4. The reader's `SedutaPage.tsx` detects `body_status = "waf_blocked"`
   (or chamber=senato + zero interventi) and shows a clear disclaimer
   card (`t.parlamento.senatoUnavailable.*`) explaining why and linking
   to the official `html_url`.

**Don't try to "fix" this with a different URL pattern.** It's been
exhaustively probed (see diagnose-senato.sh / diagnose-senato2.sh in repo
root, and the conversation around 2026-05-04). The only viable paths to
get the body content are:

- **Headless browser (Playwright/Puppeteer) on the VPS prod container**,
  which can solve the WAF challenge. ~300MB image bloat (Alpine: `apk add
  chromium`), 5-10s per session vs <1s for HTTP fetch. The challenge
  mechanism: AWS WAF returns HTTP 202 + inline JS that loads
  `challenge.js` from `f92e3446b0c3.c1cdd57a.eu-central-1.token.awswaf.com`,
  solves a PoW, sets a cookie, then reloads the page. The workspace egress
  firewall blocks the `*.awswaf.com` endpoint (add it to
  `EXTRA_ALLOWED_DOMAINS` to test locally). On the VPS there is no egress
  firewall and it will work. PoC script: `server/scripts/senato-playwright-poc.ts`.
- **Manual ingest from a residential IP**, exporting to a SQL dump.
  Reliable but not automatable.

Camera (652 sessions, ingested via `documenti.camera.it/leg19/.../stenografico.xml`)
is unaffected and works perfectly. The Camera XML pattern has no WAF.

## Open questions

- BM25 search index breaks `parlamento_interventi` inserts on SurrealDB
  v2.1.4 -- the index must be dropped before any body re-ingest and
  rebuilt out-of-band via `./bm25-rebuild.sh`. Details in.
- Senato HTML stability: this section is moot now (see WAF wall above).
  Kept as a placeholder in case we add Playwright-based ingest.
- Speaker disambiguation: same surname appears in both chambers, and
  the same person across roles. Slug includes chamber + role to keep
  them disjoint, which is intentionally pessimistic. A follow-up could
  link to OpenParlamento person IDs and merge.
- The Camera XML schema has shifted across legislatures. The parser is
  defensive but the test fixtures are unit-only; we have no end-to-end
  fixture against a real `stenografico.xml` until the firewall opens.

## History

- **2026-08-16** -- Added a beta / data-accuracy disclaimer across the whole section. New `src/components/BetaNotice.tsx`: an `aside role="note"` on the `--warning` token family (`bg-warning` / `border-warning-border` / `text-warning-foreground`, already defined light+dark in `src/index.css`), with an optional `children` slot for `SourceLink`s and a `compact` prop. Copy lives in `t.common.beta` (title / body / sourcesLabel), so both densities share one wording.
  - `ParlamentoPage` renders the full-size variant above its `<header>`, with links to the Camera and Senato portals (`t.parlamento.sourceUrlCamera` / `sourceUrlSenato`).
  - Every subpage renders `<BetaNotice compact />` (title dropped, `border` instead of `border-2`, `text-xs`): `LeggePage`, `LeggiCitatePage`, `LegislaturePage`, `OdgSearchPage`, `SearchResultsPage`, `TransfughiPage`, `PersonaPage`, `SedutaPage`. Needed because there is no shared parlamento layout route -- each page is its own `<Route>` under the global `Layout` -- and deep links from search engines land straight on a transcript.
  - On `PersonaPage` and `SedutaPage` the notice sits *after* `</header>` rather than before it, so the back link stays the first element. `SedutaPage` passes the per-record `seduta.source_url` into the slot (`t.parlamento.seduta.sourceOfficial`), pointing at that exact resoconto instead of the chamber's index page.
  - **When adding a new page under `/parlamento`, add `<BetaNotice compact />` to it.**
- **2026-06-17** -- Fixed `PersonaPage` (oratore pages) crashing to a black screen. `MandatoCard` read `m.gruppo_storico.length` (and `.uffici`, `.organi`) directly, but for historical legislatures those array columns aren't populated, so SurrealDB returns the fields as missing/`undefined`. The `Mandato` type declares them as non-optional arrays, so TS didn't catch it and the access threw at runtime; with no error boundary anywhere, the whole React tree unmounted (black page). Three-part fix:
  - Backend `loadPersonaAndMandati` now normalizes each mandato so `gruppo_storico`/`uffici`/`organi` are always arrays (honors the `Mandato` contract).
  - `MandatoCard` guards each block with `(m.x?.length ?? 0)` for defense in depth.
  - Added `src/components/RouteErrorBoundary.tsx` (wraps `<Routes>` in `App.tsx`) so any future page crash shows a friendly fallback with the nav intact instead of blanking the app. Class component (no hook for error catching) keyed on `location.pathname` so it resets on navigation; retry uses `navigate(0)`. Copy under `t.common.errorBoundary`.
- **2026-06-13 (2nd session)** -- Completed all remaining browse features:
  - `TransfughiPage` (`/parlamento/transfughi?leg=&chamber=`) -- lists parlamentari with > 1 group membership in the selected legislature; shows full `gruppo_storico` transitions inline. Data available for Camera leg 19+.
  - `OdgSearchPage` (`/parlamento/odg/cerca?q=&leg=&chamber=`) -- submit-on-form search over OdG titles with pagination; query fires only on explicit submit (table-scan endpoint, not debounced autocomplete).
  - `LegislaturePage`: added quick-action pill row linking to `/parlamento?leg=N`, `/parlamento/leggi-citate?leg=N`, `/parlamento/transfughi?leg=N`, `/parlamento/odg/cerca?leg=N`.
  - `SedutaPage`: breadcrumb now includes `NªLegislatura →` link to `LegislaturePage`.
  - `PersonaPage` (`MandatoCard`): each mandato block now shows a "Legislatura N →" link to `LegislaturePage`.
  - `ParlamentoPage` hub card "Esplora l'archivio": added links to transfughi and OdG search alongside the existing leggi-citate link.
  - `App.tsx`: registered `/parlamento/transfughi` and `/parlamento/odg/cerca` as lazy routes.
  - Fixed stale unused import (`Link`) in `CareerTimeline.tsx` caught by `tsc --noEmit`.
  - Added `t.parlamento.seduteList.backLabel` i18n key.

- **2026-06-13** -- Browse features: speaker search, per-law page, legislature overview, oggi-nella-storia.
  New API routes in `server/routes/parlamento.ts`:
  - `GET /persona/search?q=&limit=` -- case-insensitive substring search over `parlamento_persona.nome`;
    batch-fetches mandati for all hits to return legs[], ultimo_gruppo, interventi_n without N+1.
  - `GET /refs/legge/:tipo/:anno/:numero` -- per-law citation detail: total count + paginated citing
    interventi with speaker and seduta info. Filters: `?chamber=&leg=&page=`.
  - `GET /refs/leggi-piu-citate` -- extended with optional `?leg=N&chamber=` filters (previously unfiltered).
  - `GET /legislature/:n` -- legislature overview: session counts per chamber, date range, top 15 speakers
    (from `parlamento_mandato.interventi_n`), top 10 cited laws (from `parlamento_riferimenti` grouped in JS).
  - `GET /oggi-nella-storia?month=M&day=D` -- sessions held on this calendar day across all years
    (body_status=ok only), newest-first, max 20 rows. Uses `time::month()` / `time::day()`.
  New frontend pages: `LeggiCitatePage` (`/parlamento/leggi-citate`), `LeggePage`
  (`/parlamento/leggi/:tipo/:anno/:numero`), `LegislaturePage` (`/parlamento/legislature/:n`).
  New component: `SpeakerSearch` -- debounced autocomplete (280ms) with keyboard nav (↑↓ Enter Escape),
  dropdown closes on outside-click. Integrated into ParlamentoPage alongside a legislature quick-nav
  grid and the oggi-nella-storia widget (hidden when 0 results for today's date).
  New service helpers in `src/services/parlamento.ts`: `searchPersone`, `fetchLeggiPiuCitate` (with
  filters), `fetchLegge`, `fetchLegislatura`, `fetchOggiNellaStoria`, `leggeUrl`, `leggeTipoLabel`.

- **2026-05-16** -- Senato listing URL param: corrected `?leg=N&anno=Y` -> `?year=Y`. The page's own year-selector anchors all use `?year=YYYY` (verified by enumerating anchors with text matching `^(19|20)\d{2}$`). `?anno=YYYY` is silently ignored and falls back to the current year's listing. The earlier 2026-05-16 "year= -> leg=&anno=" commit had it backwards; that mistake was masked by an unrelated WAF firewall block (`*.token.awswaf.com` was missing from `EXTRA_ALLOWED_DOMAINS`) that returned zero rows for any URL, so both params looked equally broken. With the firewall fix and the correct `?year=` param, `scrapeSenatoListing(context, 19)` returns all 420 leg-19 sedute distributed across 2022-2026. Added `scripts/probe-senato-scraper.ts` as an end-to-end smoke test for the listing pipeline; the per-URL `probe-senato-listing.ts` and the one-off `probe-senato-year-links.ts` led to the diagnosis (year-links script then removed once the answer was known).

- **2026-05-14** -- Two big findings on the Senato side, both via a Playwright PoC (`server/scripts/senato-playwright-poc.ts`):
  1. **WAF wall is solvable.** Headless Chromium (system `/usr/bin/chromium`, no Playwright browser download needed) executes the AWS WAF JS challenge, captures the `aws-waf-token` cookie, and reaches the actual transcript body. PoC ended on HTTP 200 with ~64KB HTML containing the full stenografico (header "419a SEDUTA PUBBLICA / RESOCONTO STENOGRAFICO", presidency block, etc.). Only `navigator.webdriver` masking was required. Workspace egress firewall must allow `f92e3446b0c3.c1cdd57a.eu-central-1.token.awswaf.com` (already added to `.env.example`); VPS prod has no firewall. The earlier "TERMINAL FINDING 2026-05-04" section is now marked SUPERSEDED.
  2. **SPARQL IDs are wrong.** Every `html_url` we persisted from the SPARQL index pass uses the 5-digit `dati.senato.it/sedutaassemblea/<ID>` ID space, but `show-doc` actually uses a completely different 7-digit ID space (e.g. SPARQL gives `id=24326`, real show-doc URL needs `id=1506236`). All `show-doc` requests with our stored IDs return HTTP 500 -- this was misread as a server-side issue, it's "document does not exist". The 7-digit IDs are only discoverable by scraping the chronological listing page (`/lavori/assemblea/resoconti-elenco-cronologico?year=Y`). Implication: when we wire the Playwright ingest, the index pass needs to scrape the listing (not just hit SPARQL) to map numero -> show-doc URL.
  Also added `--all-legislatures` flag to `scripts/ingest.ts parlamento` so the operator can backfill Camera legs 1..19 in one shot. Loop is sequential, mutually exclusive with `--legislatura N`; each leg's index probe bails after 40 consecutive 404s when there's no data, so empty legs cost ~8s each. Production usage: `docker exec fixitalia-backend node dist/scripts/ingest.js parlamento --chamber camera --all-legislatures`. Requires a new image build (the script is compiled into `dist/scripts/`).

- **2026-05-05** -- BM25 fully restored after the index rebuild + an unrelated bug fix in the route layer. Two distinct issues that compounded to "search works but feels broken":
  1. `idx_int_text` was simply absent in SurrealDB (not stuck, not erroring -- gone). Two prior rebuild attempts had been aborted before completing. Re-issued `DEFINE INDEX idx_int_text ... CONCURRENTLY` and let it run for ~70 minutes. Sustained throughput on the 112,082-row corpus was ~30 docs/sec (initial burst was ~90/sec; rate halves as the inverted index grows and tree depth increases). Disk usage afterwards: still well under 1GB. SurrealDB v2.1.4 quirk: a finished concurrent build leaves `building.status: "built"` on `INFO FOR INDEX` permanently -- the `building` object never disappears, so monitor scripts must treat `built` (not the absence of `building`) as the success terminal state.
  2. Even after the index built, `/search` still returned `score: null` and empty `snippet` strings while reporting `mode: "bm25"`. Root cause: the route's WHERE used the bare `testo @@ $q` form, but `search::score(0)` and `search::highlight(..., 0)` need an indexed reference like `testo @0@ $q` to resolve. Both syntaxes parse, both syntaxes match the same rows, but the bare `@@` form gives the score/highlight functions no anchor to bind to and they silently return null. Nothing fails loudly -- the rows come back, just unranked and unsnippeted. Fixed by switching both BM25 sites in `server/routes/parlamento.ts` (the global `/search` route and the per-oratore `/oratori/:slug` route) from `@@` to `@0@`. Also updated the in-file comment that *thought* it was already explaining indexed references but was actually documenting the broken syntax. Verified end-to-end: `/search?q=sumud` returns `mode=bm25`, score=17.4, snippet with `<mark>` tags. Common terms like "governo" still return ranked hits but the query takes ~9s because `search::score` evaluates the entire posting list -- workload-dependent, not an index health issue. Backend tests (76) + tsc clean.

- **2026-05-05** -- Camera deputies bulk pre-fetch + group display in the seduta sidebar.
  - Problem: `SedutaIndex.tsx` showed speakers without their parliamentary
    group because Camera transcripts only embed an `idPersona` link, not
    a group label. The group lives in `parlamento_deputati.gruppo_attuale`,
    which until now was populated **lazily** only when a user opened a
    single oratore profile (`routes/parlamento.ts:930`). Every speaker
    on a freshly-loaded seduta therefore had `gruppo=null`.
  - Fix: added `server/lib/ingest/parlamento/cameraDeputatiBulk.ts` --
    walks every `camera-id-*` slug from `parlamento_oratori`, scrapes the
    official deputy page once, persists into `parlamento_deputati`, and
    **denormalises `gruppo_attuale` onto `parlamento_oratori.gruppo`** so
    the seduta read path stays a single query (`oratore_id.gruppo` in
    SELECT/GROUP BY, alongside the existing `oratore_id.slug`). The
    orchestrator runs this as a third Camera phase after index + body
    (skipped for Senato -- WAF wall, no scrapable profile pages). Also
    exposed as a standalone `parlamento-deputati` subcommand in
    `scripts/ingest.ts` so groups can be refreshed without re-ingesting
    sessions. ~444 leg-19 deputies, ~5 min cold cache, 7-day TTL.
  - Two latent bugs surfaced and fixed:
    1. `parlamento_deputati.{circoscrizione,collegio,lista_elezione,formazione}`
       are `option<string>` but SurrealDB v2.1.4 rejects an explicit `null`
       on `option<T>` (it wants the field absent). Same UNSET-vs-SET-null
       trap applies to the `parlamento_oratori.gruppo` denorm UPDATE.
       Fix: strip null/undefined keys before insert (mirrors
       `cameraSession.ts:344-348`); branch on `UPDATE ... UNSET` when the
       group is null. Applied to both the bulk module and the lazy
       profile route at `routes/parlamento.ts:987`.
    2. `cameraDeputatoScraper.ts:htmlToCleanText` only decoded `&#39;`
       not the zero-padded `&#039;` that Camera uses for apostrophes
       inside group names ("Fratelli d&#039;Italia"). Replaced the
       single-entity replace with a generic `&#NNN;` / `&#xHH;`
       numeric-entity decoder.
  - UI: `SedutaIndex.tsx:154` wraps the rendered group in parens.
  - Caveat: a handful of deputies still come back with `gruppo=null` --
    these are seats currently held by ministers/sottosegretari whose
    Camera page omits the GRUPPO PARLAMENTARE block. If we want their
    cabinet role shown there instead, that's a separate scraper field.

- **2026-05-04 (latest)** -- Performance pass on `/api/parlamento/sedute/:chamber/:numero(/interventi)` and `/api/parlamento/search`. Two root causes:
  1. Every "Apri seduta" was issuing three queries shaped like
     `WHERE seduta_id.chamber = $c AND seduta_id.numero = $n`. Traversing
     INTO a record link in WHERE bypasses `idx_int_seduta(seduta_id, posizione)`
     and forces a full scan of the 112k-row interventi table -- ~6.1s per
     query, ~15-20s per page. Fix: resolve the seduta record id once via
     `SELECT id FROM parlamento_sedute WHERE chamber=$c AND legislatura=$l
     AND numero=$n LIMIT 1`, project the raw RecordId object alongside its
     stringified form, and bind the raw id into the child queries as
     `WHERE seduta_id = $sed`. Same logical filter, same JSON output, but
     the index actually fires (~7ms total for the lookup + child).
     Per-seduta interventi count now reads from `parlamento_sedute.interventi_n`
     (written by the body-pass ingest) instead of running a fresh count.
  2. `/search` was failing to BM25 because the `count() ... WHERE testo @@ $q
     GROUP ALL` query errors with "no suitable index" when the FTS index is
     missing or rebuilding, and the route's catch promoted that to a full
     substring fallback for both the SELECT and the count (~1.7s each).
     Fix: don't count BM25 hits at all -- fetch `LIMIT pageSize + 1` and
     surface a `has_more` boolean, frontend renders "20+" when set. The
     fallback now only fires when the SELECT itself fails.
  Also kicked off a `DEFINE INDEX idx_int_text ... CONCURRENTLY` rebuild
  to recover from the hung-build state that prompted commit bb22845.
  CONCURRENTLY is non-blocking so the route stays serviceable; build runs
  ~30 docs/sec single-threaded so full corpus is ~50 min.

- **2026-05-04** -- Confirmed Senato body content is unreachable
  programmatically due to AWS WAF challenge on every transcript URL on
  www.senato.it. Implemented Option A: Senato index continues to ingest
  metadata via SPARQL, but body pass marks sessions `body_status =
  "waf_blocked"` and the reader shows a disclaimer card with a link to the
  official viewer. Orchestrator's `listPending` skips `waf_blocked` on
  scheduled runs (use `--refresh` to retry). All 417 leg-19 Senato sessions
  bulk-marked. Bug fix in `init-firewall.sh`: `IFS=$'\n\t'` made
  `for d in $EXTRA_ALLOWED_DOMAINS` not word-split on space, so the entire
  domain list was treated as one giant pseudo-domain and never resolved.
  Switched to `read -ra` + array iteration. Also added periodic ipset
  refresh (`refresh-firewall-ips.sh` invoked every 60s by
  `workspace-entrypoint.sh`) to handle Akamai/CloudFront IP rotation,
  which previously broke connectivity to Senato/Camera within minutes
  of container start. Sudoers rule lets the container user trigger an on-demand
  refresh from inside the workspace via `sudo refresh-firewall-ips.sh`.

- **2026-05-04 (later)** -- Implemented Senato SPARQL index pass in
  `server/lib/ingest/parlamento/senatoIndex.ts`. Replaces the no-op
  deferred stub with a two-pass approach: introspect the LOD schema first
  (COUNT per type, pick the matching class), then query for all sedute with
  property-path alternatives (`dct:date|dc:date`, `rdfs:label|dct:title`,
  etc.) so the code adapts to whichever ontology version the endpoint serves.
  HTML listing scraping kept as a fallback. Also fixed `init-firewall.sh`
  deadlock: `iptables -F` leaves DROP policies in place, so a re-run blocked
  itself from fetching GitHub IP ranges. Fixed by resetting policies to ACCEPT
  before flushing. Workspace must be restarted from host to apply the rule
  refresh and add `dati.senato.it` to egress allowlist.

- **2026-05-04** -- Added in-process daily auto-fetch scheduler
  (`server/lib/scheduler.ts`). Zero deps, polls every 60s, fires once
  per day at 06:00 Europe/Rome by default. Boot-time tick reads
  `parlamento_ingest_state.updated_at` so dev's `tsx --watch` reloads
  don't keep retriggering today's ingest. Tied into `server/server.ts`
  via `startParlamentoScheduler()` and configured via the new
  `PARLAMENTO_AUTOFETCH_*` env vars. Also explicitly inventoried the
  Senato gap as the largest remaining open question (the index pass
  inserts zero rows until a SPARQL/PDF/headless workaround lands).

- **2026-05-03** -- First implementation on `feat/parlamento-reader`
  off `develop`. Schema, ingest pipeline, API, reader UI all in one
  branch. Frontend type-check + lint + 42 tests green; backend
  type-check clean modulo node_modules. Camera ingest probes the
  documenti.camera.it XML pattern; Senato ingest scrapes the
  chronological listing. SurrealDB analyzer + BM25 SEARCH index is
  the project's first FTS index. Reader UI introduces persistent font
  / size / line-height prefs and a per-intervention copy-link.
