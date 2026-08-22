import { Router, type Request, type Response, type NextFunction } from 'express'

import { runQuery } from '../lib/query.ts'
import { clampInt } from '../lib/http-params.ts'

// -----------------------------------------------------------------------------
// Read-side API for the Spesa Pubblica section.
//
// The data is from BDAP "Pagamenti Bilancio dello Stato per Missione", one row
// per functional mission of the Italian state budget.
//
// CRITICAL: `spesa_missioni` holds two snapshots at once (see
// lib/ingest/spesaPubblica.ts) discriminated by `periodo`:
//   'annuale'      full-year cumulative of the last complete year
//   'progressivo'  year-to-date cumulative of the year in progress
// Every query here MUST constrain `periodo`. An unconstrained aggregate adds
// a full year to a partial one and produces a number that means nothing.
//
// Endpoints:
//   GET /api/spesa-pubblica/kpis          -> headline numbers for KPI cards
//   GET /api/spesa-pubblica/by-missione   -> sorted list with share-of-total
//   GET /api/spesa-pubblica               -> paginated list of all missions
//
// The two list endpoints default to the annual snapshot and accept
// `?periodo=progressivo` to switch.
// -----------------------------------------------------------------------------

const router = Router()

// Fallback URL for the SourceLink when the DB has not yet been populated
// (first boot, before ingest finishes). After ingest completes, the resolved
// package URL stored on every row's fonte_url replaces this.
const FALLBACK_SOURCE_URL =
  'https://bdap-opendata.rgs.mef.gov.it/catalog?q=Pagamenti+Bilancio+dello+Stato+per+Missione'

const PERIODI = ['annuale', 'progressivo'] as const
type Periodo = (typeof PERIODI)[number]

function readPeriodo(raw: unknown): Periodo {
  return typeof raw === 'string' && (PERIODI as readonly string[]).includes(raw)
    ? (raw as Periodo)
    : 'annuale'
}

// -------- shared snapshot probe ----------------------------------------------

interface SnapshotRow {
  anno: number | null
  mese_contabile: string | null
  mese_numero: number | null
  fonte_url: string | null
  pacchetto: string | null
}

/**
 * Read the snapshot-level metadata for one periodo.
 *
 * anno / mese / fonte_url / pacchetto are identical across every row of a
 * snapshot, so a one-row probe is enough. They can't be folded into the
 * aggregate query because Surreal's math::* aggregates are numeric only and
 * silently produce NULL on string columns.
 */
async function snapshotMeta(periodo: Periodo): Promise<SnapshotRow | null> {
  const rows = await runQuery<SnapshotRow[]>(
    `SELECT anno, mese_contabile, mese_numero, fonte_url, pacchetto
     FROM spesa_missioni WHERE periodo = $periodo LIMIT 1;`,
    { periodo },
  )
  return rows?.[0] ?? null
}

// -------- /kpis ---------------------------------------------------------------

interface AggRow {
  periodo: string | null
  total_count: number
  totale_pagato: number | null
  max_pagato: number | null
}

interface TopRow {
  codice_missione: string | null
  missione: string | null
  totale_pagato: number | null
}

router.get('/kpis', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [aggRows, topRows, annualMeta, ytdMeta] = await Promise.all([
      runQuery<AggRow[]>(
        `SELECT
           periodo                      AS periodo,
           count()                      AS total_count,
           math::sum(totale_pagato)     AS totale_pagato,
           math::max(totale_pagato)     AS max_pagato
         FROM spesa_missioni
         GROUP BY periodo;`,
      ),
      runQuery<TopRow[]>(
        `SELECT codice_missione, missione, totale_pagato
         FROM spesa_missioni
         WHERE periodo = 'annuale'
         ORDER BY totale_pagato DESC
         LIMIT 1;`,
      ),
      snapshotMeta('annuale'),
      snapshotMeta('progressivo'),
    ])

    const aggFor = (periodo: Periodo): AggRow | undefined =>
      (aggRows ?? []).find((r) => r.periodo === periodo)

    const annual = aggFor('annuale')
    const ytd = aggFor('progressivo')
    const top = topRows?.[0]

    res.json({
      data: {
        // Headline: a genuine full-year total. `anno` and `missioni` are
        // derived here and rendered into the UI copy, never hard-coded on the
        // frontend -- that is what let a two-month figure ship as an annual
        // one.
        totalePagato: annual?.totale_pagato ?? 0,
        totalCount: annual?.total_count ?? 0,
        maxPagato: annual?.max_pagato ?? 0,
        anno: annualMeta?.anno ?? null,
        meseContabile: annualMeta?.mese_contabile ?? null,
        pacchetto: annualMeta?.pacchetto ?? null,
        topMissione: top
          ? {
              codice: top.codice_missione,
              nome: top.missione,
              totale: top.totale_pagato ?? 0,
            }
          : null,
        // Year-to-date. Null when the newest upstream snapshot IS the
        // December one, i.e. there is no partial year to report yet.
        progressivo:
          ytd && ytdMeta
            ? {
                anno: ytdMeta.anno,
                meseContabile: ytdMeta.mese_contabile,
                meseNumero: ytdMeta.mese_numero,
                totalePagato: ytd.totale_pagato ?? 0,
                totalCount: ytd.total_count ?? 0,
              }
            : null,
      },
      source: annualMeta?.fonte_url ?? FALLBACK_SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// -------- /by-missione --------------------------------------------------------

interface ByMissioneRow {
  codice_missione: string | null
  missione: string | null
  totale_pagato: number | null
}

router.get('/by-missione', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const periodo = readPeriodo(req.query.periodo)
    const [rows, meta] = await Promise.all([
      runQuery<ByMissioneRow[]>(
        `SELECT codice_missione, missione, totale_pagato
         FROM spesa_missioni
         WHERE periodo = $periodo
         ORDER BY totale_pagato DESC;`,
        { periodo },
      ),
      snapshotMeta(periodo),
    ])
    const total = (rows ?? []).reduce((sum, r) => sum + (r.totale_pagato ?? 0), 0)
    res.json({
      data: (rows ?? []).map((r) => ({
        codice: r.codice_missione,
        missione: r.missione,
        totalePagato: r.totale_pagato ?? 0,
        quota: total > 0 ? (r.totale_pagato ?? 0) / total : 0,
      })),
      periodo,
      anno: meta?.anno ?? null,
      source: meta?.fonte_url ?? FALLBACK_SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// -------- / (paginated list) --------------------------------------------------

interface ListRow {
  id: string
  codice_missione: string | null
  missione: string | null
  anno: number | null
  mese_contabile: string | null
  op_erario: number | null
  op_tesoreria: number | null
  op_esterno: number | null
  oa_tesoreria: number | null
  oa_spesa_deleg: number | null
  rsf_stipendi: number | null
  rsf_altro: number | null
  totale_pagato: number | null
}

interface CountRow {
  count: number
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = clampInt(req.query.limit, 50, 1, 100)
    const offset = clampInt(req.query.offset, 0, 0, 10_000)
    const periodo = readPeriodo(req.query.periodo)

    const bindings: Record<string, unknown> = { lim: limit, off: offset, periodo }

    const listQuery = `
      SELECT
        type::string(id) AS id,
        codice_missione, missione, anno, mese_contabile,
        op_erario, op_tesoreria, op_esterno, oa_tesoreria,
        oa_spesa_deleg, rsf_stipendi, rsf_altro, totale_pagato
      FROM spesa_missioni
      WHERE periodo = $periodo
      ORDER BY totale_pagato DESC
      LIMIT $lim START $off;
    `
    const countQuery = `
      SELECT count() AS count FROM spesa_missioni
      WHERE periodo = $periodo GROUP ALL;
    `

    const [rows, countRows, meta] = await Promise.all([
      runQuery<ListRow[]>(listQuery, bindings),
      runQuery<CountRow[]>(countQuery, { periodo }),
      snapshotMeta(periodo),
    ])

    res.json({
      data: (rows ?? []).map((r) => ({
        id: r.id,
        codice: r.codice_missione,
        missione: r.missione,
        anno: r.anno,
        meseContabile: r.mese_contabile,
        opErario: r.op_erario,
        opTesoreria: r.op_tesoreria,
        opEsterno: r.op_esterno,
        oaTesoreria: r.oa_tesoreria,
        oaSpesaDeleg: r.oa_spesa_deleg,
        rsfStipendi: r.rsf_stipendi,
        rsfAltro: r.rsf_altro,
        totalePagato: r.totale_pagato,
      })),
      pagination: {
        total: countRows?.[0]?.count ?? 0,
        limit,
        offset,
      },
      periodo,
      anno: meta?.anno ?? null,
      source: meta?.fonte_url ?? FALLBACK_SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

export default router
