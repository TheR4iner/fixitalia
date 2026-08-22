# SurrealDB count() drops predicates

## Overview

In the SurrealDB version this project runs, `SELECT count() ... GROUP ALL` with **more than one indexable predicate** can answer the aggregate from a single index and **silently ignore the remaining conjuncts**. No error, no warning: just a number that is too large.

This is not a NONE-comparison quirk and not a corrupted index. It is the aggregate path choosing one index and discarding the rest of the WHERE.

## Reproductions on real data in this database

```
-- appalti_stazioni: idx_appalti_stato AND idx_appalti_regione both apply
count() WHERE stato = "ATTIVO" AND regione = "Sicilia"     -> 3.247   (true: 3.090)
count() WHERE regione = "Sicilia" AND stato = "ATTIVO"     -> 45.202  (!)
count() WHERE stato = "ATTIVO" AND regione = NONE          -> 1.896   (true: 1.864)
count() WHERE stato = "CESSATO" AND regione = NONE         -> 1.896   (true: 32)

-- parlamento_sedute: idx_seduta_chamber AND idx_seduta_data both apply
count() WHERE chamber = "camera" AND data >= 2026-01-01 AND data <= 2026-12-31
                                                            -> 187     (true: 115)
count() ... WITH NOINDEX                                    -> 115     (correct)
```

**The diagnostic tell**: swapping the order of two conditions changes which predicate is dropped. 3.247 is every Sicilia row regardless of `stato`; 45.202 is every ATTIVO row regardless of region.

## What is NOT affected

Verified against materialised `array::len((SELECT VALUE id FROM ... WHERE ...))` of the same filters:

- **`GROUP BY` aggregates** apply every predicate correctly. The per-region counts on `appalti_stazioni` sum to exactly the materialised figure.
- **Plain materialised SELECTs** are correct. This is the ground truth to check against.
- **Single-predicate `count()`** is correct.
- **`count()` whose fields are covered by one composite index** was correct in the cases tested (`parlamento_odg` on `idx_odg_chamber_leg` + a date range; `parlamento_riferimenti` on `idx_ref_lookup(tipo, anno, numero)` + `legislatura`). Do not treat this as a rule -- verify.

## Current solution

Three safe patterns, in order of preference:

1. **Verify against a materialised count** and leave a comment saying you did. Cheapest when the query is not hot.
2. **Derive by arithmetic** from counts that each carry a single predicate. `routes/appalti.ts` `/by-regione` computes `senzaRegione = count(stato=ATTIVO) - sum(GROUP BY regione counts)`, both of which are individually trustworthy. Exact, no extra query.
3. **`WITH NOINDEX`** forces a scan and is always correct, but costs ~1,4s on the 175k-row tables (`parlamento_odg`, `parlamento_riferimenti`) versus ~70ms on the 9,8k-row `parlamento_sedute`. Use only where the table is small.

For existence checks prefer `SELECT id ... LIMIT 1` over `count() > 0`: it cannot be wrong and it is cheaper. `lib/openDataRefresh.ts` does this for its migration probe.

The trap is documented at the top of `server/lib/query.ts`, which every query in the project passes through.

## Open questions

- Exact trigger condition is not pinned down. "Two separate single-field indexes" fits every failure observed and "one composite index covering the fields" fits every success, but that model is inferred from a handful of cases, not from the planner source. Until it is, treat any multi-predicate `count()` as suspect.
- Worth re-testing after a SurrealDB upgrade; if fixed upstream, the `WITH NOINDEX` on the `/sedute` count can go.
- Not audited: `count()` inside the ingest paths (as opposed to the read routes). They mostly gate on single predicates, but this has not been checked exhaustively.

## History

### 2026-08-17 -- found while auditing headline numbers

Surfaced by accident. While adding a disclosure of how many active stazioni appaltanti have no mapped region, the two numbers on the page refused to add up: 43.338 bars + 1.896 unmapped = 45.234 against a KPI of 45.202. Chasing the 32-row gap led to the reproductions above.

The user-visible consequence found in production: `/api/parlamento/sedute` with a chamber filter *and* a date range reported `total = 187` where the true count is 115, so the paginator advertised 38 pages when only 23 had rows and pages 24-38 rendered empty.

Note that the *list* query immediately above that count already carried `WITH NOINDEX`, with a comment documenting a closely related planner bug: with a date range present, SurrealDB served the rows in index (ascending) order and silently ignored `ORDER BY data DESC`, so "Più recenti" returned the oldest sessions of the range first. Same family of problem, and the count query had been left unguarded.

Fixed: `WITH NOINDEX` on the `/sedute` count, subtraction for the appalti disclosure, `LIMIT 1` probe in `openDataRefresh`, and the warning block in `lib/query.ts`.
