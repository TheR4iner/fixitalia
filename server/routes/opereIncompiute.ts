import { Router, type Request, type Response, type NextFunction } from 'express'

import { runQuery } from '../lib/query.ts'
import { clampInt } from '../lib/http-params.ts'

// -----------------------------------------------------------------------------
// Read-side API for the Opere Incompiute section.
//
// Three endpoints, all returning JSON:
//   GET /api/opere-incompiute/kpis        -> headline KPIs for the page
//   GET /api/opere-incompiute/by-region   -> aggregated counts and totals
//   GET /api/opere-incompiute             -> paginated list (offset, limit, regione)
//
// We hand-build SurrealQL queries rather than using the SDK's query builder
// so the queries are transparent and easy to reason about. Values that come
// from query strings are clamped to safe ranges and never interpolated into
// the SQL: WHERE filters use SurrealDB's bind parameters.
// -----------------------------------------------------------------------------

const router = Router()

// MIT open-data catalogue page, echoed as `source` on every response so the
// UI can always link back to the publisher.
const SOURCE_URL = 'https://dati.mit.gov.it/catalog/dataset/opere-incompiute'

// -------- /kpis ---------------------------------------------------------------

interface KpiRow {
  total_count: number
  total_intervento: number | null
  total_oneri: number | null
  avg_avanzamento: number | null
  anno_riferimento: number | null
}

interface RegionCountRow {
  regione: string | null
}

router.get('/kpis', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Two small queries in parallel: an aggregated row for the headline
    // numbers, and a grouped query we use only for its row count (number
    // of distinct regions represented). SurrealDB's aggregate function
    // `count` does not have a DISTINCT form, so we express "how many
    // distinct regions" as "how many groups the GROUP BY produces".
    //
    // anno_riferimento is the year the upstream MIT graduatoria reports on.
    // We surface the max so the freshness badge stays in sync with whatever
    // ingest most recently picked up from CKAN.
    const [aggRows, regionRows] = await Promise.all([
      runQuery<KpiRow[]>(
        `SELECT
           count()                       AS total_count,
           math::sum(importo_intervento) AS total_intervento,
           math::sum(importo_oneri)      AS total_oneri,
           math::mean(perc_avanzamento)  AS avg_avanzamento,
           math::max(anno_riferimento)   AS anno_riferimento
         FROM opere_incompiute
         GROUP ALL;`,
      ),
      runQuery<RegionCountRow[]>(
        `SELECT regione
         FROM opere_incompiute
         WHERE regione IS NOT NONE
         GROUP BY regione;`,
      ),
    ])
    const kpi = aggRows?.[0] ?? {
      total_count: 0,
      total_intervento: 0,
      total_oneri: 0,
      avg_avanzamento: 0,
      anno_riferimento: null,
    }
    res.json({
      data: {
        totalCount: kpi.total_count ?? 0,
        totalIntervento: kpi.total_intervento ?? 0,
        totalOneri: kpi.total_oneri ?? 0,
        avgAvanzamento: kpi.avg_avanzamento ?? 0,
        regioniCoperte: regionRows?.length ?? 0,
        annoRiferimento: kpi.anno_riferimento ?? null,
      },
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// -------- /by-region ----------------------------------------------------------

interface RegionAggRow {
  regione: string | null
  count: number
  total_intervento: number | null
  avg_avanzamento: number | null
}

router.get('/by-region', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // `senzaRegione` is derived by subtraction, not queried. Same reason as in
    // routes/appalti.ts: a count() with an indexable predicate is not
    // trustworthy in this SurrealDB version. The GROUP BY applies its filter
    // correctly and the bare total is single-predicate, so the difference is
    // exact. Reported so the chart can say what it omits instead of quietly
    // summing to less than the "opere censite" KPI.
    const [rows, totalRows] = await Promise.all([
      runQuery<RegionAggRow[]>(
        `SELECT
           regione,
           count()                       AS count,
           math::sum(importo_intervento) AS total_intervento,
           math::mean(perc_avanzamento)  AS avg_avanzamento
         FROM opere_incompiute
         WHERE regione IS NOT NONE
         GROUP BY regione
         ORDER BY count DESC;`,
      ),
      runQuery<Array<{ count: number }>>(
        `SELECT count() AS count FROM opere_incompiute GROUP ALL;`,
      ),
    ])
    const mapped = (rows ?? []).reduce((sum, r) => sum + (r.count ?? 0), 0)
    const total = totalRows?.[0]?.count ?? 0
    res.json({
      data: (rows ?? []).map((r) => ({
        regione: r.regione,
        count: r.count ?? 0,
        totalIntervento: r.total_intervento ?? 0,
        avgAvanzamento: r.avg_avanzamento ?? 0,
      })),
      senzaRegione: Math.max(0, total - mapped),
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// -------- / (paginated list) --------------------------------------------------

interface OperaRow {
  id: string
  titolo: string | null
  stazione_appaltante: string | null
  provincia: string | null
  regione: string | null
  cup: string | null
  stato: string | null
  importo_intervento: number | null
  importo_oneri: number | null
  perc_avanzamento: number | null
  anno_riferimento: number | null
}

interface CountRow {
  count: number
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = clampInt(req.query.limit, 25, 1, 100)
    const offset = clampInt(req.query.offset, 0, 0, 10_000)
    const regioneParam = typeof req.query.regione === 'string' ? req.query.regione.trim() : ''

    const bindings: Record<string, unknown> = { lim: limit, off: offset }
    let whereClause = ''
    if (regioneParam) {
      whereClause = 'WHERE regione = $regione'
      bindings.regione = regioneParam
    }

    const listQuery = `
      SELECT
        type::string(id) AS id,
        titolo, stazione_appaltante, provincia, regione, cup, stato,
        importo_intervento, importo_oneri, perc_avanzamento,
        anno_riferimento
      FROM opere_incompiute
      ${whereClause}
      ORDER BY importo_intervento DESC
      LIMIT $lim START $off;
    `
    const countQuery = `
      SELECT count() AS count
      FROM opere_incompiute
      ${whereClause}
      GROUP ALL;
    `

    const [rows, countRows] = await Promise.all([
      runQuery<OperaRow[]>(listQuery, bindings),
      runQuery<CountRow[]>(countQuery, bindings),
    ])

    res.json({
      data: (rows ?? []).map((r) => ({
        id: r.id,
        titolo: r.titolo,
        stazioneAppaltante: r.stazione_appaltante,
        provincia: r.provincia,
        regione: r.regione,
        cup: r.cup,
        stato: r.stato,
        importoIntervento: r.importo_intervento,
        importoOneri: r.importo_oneri,
        percAvanzamento: r.perc_avanzamento,
        annoRiferimento: r.anno_riferimento,
      })),
      pagination: {
        total: countRows?.[0]?.count ?? 0,
        limit,
        offset,
      },
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

export default router
