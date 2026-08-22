# Data claims audit 2026-08

## Overview

Full audit of every headline number and every factual claim on the site, prompted by the spesa pubblica figure being challenged from outside. Method: for each section, recompute the KPI independently from the upstream source, then read every user-facing string and check the claim against what the query actually computes.

The recurring failure mode is not arithmetic. **Every wrong number on the site was a correct number with a wrong label**, or a static caption asserting a fact the data no longer supported. The arithmetic was sound everywhere it was checked.

## Verified correct against upstream

| Section | Figure | Upstream check |
|---|---|---|
| Fondi Europei | 357.367.903.853 EUR monitored, 198.907.052.451 EUR paid, 55,7% share, 1.838.162 projects, updated 2026-04-30 | matches the OpenCoesione `aggregati` API to the euro |
| Fondi Europei | 11 temi, 20 regioni, 5 project states | counts match; per-state pagamenti sum to the headline total |
| Appalti | 48.040 rows, 45.202 ATTIVO, 2.838 CESSATO | ANAC registry; ATTIVO + CESSATO reconciles to the total |
| Appalti | 20 regions covered, 109 legal forms, top-20 cities | counts and limits match the copy |
| Parlamento | legislature XIII-XIX, 9.817 sedute (4.820 Camera, 4.997 Senato), 1996-05-09 to 2026-08-07, 9.812 body_status ok | supports "dalla XIII legislatura a oggi, quasi trent'anni" |
| Le tue tasse | IRPEF 2026 brackets 23/33/43, detrazioni clawback 440 EUR over 200.000 | legge di bilancio 2026 |
| Le tue tasse | INPS prima fascia 56.224 EUR, aliquota aggiuntiva 1% | INPS circolare 6 del 30 gennaio 2026 |
| Le tue tasse | Gestione Separata 26,07%, minimale 18.808, massimale 122.295 | INPS circolare 8 del 3 febbraio 2026 |
| Le tue tasse | artigiani 4.521,36 / commercianti 4.611,64 fissi, minimale 18.808, aliquote 24% / 24,48% | INPS circolare 14 del 9 febbraio 2026 |
| Le tue tasse | full breakdown at 30.000 RAL, dipendente, media nazionale | hand-recomputed from the statute, agrees to the euro at every line |
| `tax-regions.ts` | 21 entries (19 regions + Trento + Bolzano) plus a national-average fallback | complete; each carries its MEF 2026 source URL |

## Defects found and fixed

**Wrong numbers**

1. **Spesa pubblica headline was a two-month figure labelled as a full year.** 195.477.227.576 EUR (Jan-Feb 2026, 33 missions) captioned "nel 2025 ... tutte le 34 missioni". Real 2025 total: 1.154.165.459.884 EUR. Own note: `project-kb/Spesa pubblica snapshot semantics.md`.
2. **`/api/parlamento/sedute` over-reported its total** when a chamber filter and a date range were combined: 187 instead of 115, so the paginator advertised 38 pages where 23 had rows. Own note: `project-kb/SurrealDB count() drops predicates.md`.
3. **`/api/parlamento/legislature/:n` returned no date range at all.** `math::min`/`math::max` on a `datetime` return nothing in SurrealDB, so `data_inizio` / `data_fine` were absent from the response and the legislature header rendered an empty period. Fixed to `time::min` / `time::max`.
4. **The forfettario simulator had no contribution ceiling.** 200.000 EUR of compensi on gestione separata produced 40.669 EUR of contributions where the legal maximum is 31.882 EUR (122.295 x 26,07%). Capped, with the pre-1996 exemption stated as an explicit assumption. It also computed a 15% flat tax for revenue above the regime's 85.000 EUR legal ceiling with no warning; the input now says the result is not valid above it.

**Wrong labels on correct data**

5. **Fondi Europei yearly chart presented a cumulative series as annual flows.** The OpenCoesione series is strictly monotone increasing; summing its 37 points gives 1.822 mld against a real total of 199. Captioned "anno per anno ... per ciascun anno", it invited the reading that 185 mld were paid out in 2026 alone, when the 2026 increment is about 0,7 mld. Relabelled as cumulative.
6. **`sections.spesaPubblica.description` described a section that was never built**: regional and municipal spending from SoldiPubblici against ISTAT per-capita indicators. SoldiPubblici was abandoned at design time (the portal redirects to an AgID maintenance page). Rewritten to describe BDAP payments by mission.
7. **`sections.fondiEuropei.description` promised a PNRR countdown** that does not exist and could not: the OpenCoesione aggregati feed covers the cohesion cycles, not the PNRR.
8. **Home lede claimed "oltre quattrocento opere" incompiute** against a registry holding 266.
9. **Home lede said the Parlamento section was "In arrivo."** It had been live for months, with 9.817 sedute.
10. **"34 missioni" was hardcoded in three places.** True for a December snapshot, false for an early-year one, and false in production at the time.
11. **Appalti natura chart said "le dieci categorie"** while the route keeps `TOP_K = 9` plus an "Altre categorie" bucket -- ten bars, nine categories.
12. **Appalti regional chart presented itself as complete.** 1.864 active stations have a province code ANAC does not map to a region, so the bars sum to 43.338 against a 45.202 KPI. The gap is now disclosed on the chart.
13. **Addizionale comunale hint said the cap is "0,9% nei capoluoghi".** The general ceiling is 0,8%; 0,9% is specific to Roma Capitale.
14. **Empty-archive hint told the operator to exec into `fixitalia-dev`**, a container that stopped existing at the collapsed-workspace migration.

**Delivery**

15. **`useQuery` CACHE_VERSION had to be bumped to 4.** Responses are cached in `localStorage` for 24h and read stale-while-revalidate, so without the bump every returning visitor would keep the old wrong spesa figures for a day *and* render the new copy around a cached `anno`, producing "nell'intero 2026, per tutte le 33 missioni" over a February number. Reproduced in the browser against a corrected backend before bumping. Any response-shape change in `server/routes/` needs this bumped in the same commit.

## Second pass: what the first sweep missed

The first pass worked from a list of strings I had already read, which is exactly the wrong method. Re-grepping the live copy for quantity words and years turned up six more:

16. **`sections.fondiEuropei.short` still read "Fondi di coesione e PNRR".** The `description` had been corrected; the label next to it had not.
17. **"anno per anno" survived in two live strings**, including one *introduced by the fix* for defect 5. Having just established the series is cumulative, the rewrite reused the phrasing that made it wrong.
18. **`server/scripts/ingest.ts` still told the operator to exec into `fixitalia-dev`**, the same dead container found in the UI copy at defect 14. Also now points at `openDataRefresh` as the routine path.
19. **`TAX_YEAR` was exported and never used.** The tax year lived as a literal in two separate strings (`dataBadge`, the first assumption). Same defect class as the incident itself: a fact about the data written by hand in the copy. Both now interpolate `TAX_YEAR`; "legge di bilancio 2026" stays literal on purpose, since it names the law that introduced the 33% bracket and stays true in later tax years.
20. **"quasi trent'anni" of parliamentary records** understated an archive running 1996-05-09 to 2026-08-07.
21. **`sections.*.short` and `sections.*.description` were dead across all six sections** -- only `title` and `route` are ever read (Layout nav, page headers, the home grid). Unrendered copy drifts, and by audit time **three of the six promised features that do not exist**:
    - `parlamento`: "presenze, voti, proposte presentate contro approvate". There is no voting or attendance data at all -- no table, no route, no code mentioning it. `short` was literally "Presenze e voti".
    - `opereIncompiute`: "mappa geografica e storico dei fondi già spesi". No map component; a single reference year.
    - `appalti`: "aste con un solo offerente, affidamenti diretti ripetuti, differenze anomale tra base e aggiudicazione". The ingest deliberately covers only the stazioni appaltanti registry and none of the CIG / aggiudicazioni datasets those claims would need.

    Deleted rather than corrected, along with the equally dead `common.mockDataNotice` ("Dati di esempio -- verranno sostituiti con i dati ANAC ufficiali"). Copy nothing renders cannot be kept honest, and each of these would have become visible and wrong the moment someone wired the field up. The reasoning is recorded as a comment on the `sections` object so the deletion is not silently undone.

`common.comingSoon`, `common.comingSoonBody` and `common.viewAll` are also unused but left in place: they are generic UI scaffolding, not claims about data.

## Third pass: cross-endpoint reconciliation

The first two passes checked each number against its upstream and each string against its query. Neither checked whether the numbers on a single page agree with *each other*. A script now asserts 25 cross-endpoint invariants (chart bars vs KPI totals, quote summing to 1, list pagination totals vs counts, per-state sums vs headline sums, snapshot years differing between the two spesa periods). It found one more defect and confirmed everything else:

22. **The Appalti legal-form chart dropped 330 active stations without saying so.** Its bars summed to 44.872 against a 45.202 KPI: ANAC leaves `natura_giuridica` empty on 330 active stations, and the `IS NOT NONE` filter excluded them from every bar *and* from the "Altre categorie" tail, despite the copy describing that bucket as the long tail of rarer classifications. (ANAC also ships an explicit "Non Classificato" value; that one is a real category and is charted. These are rows with no value at all.)

The same disclosure was extended to the Opere Incompiute regional chart, where 1 of 266 works has no region. All three regional/categorical charts now reconcile exactly:

```
appalti natura : 44.872 + 330   = 45.202  (stazioni attive 45.202)
appalti regione: 43.338 + 1.864 = 45.202  (stazioni attive 45.202)
opere regione  :    265 + 1     =    266  (opere censite 266)
```

Also fixed in this pass:

23. **"Mostriamo l'ultima graduatoria pubblicata"** on the Opere Incompiute page was false. MIT has published the 2024 reference year (regional PDFs dated June 2025 on mit.gov.it) while the section serves 2023, because `dati.mit.gov.it` has been returning 503. The copy now points at the reference-year badge instead of claiming to be current.

## Known-acceptable, documented, not changed

- **`ITALY_POPULATION = 59_000_000`** in `routes/appalti.ts` feeds only the "una stazione ogni N cittadini" ratio. ISTAT's figure is ~58,9M; the difference moves the ratio from 1.305 to 1.303.
- **The 440 EUR detrazioni clawback is applied to the wrong set of detrazioni.** In statute it bites the oneri al 19%, not the art. 12/13 detrazioni the module models. Harmless today because all of those are already zero at 200.000 EUR of reddito complessivo, so the clamp is a no-op. Commented in place; move it if a 19% oneri input is ever added.
- **Le tue tasse attributes addizionale regionale and comunale to state missions.** They fund Regioni and Comuni. The split is explicitly labelled notional and an assumption now says so; kept because the card's purpose is to show the whole income-tax burden.
- **Fondi Europei "Concluso" shows pagamenti (103,6 mld) above stanziamenti (103,3 mld).** Upstream's own figures; per-state pagamenti reconcile to the national total.
- **"Bolzano .bozen." with provincia "--"** in the top-cities table is an ANAC name-mangling artifact, not a computation error.

## Open questions

- **Opere incompiute is the one section not verified against upstream.** `dati.mit.gov.it` returned 503 on every attempt across the whole audit (catalog page, CKAN API, `package_list`), while `www.mit.gov.it` was up. From the latter we know MIT has published reference year **2024**; the section serves **2023**, so it is at least one year stale. The 266-work count could not be checked against the source file, and MIT's own 2022 announcement cited 372 works and ~2,5 mld, so the drop to 266/1,6 mld is plausible but unconfirmed.
  What is verified: the page labels its data with the reference year taken from the file itself, the figure is internally consistent (265 charted + 1 unmapped = 266 = list total = KPI), and the ingest's filename regex would match a 2024 annual file, so `openDataRefresh` will pick it up on its own once the portal answers. The staleness is upstream availability, not a code defect. Re-check when MIT returns.
- `count()` inside the ingest paths was not audited for the predicate-dropping bug.
- No mechanism prevents defect class 6-10 from recurring: a static caption asserting a fact about the data. Everything now derives its year and counts from the API, but nothing enforces it. A lint rule banning digits in `sectionLedes` / `finding` strings would.
- Nor does anything catch dead i18n keys, which is how defect 21 accumulated three false feature promises unnoticed. `ts-prune` or a `knip` pass over `src/i18n/it.ts` in CI would have flagged all of them.

## History

### 2026-08-17 -- audit performed

Triggered by an external reader challenging the spesa pubblica figure. Scope then widened to every headline number on the site at the user's request, since the site is in production.

Verification ran against the locally served site (`localhost:5183`) with a freshly refreshed DB, cross-checked against the upstream APIs directly. All fifteen defects fixed in the same pass; frontend and backend lint, type-check and tests green (97 + 109).
