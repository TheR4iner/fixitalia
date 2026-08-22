# Data ingestion pattern

## Overview

How we turn Italian government open-data publications into something the
frontend can query in real time. The MIT Opere Incompiute section is the
reference implementation; every other section should follow the same shape
unless there is a concrete reason not to.

The problem: every primary source (ANAC, OpenCoesione, OpenCUP, MIT, MEF/RGS,
SoldiPubblici, ISTAT, Parlamento Italiano) publishes data as bulk files
(CSV / XLS / XML / JSON dumps) with different update cadences. None of them
expose live REST endpoints that match the shape our pages need. Fetching
from the portal on every page view is not viable -- the files are tens of
megabytes at best, gigabytes at worst.

The solution: pull each dataset into a local SurrealDB once (or on whatever
schedule the source publishes), then serve aggregated queries from our own
backend at sub-second latency.

## Current solution

### Components

- **SurrealDB** sidecar container (`surrealdb/surrealdb:v2.1.4`). Started
  by docker-compose, bind-mounted at `./server/data/surreal`, reachable
  inside the compose network at `http://fixitalia-surrealdb:8000/rpc`.
  Credentials are `root/root` -- this is a local-only dev setup, the port
  is exposed only on `localhost:8011` via the compose mapping.
- **HTTP transport**, not WebSocket. Node 20 does not ship a global
  `WebSocket` constructor, so the SurrealDB JS v2 SDK's WebSocket engine
  fails at `new WebSocketImpl(...)`. The HTTP engine works for everything
  we need (query, insert, batch). If we ever need live queries we should
  add a `ws` polyfill via the `--ws` feature flag rather than switch base
  images, as changing the base image has other cascades.
- **`server/lib/db.ts`** -- lazy singleton `Surreal` client. First call
  connects and stashes the instance, subsequent callers reuse it. Lazy
  init is important so the backend boots even if SurrealDB is still
  coming up; the first route that needs the DB is what actually opens
  the connection. **Authentication is passed as a callback**
  (`() => ({ username, password })`) so the SDK can refresh an expired
  session token without us writing reconnect plumbing. A static auth
  object signs in only once and eventually produces "token has
  expired" errors on every query.
- **`server/lib/query.ts`** -- shared `runQuery<T>(sql, bindings)`
  helper every route file uses. It unwraps the first-statement result
  and adds a belt-and-braces retry: if the SDK reports "token has
  expired" / "invalid session", it calls `resetDb()` and retries the
  query once. This is the single source of truth for query behaviour
  across all sections.
- **`server/lib/parse.ts`** -- shared `parseNumericValue` and
  `cleanString` helpers. Italian gov data mixes US and Italian number
  formats even within a single file; both helpers live here so every
  ingest file pulls them from the same place.
- **`server/lib/schema.ts`** -- idempotent `DEFINE TABLE / FIELD / INDEX`
  statements, re-runnable on every startup. Extend this file with new
  tables, do not create per-table schema files.
- **`server/lib/ingest/<source>.ts`** -- one file per source. Each
  exports an `ingest<Source>()` function that downloads, parses, and
  upserts. The MIT version is the reference template.
- **`server/scripts/ingest.ts`** -- CLI entry point with one subcommand
  per source. Run it from inside the dev container:
  `docker exec -w /app/server fixitalia-dev npx tsx scripts/ingest.ts opere-incompiute`.
- **`server/server.ts`** bootstrap block -- on startup the backend runs
  `runSchema()` and then checks whether each expected table is empty. If
  empty, it triggers that source's ingest automatically so a fresh clone
  works without any manual steps. The bootstrap runs in the background
  and never blocks HTTP binding.
- **Read-side routes** under `server/routes/<source>.ts`. Each file owns
  a Router with the three canonical endpoints: `/kpis`, `/by-region`,
  `/` (paginated list). Queries are plain SurrealQL strings with bind
  parameters, no ORM.

### SurrealDB gotchas we learned the hard way

- `db.insert(table, rows)` requires `table` to be a `new Table('name')`
  object, **not** a plain string. Passing a string makes SurrealDB
  interpret the name as a value and the server errors out with
  "Can not execute INSERT statement using value 'name'". The `Table`
  class is a named export from `surrealdb`.
- `option<T>` in SurrealQL schema means "absent", **not** "NULL". If you
  insert a record with `field: null` on an `option<number>` column, the
  server rejects it with "Found NULL ... expected a option<number>". The
  fix is to strip null/undefined fields from records before inserting so
  missing fields are simply absent.
- There is no `count(DISTINCT x)` aggregate. To count distinct values,
  run a `GROUP BY x` query and count the resulting rows in JavaScript,
  or use a nested subquery. Trying `count(array::distinct(x))` fails
  because at aggregation time `x` is a scalar per row, not an array.
- Record IDs returned by the SDK are object-shaped when you `SELECT id`
  directly. If you want string IDs, cast them in the query with
  `type::string(id) AS id`.
- HTTP SQL endpoint wants the headers `surreal-ns` and `surreal-db`, not
  `NS` and `DB`. Different headers than the WebSocket RPC.

### Source-specific notes

**MIT Opere Incompiute**:
- We use the **2023** XLS, the most recent published release (deadline
  30/06/2024, reference year 2023). MIT changed the publication schema
  starting with the 2021 reference year: the file dropped from ~80
  detail columns down to ~18 summary columns. We lost per-row
  Settore / Categoria / Natura / Importo lavori / Importo SAL /
  Indirizzo / Descrizione, and gained `Stato dell'opera incompiuta`,
  `Provincia dell'intestatario`, and `Importo oneri` (the
  legally-required estimate of the cost still needed to complete the
  work). The KPI lineup adapts: we surface `total_oneri` instead of
  the missing `total_lavori_sal`.
- The file is **legacy binary .xls** (OLE2 Compound Document, magic
  bytes `D0 CF 11 E0`). exceljs cannot read it. We use SheetJS
  (`xlsx`), pinned to the **patched 0.20.x release distributed via
  the SheetJS CDN**, NOT the npm version which has two unpatched
  high-severity CVEs (prototype pollution + ReDoS). Install URL:
  `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.
- The XLS sheet embeds **regional subtotal rows** ("TOTALE OPERE 16"
  etc., one per region). The ingest filters rows whose `titolo`
  starts with `TOTALE` so they don't inflate the aggregates. Without
  this filter the sheet's 284 data rows include 18 totale rows and
  every aggregate is roughly doubled.
- Numbers are inconsistently formatted across cells: some use US
  format (`9,075,000.00`), some Italian (`9.075.000,00`), some bare.
  The `parseNumericValue` helper handles all three via a
  last-separator-wins heuristic.
- ISTAT codes in the MIT dataset are 9 digits (region-province-comune),
  not the shorter 6-digit form. The first 3 digits encode the region
  (e.g. `003` = Lombardia). We also support NUTS 2006/2010 codes
  (`ITE3` = Marche, `ITD3` = Veneto) alongside the newer NUTS 2013+
  codes (`ITI3`, `ITH3`) because the older MIT snapshots used the
  legacy vintage. The 2023 file uses the modern vintage.
- As of the 2023 snapshot: **266 real rows** across **18 regions**
  (Trentino-Alto Adige and Valle d'Aosta have no entries in 2023);
  **1.62 billion EUR** total intervention value; **1.11 billion EUR**
  oneri to complete; **23.8% average completion**.

**BDAP Spesa Pubblica (Pagamenti Bilancio dello Stato per Missione)**:
- Originally we planned to use **SoldiPubblici** (soldipubblici.gov.it)
  for this section. That site is currently redirecting to the AgID
  maintenance page -- totally unavailable, not just the API. We
  pivoted to BDAP, which is the authoritative upstream anyway
  (SoldiPubblici was always a derived view on top of SIOPE, while
  BDAP is the primary database managed by MEF-RGS).
- BDAP has a **CKAN v3 API** at
  `https://bdap-opendata.rgs.mef.gov.it/SpodCkanApi/api/3/action/*`.
  The legacy v1 REST API at `/SpodCkanApi/api/rest/*` also works.
  The base `/SpodCkanApi/v3/*` path (without `/api`) returns 404,
  which is a pitfall: the Tomcat frontend is picky about the path.
- Dataset UUIDs are the primary IDs. `package_show?id=<name>` returns
  "Dato non trovato" for the human-readable slug; you must use the
  UUID. Get it via `package_search?fq=tags:<Tag>`, then take
  `result.results[0].id`.
- The CKAN metadata exposes CSV download URLs with scheme
  **`http://`**. But port 80 is effectively dead on
  `bdap-opendata.rgs.mef.gov.it` (TCP connections to it time out
  after 2+ minutes with no response). **Always rewrite to `https://`
  before fetching** or the ingest hangs until it hits the curl
  timeout. The `fetchCsv` in `spesaPubblica.ts` just uses an https
  URL directly; a future generic helper should force-upgrade.
- The CSVs are **semicolon-separated** (not comma), UTF-8, and use
  US-style numbers (dot decimal, no thousands separators). Our
  csv-parse call has to pass `delimiter: ';'` explicitly.
- The dataset we use is
  `spd_dic_spe_pbs_mis_01_2025_01` -- "Dicembre 2025 - Pagamenti
  Bilancio dello Stato per Missione". One row per state functional
  mission (34 missions total), cumulative through fiscal year end.
  Only ~14KB, so re-ingesting on every startup is cheap. BDAP also
  publishes monthly snapshots for the same year (`spd_ago_*`,
  `spd_apr_*`, etc.); `dic` is end-of-year cumulative.
- As of the December 2025 snapshot: **34 missions**, **EUR 1.154
  trillion** total state payments. The biggest single mission is
  `034 Debito pubblico` at EUR 360B (31% of the total), followed by
  `003 Relazioni finanziarie con le autonomie territoriali` at EUR
  148B (12.9% -- transfers to regions and local governments),
  `029 Politiche economico-finanziarie` at EUR 130B, and
  `025 Politiche previdenziali` (pensions) at EUR 109B.
- There is a companion dataset `spd_rnd_spe_sio_reg<nn>_01_<year>`
  (e.g. `reg12` = Lazio) with SIOPE regional spending data, one file
  per region per year. Powerful for a "spending by region" second
  slice but would need 20 downloads. Deferred.

**ANAC Appalti (stazioni-appaltanti registry)**:
- ANAC's open data catalog at `dati.anticorruzione.it/opendata/`
  exposes a full CKAN v3 API at `/opendata/api/3/action/*`. It is
  **protected by an F5 WAF** that rejects requests with no
  User-Agent or with suspicious UAs (curl default, python-requests
  default). Every fetch must send a realistic browser User-Agent
  and Accept headers. Symptom when it rejects: HTTP 200 with an
  HTML body titled "Request Rejected" carrying an F5 support ID.
- The full transaction-level datasets are gigabyte-scale:
  `aggiudicazioni` 758 MB, `aggiudicatari` 800 MB, `cig-<year>` and
  `smartcig-<year>` 1-2 GB each as monthly files. We deliberately
  do **not** ingest those for the first Appalti slice.
- We use `stazioni-appaltanti` instead: one row per contracting
  authority in the national registry, **3 MB zipped / 13 MB
  uncompressed**, 48,040 rows. The ZIP contains a single
  semicolon-delimited CSV. We extract with `fflate` which is a
  zero-native-deps zip library (30 KB).
- **SurrealDB GROUP BY gotcha**: *never* alias the grouping column
  with `AS <name>` in the SELECT. Writing
  `SELECT regione AS key, count() AS n FROM x GROUP BY regione`
  silently collapses the whole result into one row with
  `key = <last-seen-value>` and the total count. Always write the
  plain column name in the SELECT; only alias the aggregate.
- **SurrealDB ORDER BY gotcha**: ORDER BY on an aggregate alias in
  a GROUP BY query is unreliable in v2. Sort in JS after fetching.
  None of our aggregates produce more than ~120 rows so this is
  free.
- Boolean columns in the ANAC export ship as the literal strings
  `"true"` and `"false"`. Both `flag_inHouse` and `flag_partecipata`
  are 100% false across all 48k rows, so these KPIs are not worth
  surfacing -- ANAC does not actually tag in-house or partecipata
  stations in this feed.
- As of the April 2026 snapshot: **45,202 stations active + 2,838
  cessate**, 20 regions, 109 distinct legal forms. Roughly **one
  station per 1,305 Italian residents**, which is the brainstorm's
  fragmentation-of-public-procurement story in one number. Top
  legal form: "Enti Pubblici Non Economici" at 19,714 stations
  (~44% of all active). Top cities: Roma (2,070), Milano (910),
  Napoli (635), Torino (553), Palermo (401).

**OpenCoesione Fondi Europei (aggregati API)**:
- Uses the **REST API** at
  `https://opencoesione.gov.it/it/api/aggregati/` -- the one genuinely
  clean API of any Italian gov source we have touched so far. One HTTP
  call, 46KB JSON, no auth, returns **pre-computed** totals, regional
  rollups (20 regions), theme rollups (11 themes), and a year-by-year
  impegni+pagamenti time series. Fetches in ~350ms and populates
  four SurrealDB tables in one pass.
- The project-level bulk CSV (`progetti_esteso_aggregati.zip`) is
  **1.1GB uncompressed**. Do not use it for aggregate views -- the
  aggregati API already pre-computes everything the page needs. If we
  later need project-level drilldown (e.g. search for a specific
  project), a second ingest using streaming CSV parsing would be
  required.
- **Regional sums do not equal the top-level total.** SUM of the 20
  regions is EUR 515.7B but the API totale is EUR 346.6B -- a ~48%
  discrepancy. Multi-region projects are counted in **each** of their
  regions by the aggregati endpoint, so the regional breakdown
  double-counts. For the KPI total we store a separate `fondi_totali`
  one-row table populated from `aggregati.totali` and use that;
  never sum `fondi_regioni`.
- Region labels ship uppercased ("LOMBARDIA"). We title-case them at
  ingest time so charts read naturally.
- Numeric fields come as strings with Italian decimal comma
  ("22935693912,00"). Our shared `parseNumericValue` already handles
  both vintages so no special-case code is needed.
- Scope: the figures are cumulative across **all cohesion cycles**
  from 2000 onwards, not just 2021-2027. That is the correct framing
  for "how much EU money has ever flowed through each Italian
  region". If we later want a cycle-specific view, the per-cycle
  drill-down is accessible via the per-theme and per-region links
  in the JSON response.
- As of the Oct 31 2025 snapshot: **EUR 346.6B** total allocated
  (**EUR 283.2B** cohesion-specific), **EUR 186.3B** actually paid
  (**EUR 167.0B** cohesion-specific), **1,790,031** projects,
  **20 regions / 11 themes / 36 years of yearly data**. Top regions
  by allocation: Campania (EUR 83B), Sicilia (EUR 77B), Puglia (EUR
  62B), Calabria (EUR 45B), Sardegna (EUR 34B) -- the five
  Mezzogiorno regions.
- **tsx --watch and node --watch both have a brand-new-file blind
  spot**: when server.ts imports a file that did not exist in the
  previous run, the first soft reload after creating the file may
  not fully register the new route. Workaround: one `docker compose
  restart fixitalia-dev` after creating new ingest/route files is
  enough. Regular edits to existing files work reliably.

## Open questions

- We have no scheduled re-ingest yet. Current flow is "run the CLI
  manually". For production we should add a cron container or a GitHub
  Actions workflow that triggers the CLI against the deployed backend.
- SurrealDB is persisted via a host bind mount at `./server/data/surreal`.
  That directory is gitignored via `server/data/.gitkeep`. Make sure any
  backup scripts (when we have them) include it.
- The 2023 MIT data is richer (more works reported) and should replace
  the 2017 CSV once we decide to add a binary XLS reader. Candidates:
  `exceljs` handles xlsx only; for legacy xls we would need `xlsx`
  (SheetJS) or a manual CFB reader. Deferred.
- The ingest auto-trigger on startup is fine for local dev but noisy in
  production, where we would want scheduled jobs only. Guard the
  bootstrap with an env flag once we deploy.

## History

- **2026-04-11 (final)** -- Fourth full section: Appalti on
  `feat/appalti-anac`. AppaltiPage no longer uses mock data. Pivoted
  the page's story from the original "fraud detection" framing
  (which required gigabyte-scale transaction parsing) to "how
  fragmented is Italian public procurement?" which maps naturally
  onto ANAC's small `stazioni-appaltanti` registry (3 MB zipped,
  48,040 rows). Added `server/lib/ingest/appalti.ts` with an
  `fflate`-based zip extractor and the usual CSV parse pipeline,
  plus `server/routes/appalti.ts` with four endpoints (kpis,
  by-natura, by-regione, top-citta). Headline number:
  **one station every 1,305 Italian residents**. Two important
  SurrealDB gotchas discovered and documented:
  (a) aliasing the grouping column silently collapses GROUP BY
  into a single row, and
  (b) ORDER BY on aggregated aliases is unreliable in v2.
  Both worked around by sorting in JS.

- **2026-04-11 (later still)** -- Third full section: Fondi Europei via
  OpenCoesione's aggregati REST API on `feat/fondi-europei-opencoesione`.
  Added `server/lib/ingest/fondiEuropei.ts`,
  `server/routes/fondiEuropei.ts`, four new tables in `schema.ts`
  (`fondi_regioni`, `fondi_temi`, `fondi_yearly`, `fondi_totali`),
  `src/services/fondiEuropei.ts`, and a rewritten
  `src/pages/FondiEuropeiPage.tsx` with four KPI cards, a yearly
  impegni/pagamenti area chart, a themes horizontal bar chart, a
  regions horizontal bar chart, and a full regions table. One
  46KB API call populates all four tables in 350ms. Headline
  number as of Oct 2025: **EUR 346.6B** cumulative allocated, **EUR
  186.3B** paid (54%), **1.79M projects**. The regional breakdown
  double-counts multi-region projects which is why the totali are
  stored separately (EUR 515.7B SUM of regions vs EUR 346.6B API
  total).

- **2026-04-11 (even later)** -- Second full section: Spesa Pubblica
  via BDAP on `feat/spesa-pubblica-bdap`. Added `server/lib/ingest/
  spesaPubblica.ts`, `server/routes/spesaPubblica.ts`,
  `src/services/spesaPubblica.ts`, and rewrote
  `src/pages/SpesaPubblicaPage.tsx` with KPI cards, a vertical bar
  chart of all 34 state missions sorted by share-of-total, and a
  paginated table. Original plan was SoldiPubblici but that site is
  currently redirecting to the AgID maintenance page so pivoted to
  BDAP, which is the authoritative upstream (SoldiPubblici was
  always just a SIOPE front-end). Extracted `parseNumericValue` and
  `cleanString` from `ingest/opereIncompiute.ts` into a shared
  `server/lib/parse.ts` so the second ingest file does not
  copy-paste. The backend bootstrap grew a
  `BOOTSTRAP_SOURCES` array so adding future sections is a
  one-liner. As of Dec 2025 snapshot: 34 missions, EUR 1.154
  trillion total state payments; Debito pubblico is the single
  largest mission at EUR 360B (31.2% of total).

- **2026-04-11 (later)** -- Fixed SurrealDB session token expiry
  causing 500s after a few hours on `fix/surrealdb-session-refresh`.
  Changed `db.ts` to pass `authentication` as a callback so the SDK
  refreshes expired tokens automatically, added a `resetDb()`
  function, and extracted `runQuery` from
  `routes/opereIncompiute.ts` into `server/lib/query.ts` with a
  belt-and-braces retry that catches "token has expired" / "invalid
  session" errors, resets the client, and retries once.

- **2026-04-11 (later)** -- Upgraded from the 2017 CSV to the 2023 XLS so
  the data on screen is no longer 9 years old. Added SheetJS (xlsx,
  patched 0.20.3 from the SheetJS CDN since the npm version has two
  unpatched high-severity CVEs) for legacy binary .xls parsing. Schema
  shape changed: dropped fields the new MIT format no longer publishes
  (settore, categoria, natura, importo_lavori, importo_sal, indirizzo,
  descrizione), added new fields (provincia, stato, importo_oneri,
  opera_fruibile, uso_ridimensionato). KPI panel now shows
  `total_oneri` instead of `total_lavori_sal`. Filter added to drop
  the 18 "TOTALE OPERE N" subtotal rows MIT embeds in the sheet.
  Result: **266 real rows** for reference year **2023** across **18
  regions**, 1.62B EUR total intervention, 1.11B EUR oneri to
  complete, 23.8% average completion. Also rewrote `useQuery` for
  stale-while-revalidate semantics so a transient backend hiccup
  never throws the page back to a hard error screen if cached data
  exists, with a 30-minute in-memory TTL by default.

- **2026-04-11** -- Initial pattern established on `feat/opere-incompiute-ingest`.
  SurrealDB sidecar added to docker-compose, `server/lib/db.ts`,
  `schema.ts`, `regions.ts`, `ingest/opereIncompiute.ts`,
  `scripts/ingest.ts`, and `routes/opereIncompiute.ts` created. First
  real end-to-end data pipeline: MIT 2017 CSV -> SurrealDB -> three
  HTTP endpoints -> populated OpereIncompiutePage with KPIs, a
  clickable regional bar chart, and a paginated table. 647 real rows
  (later upgraded to the 2023 XLS, see entry above).
