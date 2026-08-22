# Open data refresh scheduling

## Overview

The four open-data sources (spesa pubblica, opere incompiute, fondi europei, appalti) used to be ingested **only when their table was empty**. `server.ts` probed `count()` per table at boot and ingested if zero; otherwise it logged "already has N rows, skipping ingest" and did nothing, forever.

That is a stale-data generator with extra steps. Whatever snapshot won the race on the first boot stayed. In production the BDAP spesa snapshot was from around April 2026 and still being served in August, with four newer monthly packages published in between and nothing anywhere saying so.

## Current solution

`server/lib/openDataRefresh.ts` owns all four sources. It mirrors the Parlamento scheduler (`lib/scheduler.ts`) and reuses its wall-clock helpers: one daily fire in Europe/Rome (default 04:30, clear of the 06:00 Parlamento auto-fetch), a 60s polling tick so DST and restarts are handled for free, all knobs from env (`OPENDATA_REFRESH_ENABLED`, `_HOUR`, `_MINUTE`, `_TZ`).

Differences from the Parlamento scheduler:

- **Staleness-gated.** Each source declares `freshForDays`, derived from the publisher's cadence: spesa 7 (BDAP publishes monthly), opere 30 (MIT publishes annually), fondi and appalti 14. A source inside its window is skipped without an HTTP call, so the daily tick usually costs four SurrealDB probes and nothing else. The windows are deliberately much shorter than the publication cadence: a redundant check costs one small download, a missed one costs months of stale figures on a page that claims to be current.
- **Sequential.** Four concurrent ingests hammering four ministries' portals buys nothing; the whole pass is a few tens of MB and has all day.
- **`needsReingest` hook.** A source can force a refresh when its stored rows predate a schema change. This is the *only* mechanism available for that: the VPS deploy key is pinned to `docker compose pull && up -d` and cannot run a migration script, so a migration has to announce itself from inside the process. Used by spesa to detect rows written before the `periodo` split -- without it the section would have rendered empty after the deploy, since every read now filters on `periodo`.
- **A boot pass runs immediately**, which subsumes the old empty-table bootstrap and applies any pending migration. Staleness is read from the DB, so a restart loop cannot turn this into repeated downloads.

Failures are loud and per-source: one unreachable ministry portal must not stop the other three, and a failed refresh logs that the section keeps serving its previous snapshot rather than looking like a successful no-op.

## Gotcha: `math::max` on a datetime returns nothing

The first version of the staleness probe used `math::max(ingested_at)`. SurrealDB's `math::*` aggregates are numeric only: applied to a datetime they return **nothing at all** -- the key is simply absent from the result row, no error, no null. Every source therefore looked like it had no ingest timestamp, which would have made the check re-download all four sources on every boot (and in dev, on every `tsx --watch` reload).

Use `time::max` / `time::min` for datetimes. The same bug was found and fixed in `routes/parlamento.ts` `/legislature/:n`, where `math::min(data)` / `math::max(data)` meant the endpoint answered `{"n":705}` with no date range at all and the legislature header rendered an empty period.

## Solved: the empty-table window on every re-ingest

All four ingests used to do `DELETE <table>` and then insert in batches. Readers arriving in that window got an empty result set, which the pages render as **0 EUR** and empty charts -- a wrong number, not a loading state.

Observed in production on 2026-08-17, not theorised: the first probe of the live API right after the `v0.7.0` deploy returned `anno: null, totalCount: 0, totalePagato: 0` while a re-ingest was mid-flight.

It used to be almost unreachable, because the ingests only ran on an empty table. Adding the daily staleness-gated refresh above turned it into a routine exposure: once per upstream release per source, and the wider the source the longer the window. Appalti measured **37 seconds** of zeros.

`lib/snapshotSwap.ts` now owns every write. The new rows load into `<table>_staging`, which nothing reads, and then move across in one transaction:

```sql
BEGIN TRANSACTION;
DELETE <table>;
INSERT INTO <table> (SELECT * FROM <table>_staging);
COMMIT TRANSACTION;
```

The transaction stays small and fast whatever the row count, because the rows move server-side and the SQL never carries them.

Three properties were probed against this SurrealDB rather than assumed:

- **Atomicity.** A `THROW` between the DELETE and the INSERT left the pre-existing rows intact.
- **Isolation.** A reader on a separate connection, polling once a second while a transaction held the table deleted for six seconds (`SLEEP 6s`), saw the old row count the entire time -- never zero, never partial.
- **Id rebinding.** `INSERT INTO t (SELECT * FROM t_staging)` rewrites `t_staging:abc` to `t:abc`, so the id suffix carries over and nothing needs remapping.

Then verified end to end: a forced 48k-row appalti re-ingest took 37s, and the live API reported the full 45.202 active stations at every 2-second poll throughout. Afterwards: 48.040 live rows, staging emptied, `ingested_at` stamped, ids on the right table.

Fondi Europei passes all five of its tables to `swapSnapshots` as one set, so they move in a single transaction. That matters more there than anywhere else: the page reads them together, and a reader must never catch new KPI totals beside stale regional rows.

`ingested_at` is stamped by the helper rather than left to the live table's `DEFAULT time::now()`, so the timestamp does not depend on how defaults behave for rows created by an `INSERT ... SELECT`. The staleness check above reads that field, so it has to be right.

**What this does not cover.** It protects a re-ingest of *equivalent* data. It cannot help a schema migration that changes what the read queries match: if the live rows lack a column the new filters require, holding on to them serves zero rows just the same. That is inherent, one-off per migration, and is what `needsReingest` exists to get through quickly -- it is also exactly the case that was caught in production, so the fix would not have prevented that particular sighting, only every routine refresh after it.

## Open questions

- MIT (`dati.mit.gov.it`) was returning HTTP 503 on 2026-08-17, so the opere incompiute refresh could not be verified and it is unknown whether a graduatoria newer than the 2023 one exists. The registry currently holds 266 works for reference year 2023; MIT's own 2022 announcement cited 372 works and ~2,5 mld. A drop of that size is plausible but unconfirmed -- re-check when the portal is back.
- No alerting. A source that fails to refresh for weeks logs loudly but nothing watches the log. A "last successful refresh" field surfaced in `/api/health` would make it observable.
- The staleness windows are guesses calibrated to publication cadence, not measured. If BDAP slips a month the spesa section silently keeps the previous snapshot, correctly labelled but old.

## History

### 2026-08-17 (later) -- atomic swap, and the mobile overflow it surfaced

Replaced delete-then-insert with the staged swap described above, after catching the empty-table window in production. See that section for the probes.

Separately, the corrected spesa figure is longer than the wrong one it replaced (19 glyphs vs 18) and made a pre-existing responsive bug visible: on a phone the stat strip was a two-column grid whose cells are ~156px, and a number with no spaces has no break opportunity, so "195.477.227.576 €" was already printing on top of the neighbouring stat. Fixed in `src/components/PageStats.tsx`, which now carries the measured cell widths per breakpoint. Worth knowing: at `lg` a four-column strip fits the widest number with **one pixel** to spare, which is why the four-column layout starts at `xl`.

### 2026-08-17 -- created

Written while fixing the spesa pubblica snapshot bug (see `project-kb/Spesa pubblica snapshot semantics.md`), because a correct ingest that never re-runs would have gone stale again within the month.

The boot pass on the dev DB behaved as intended on the first run: it detected 33 pre-split rows, forced a re-ingest, and landed the two correct snapshots; fondi and appalti refreshed on staleness; opere failed loudly on MIT's 503 and kept its previous data.
