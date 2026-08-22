# Spesa pubblica snapshot semantics

## Overview

BDAP publishes "Pagamenti Bilancio dello Stato per Missione" as **one package per accounting month**, each holding the *cumulative* payments from January through that month:

- `spd_<mmm>_spe_pbs_mis_01_<yyyy>_01` -- cumulative through `<mmm>`
- `spd_rnd_spe_pbs_mis_01_<yyyy>` -- end-of-year consuntivo

The consequence that broke production: **a single "latest package" is not a yearly total.** Selecting whichever package was published most recently yields a partial year-to-date figure, and BDAP's publication order does not track accounting coverage (the 2025 consuntivo was `metadata_modified` 2026-07-13, *after* five 2026 monthlies were already out).

## The bug as shipped

Production displayed:

> PAGAMENTI TOTALI DELLO STATO
> **195.477.227.576 EUR**
> Somma complessiva dei pagamenti del Bilancio dello Stato nel 2025, per tutte le 34 missioni funzionali.

Every clause of that caption was wrong. The figure is exactly the sum of `spd_feb_spe_pbs_mis_01_2026_01`: **January-February 2026**, **33** missions. The real 2025 total is **1.154.165.459.884 EUR** across 34 missions (cross-checked: the December monthly and the `rnd` consuntivo agree to the cent, for both 2024 and 2025; and the figure is consistent with the Corte dei Conti Rendiconto 2025 headline of ~903 mld of spese finali in impegni, the rest being rimborso prestiti and partite di giro).

Three independent defects stacked:

1. **`resolveLatestMissioneSnapshot` sorted by `metadata_modified` and took the first.** Publication recency is not coverage.
2. **The year, the month and the mission count were literals in `src/i18n/it.ts`.** The badge read the real values from the API; the KPI caption did not, so the page contradicted itself and the wrong half was the prominent one.
3. **The ingest ran once, ever.** `server.ts` only ingested when the table was empty, so the snapshot that won the first boot stayed forever. Production held the February 2026 snapshot for months while four newer ones were published.

## Current solution

`server/lib/ingest/spesaPubblica.ts` resolves **two** snapshots and tags every row with `periodo`:

| `periodo` | Package | Meaning |
|---|---|---|
| `annuale` | December of the most recent year that has one | a genuine full-year total |
| `progressivo` | most recent monthly package overall | year-to-date, `null` when the newest package *is* a December |

Selection is by the year and month parsed out of the package **name**, never by timestamp. `selectSnapshots()` is pure and exported, and `lib/ingest/spesaPubblica.test.ts` pins it against the real catalogue listing including the timestamps that made the old ordering pick February 2026.

`spd_rnd` is excluded from selection. It carries figures identical to the December monthly but drops `Mese contabile` and spells the amount header `Totale pagato` with a lowercase p -- so under the old strict `COLUMN_MAP` it would have produced 34 rows with no amount at all and a silent **0 EUR** on the page. Header lookup is now normalised (lowercased, whitespace-collapsed) and `parseSnapshot` *throws* rather than publish a zero: it asserts at least one row resolved an amount, that the total is positive, and that every row has a `Codice Missione`.

The mission count is a property of the snapshot, not a constant: early-year snapshots legitimately have fewer than 34 rows (a mission with no payments yet is simply absent). It is logged when it is not 34 and interpolated into the UI copy.

Every read query **must** filter on `periodo`. Without it the two snapshots are summed and the total is meaningless. See `routes/spesaPubblica.ts`.

## Open questions

- Should the year-to-date card be promoted, or is the closed-year total the only headline? Currently: closed year is the headline, YTD is a secondary card explicitly marked "non confrontabile con un anno intero".
- The `Totale Pagato` column exceeds the sum of the component columns (822 mld vs 1.154 mld for 2025), so BDAP's total includes channels not broken out in the file. Not currently surfaced anywhere; worth understanding before we ever chart the components.
- "Debito pubblico" alone is 31% of the total. That is BDAP's own functional classification, but a reader may take it as discretionary spending. Possibly worth a note on the page.

## History

### 2026-08-17 -- diagnosis and fix

Reported from the live site: "il bilancio dello Stato non puo' essere 200 miliardi". Confirmed by enumerating all 135 `mis_01` packages in the BDAP catalogue and summing each one's CSV; the displayed figure matched `spd_feb_..._2026_01` exactly.

Changes:
- Two-snapshot resolution by parsed coverage, `periodo` persisted per row, `rnd` excluded, both header spellings tolerated, loud validation on parse.
- `ckanPackageSearchAll` added: BDAP does not respond within 120s at `rows=200` but returns in ~7s at `rows=100`, and one page does not cover the series anyway.
- All read queries constrained on `periodo`; `/kpis` now returns a `progressivo` block; `by-missione` and the list endpoint return their `anno` and use the real `fonte_url` instead of a hardcoded catalogue-search URL.
- Every year / month / count claim in `src/i18n/it.ts` became a function of the resolved snapshot.
- `useQuery` `CACHE_VERSION` bumped to 4. Without it returning visitors would have kept the old wrong numbers for 24h and rendered the new copy around a cached `anno`, producing "nell'intero 2026, per tutte le 33 missioni" over a February figure -- reproduced in the browser before bumping.

Verified end to end against live BDAP: `annuale` = `spd_dic_..._2025_01`, 34 missioni, 1.154.165.459.884 EUR; `progressivo` = `spd_giu_..._2026_01`, 34 missioni, 613.956.044.076 EUR.

See also `project-kb/Open data refresh scheduling.md` and `project-kb/SurrealDB count() drops predicates.md`.
