import { Router, type Request, type Response, type NextFunction } from 'express'

import { runQuery } from '../lib/query.ts'
import { clampInt } from '../lib/http-params.ts'

// -----------------------------------------------------------------------------
// Read-side API for the Appalti section.
//
// Powered by ANAC's "Stazioni Appaltanti" registry: one row per contracting
// authority in Italy, about 45k active stations. Endpoints:
//
//   GET /api/appalti/kpis          -> headline counts
//   GET /api/appalti/by-natura     -> top legal forms (with 'altre' bucket)
//   GET /api/appalti/by-regione    -> all 20 regions by station count
//   GET /api/appalti/top-citta     -> top cities by station count (pagination)
//
// Note on ORDER BY: SurrealDB's GROUP BY + ORDER BY on aggregated aliases is
// flaky in v2 -- the server does not reliably apply the requested sort to
// aggregate outputs. We sort the grouped results in JS after fetching,
// which is fine because no aggregation produces more than ~120 rows
// (natura giuridica ~100, regione 20, citta ~8k but we LIMIT).
// -----------------------------------------------------------------------------

const router = Router()

const SOURCE_URL = 'https://dati.anticorruzione.it/opendata/dataset/stazioni-appaltanti'

// Rough Italian population snapshot used for the "one station per X residents"
// KPI. Kept as a constant rather than pulled from ISTAT because the value
// only needs to be in the right ballpark for the finding to land.
const ITALY_POPULATION = 59_000_000

// ---- /kpis ------------------------------------------------------------------

interface CountRow {
  n: number
}

interface NaturaGroupRow {
  natura_giuridica: string | null
  n: number
}

interface RegioneGroupRow {
  regione: string | null
  n: number
}

router.get('/kpis', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Fire the three aggregates in parallel.
    // IMPORTANT: do NOT alias the grouping column with AS in a SurrealDB
    // GROUP BY -- it silently collapses the whole query into one row
    // containing the last-seen key value and the total count. Always
    // SELECT the raw column name and only alias the aggregate.
    const [attiveRows, regioniRows, natureRows] = await Promise.all([
      runQuery<CountRow[]>(
        `SELECT count() AS n FROM appalti_stazioni WHERE stato = "ATTIVO" GROUP ALL;`,
      ),
      runQuery<RegioneGroupRow[]>(
        `SELECT regione, count() AS n
         FROM appalti_stazioni
         WHERE stato = "ATTIVO" AND regione IS NOT NONE
         GROUP BY regione;`,
      ),
      runQuery<NaturaGroupRow[]>(
        `SELECT natura_giuridica, count() AS n
         FROM appalti_stazioni
         WHERE stato = "ATTIVO" AND natura_giuridica IS NOT NONE
         GROUP BY natura_giuridica;`,
      ),
    ])

    const attive = attiveRows?.[0]?.n ?? 0
    const regioniCoperte = regioniRows?.length ?? 0
    const categorieGiuridiche = natureRows?.length ?? 0
    const abitantiPerStazione = attive > 0 ? Math.round(ITALY_POPULATION / attive) : 0

    res.json({
      data: {
        attive,
        regioniCoperte,
        categorieGiuridiche,
        abitantiPerStazione,
      },
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// ---- /by-natura -------------------------------------------------------------

interface NaturaResponseRow {
  nome: string | null
  count: number
}

router.get('/by-natura', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Second return value: how many active stations the `IS NOT NONE` filter
    // drops. ANAC leaves the legal form empty on ~330 of them, so the bars sum
    // to less than the "stazioni attive" KPI -- and they are not in the "Altre
    // categorie" tail either, despite the copy describing it as the long tail
    // of rarer classifications. (ANAC also has an explicit "Non Classificato"
    // value, which IS a category and IS charted; these are rows with no value
    // at all.) Derived by subtraction for the reason given in /by-regione.
    const [rows, attiveRows] = await Promise.all([
      runQuery<NaturaGroupRow[]>(
        `SELECT natura_giuridica, count() AS n
         FROM appalti_stazioni
         WHERE stato = "ATTIVO" AND natura_giuridica IS NOT NONE
         GROUP BY natura_giuridica;`,
      ),
      runQuery<CountRow[]>(
        `SELECT count() AS n FROM appalti_stazioni WHERE stato = "ATTIVO" GROUP ALL;`,
      ),
    ])

    // Sort in JS because SurrealDB's ORDER BY on grouped aggregates is unreliable.
    const sorted = (rows ?? []).slice().sort((a, b) => b.n - a.n)
    const classified = sorted.reduce((sum, r) => sum + r.n, 0)
    const senzaNatura = Math.max(0, (attiveRows?.[0]?.n ?? 0) - classified)

    // The legal-form classification has ~100 distinct values but the top 9
    // together cover >90% of all stations. Fold the long tail into an
    // "Altre categorie" bucket so the bar chart stays readable.
    const TOP_K = 9
    const top = sorted.slice(0, TOP_K)
    const rest = sorted.slice(TOP_K)
    const tail: NaturaResponseRow | null = rest.length
      ? {
          nome: 'Altre categorie',
          count: rest.reduce((sum, r) => sum + r.n, 0),
        }
      : null

    const payload: NaturaResponseRow[] = [
      ...top.map((r) => ({ nome: r.natura_giuridica, count: r.n })),
      ...(tail ? [tail] : []),
    ]

    res.json({ data: payload, senzaNatura, source: SOURCE_URL })
  } catch (err) {
    next(err)
  }
})

// ---- /by-regione ------------------------------------------------------------

interface RegioneResponseRow {
  regione: string | null
  count: number
}

router.get('/by-regione', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // `senzaRegione` is reported alongside the bars, not swallowed. ANAC ships
    // ~1.900 active stations whose province code does not map to a region, so
    // the bars sum to less than the "stazioni attive" KPI. Returning the gap
    // lets the chart say so instead of leaving the reader to notice that two
    // numbers on the same page disagree.
    //
    // It is derived by SUBTRACTION rather than queried directly, and that is
    // deliberate. A count() with two indexable predicates is not trustworthy
    // in this SurrealDB version -- it answers from one index and drops the
    // rest. Measured here:
    //
    //   count() WHERE stato = "ATTIVO" AND regione = NONE      -> 1.896 (wrong)
    //   count() WHERE stato = "ATTIVO" AND regione = "Sicilia" -> 3.247 (wrong)
    //   materialised array::len of the same filters             -> 1.864 / 3.090
    //
    // In both cases the `stato` conjunct is silently ignored, so the numbers
    // returned are the totals across ATTIVO *and* CESSATO. The two queries
    // below are each safe: the GROUP BY applies both predicates correctly
    // (its per-region counts match the materialised ones), and the total is a
    // single-predicate count. Their difference is exact.
    const [rows, attiveRows] = await Promise.all([
      runQuery<RegioneGroupRow[]>(
        `SELECT regione, count() AS n
         FROM appalti_stazioni
         WHERE stato = "ATTIVO" AND regione IS NOT NONE
         GROUP BY regione;`,
      ),
      runQuery<CountRow[]>(
        `SELECT count() AS n FROM appalti_stazioni WHERE stato = "ATTIVO" GROUP ALL;`,
      ),
    ])
    const sorted = (rows ?? []).slice().sort((a, b) => b.n - a.n)
    const payload: RegioneResponseRow[] = sorted.map((r) => ({
      regione: r.regione,
      count: r.n,
    }))
    const mapped = sorted.reduce((sum, r) => sum + r.n, 0)
    const attive = attiveRows?.[0]?.n ?? 0
    res.json({
      data: payload,
      senzaRegione: Math.max(0, attive - mapped),
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// ---- /top-citta -------------------------------------------------------------

interface CittaAggRow {
  citta: string | null
  provincia: string | null
  regione: string | null
  n: number
}

interface CittaResponseRow {
  citta: string | null
  provincia: string | null
  regione: string | null
  count: number
}

router.get('/top-citta', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = clampInt(req.query.limit, 20, 1, 50)

    const rows = await runQuery<CittaAggRow[]>(
      `SELECT citta, provincia, regione, count() AS n
       FROM appalti_stazioni
       WHERE stato = "ATTIVO" AND citta IS NOT NONE
       GROUP BY citta, provincia, regione;`,
    )
    // Filter out the "N.a." / "N.d." placeholder rows that ANAC uses for
    // records where the city is not reported, and rows missing a region.
    const sorted = (rows ?? [])
      .filter((r) => {
        const c = (r.citta ?? '').trim().toLowerCase()
        if (!c || c === 'n.a.' || c === 'n.d.' || c === 'na') return false
        if (!r.regione) return false
        return true
      })
      .sort((a, b) => b.n - a.n)
      .slice(0, limit)

    const payload: CittaResponseRow[] = sorted.map((r) => ({
      citta: r.citta,
      provincia: r.provincia,
      regione: r.regione,
      count: r.n,
    }))

    res.json({ data: payload, source: SOURCE_URL })
  } catch (err) {
    next(err)
  }
})

export default router
