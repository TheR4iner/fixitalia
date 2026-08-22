# Camera deputati historical URLs

## Overview

**RESOLVED 2026-05-17.** The current solution is the SPARQL-based
scraper at `cameraHistoricalDeputatoSparql.ts`. The mitigation
(non-current-leg skip guard) has been removed from the orchestrator.

The `scrapeCameraDeputato` HTML scraper builds profile URLs as
`https://www.camera.it/deputati/elenco/{leg}-{id_persona}/` which
resolves only for the **currently sitting legislature** (leg 19 today).
For historical legs the URL 404s. Instead of finding a working
historical-HTML URL pattern, we query the Linked Open Data ontology
at `dati.camera.it/sparql` keyed by the same numeric `id_persona`.

## Current solution

`cameraDeputatiBulk` dispatches by leg:
- Leg 19 (current): `scrapeCameraDeputato` (HTML scrape, existing path)
- Legs 1-18: `fetchCameraDeputatoViaSparql` (SPARQL, new path)

Both produce the same `DeputatoSnapshot` shape so `applyMandatoProfile`
doesn't care which path filled the row.

The SPARQL scraper issues two queries per (id, leg): scalar deputato
fields + mandato/election dates, and the multi-row group adherence
history. URLSearchParams (which encodes spaces as `+`) is used in
place of `encodeURIComponent` (which uses `%20`) because the
Italian gov SPARQL endpoints' WAF rejects `%20` on multi-OPTIONAL
queries -- this was the most surprising part of the integration.

`storia.camera.it` was the first option investigated. Its deputy
LISTING is gated by Google reCAPTCHA (the `/deputati/faccette/...`
endpoint), making it Playwright-only. Detail pages themselves are
unprotected but use slug URLs derived from name + birthdate that
don't map cleanly from our numeric `id_persona`. The SPARQL endpoint
gives the same data without either obstacle.

## Previous mitigation (now removed)

In `server/lib/ingest/parlamento/index.ts` the camera-deputati bulk
pass was **skipped** unless `legislatura === CURRENT_LEGISLATURE` (now
removed). Without this guard, every `--all-legislatures` run wasted
~7-8 minutes per past legislature on a 100% HTTP 404 storm (668
deputies for leg 15, etc.).

The shared `CURRENT_LEGISLATURE` constant lives in
`server/lib/ingest/parlamento/constants.ts` and is imported by the
orchestrator, the senato listing scraper, and the ingest CLI. Bump that
constant when leg 20 starts.

**Cost of the mitigation**: camera legs 15-18 have populated
parlamento_persona + parlamento_mandato rows (created during body
pass) but the per-leg facts (`gruppo_attuale`, `circoscrizione`,
`formazione`, `gruppo_storico`, etc.) are all `NONE`. Speeches are
fully searchable but the frontend can't show "(PD), Lombardia 1" next
to historical speakers' names.

## How the mitigation was retired

Done in feat/parlamento-historical-data branch (this branch). The key
realization was that we didn't need to find a working historical HTML
URL at all -- the same data lives in `dati.camera.it/sparql` keyed by
the numeric `id_persona`. See `cameraHistoricalDeputatoSparql.ts` for
the SPARQL queries.

Steps taken:
1. Probed `storia.camera.it` (CAPTCHA wall on listings, slug-based
   detail URLs) and ruled it out as the primary source.
2. Discovered the OCD ontology at `dati.camera.it/sparql` exposes
   `deputato.rdf/d{id_persona}_{leg}` resources with full profile data.
3. Wrote `fetchCameraDeputatoViaSparql` that issues two queries
   (scalar fields + group history) and returns a `DeputatoSnapshot`.
4. Updated `cameraDeputatiBulk` to dispatch by leg.
5. Removed the `legislatura === CURRENT_LEGISLATURE` guard from
   the orchestrator.

## Open questions

- All previously listed questions are resolved by the SPARQL-based
  approach. Possible future improvements: parse the `professione`
  blank node (it's an `osr:Professione` resource with `titolo` +
  dates) into `formazione` text -- currently skipped.

## History

- **2026-05-17 (afternoon)** -- Mitigation retired. SPARQL-based
  scraper at `cameraHistoricalDeputatoSparql.ts` is now the canonical
  path for legs 1-18. The orchestrator guard is gone. The narrative
  arc: discovery (5ffb496 added the skip guard after finding the 404
  storm) -> proper fix (SPARQL bypass) -> guard removed.

- **2026-05-17 (morning)** -- Note created to track the mitigation in
  commit `5ffb496`. Discovered during the first end-to-end
  --all-legislatures simulation: leg 15's deputati pass reported
  `failed=668 scraped=0` in 427s. The fix was to skip the bulk pass
  for past legs while a real solution was investigated.
