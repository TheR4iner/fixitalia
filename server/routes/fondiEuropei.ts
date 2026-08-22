import { Router, type Request, type Response, type NextFunction } from 'express'

import { runQuery } from '../lib/query.ts'

// -----------------------------------------------------------------------------
// Read-side API for the Fondi Europei section.
//
// The underlying data comes from OpenCoesione's aggregati JSON API and is
// split across four SurrealDB tables: fondi_totali (1 row, authoritative
// pipeline total), fondi_regioni (20 rows), fondi_temi (11 rows), and
// fondi_yearly (36 rows, impegni + pagamenti per year).
//
// Four endpoints match those four views:
//   GET /api/fondi-europei/kpis          -> headline KPIs from totali
//   GET /api/fondi-europei/by-regione    -> 20 regions sorted by costo
//   GET /api/fondi-europei/by-tema       -> 11 themes sorted by costo
//   GET /api/fondi-europei/yearly        -> yearly impegni + pagamenti
//
// IMPORTANT: We never compute totals by summing fondi_regioni. Multi-
// region projects are double-counted in the regional breakdown, so
// SUM(fondi_regioni.costo_pubblico) is about 48% higher than the true
// pipeline value. Always read the headline totals from fondi_totali.
// -----------------------------------------------------------------------------

const router = Router()

const SOURCE_URL = 'https://opencoesione.gov.it/it/opendata/'

// ---- /kpis ------------------------------------------------------------------

interface TotaliRow {
  costo_pubblico: number | null
  costo_pubblico_coesione: number | null
  pagamenti: number | null
  pagamenti_coesione: number | null
  progetti: number | null
  data_aggiornamento: string | null
}

router.get('/kpis', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await runQuery<TotaliRow[]>(
      `SELECT
         costo_pubblico,
         costo_pubblico_coesione,
         pagamenti,
         pagamenti_coesione,
         progetti,
         data_aggiornamento
       FROM fondi_totali;`,
    )
    const t = rows?.[0] ?? {
      costo_pubblico: 0,
      costo_pubblico_coesione: 0,
      pagamenti: 0,
      pagamenti_coesione: 0,
      progetti: 0,
      data_aggiornamento: null,
    }
    const costo = t.costo_pubblico ?? 0
    const paid = t.pagamenti ?? 0
    res.json({
      data: {
        costoPubblico: costo,
        costoPubblicoCoesione: t.costo_pubblico_coesione ?? 0,
        pagamenti: paid,
        pagamentiCoesione: t.pagamenti_coesione ?? 0,
        progetti: t.progetti ?? 0,
        // Share of the monitored cost that has actually been disbursed so
        // far. Computed server-side so the client does not have to worry
        // about divide-by-zero or rounding precision.
        quotaPagata: costo > 0 ? paid / costo : 0,
        dataAggiornamento: t.data_aggiornamento,
      },
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// ---- /by-regione ------------------------------------------------------------

interface RegioneRow {
  codice: string | null
  nome: string | null
  costo_pubblico: number | null
  costo_pubblico_coesione: number | null
  pagamenti: number | null
  pagamenti_coesione: number | null
  progetti: number | null
}

router.get('/by-regione', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await runQuery<RegioneRow[]>(
      `SELECT codice, nome, costo_pubblico, costo_pubblico_coesione,
              pagamenti, pagamenti_coesione, progetti
       FROM fondi_regioni
       ORDER BY costo_pubblico DESC;`,
    )
    res.json({
      data: (rows ?? []).map((r) => {
        const costo = r.costo_pubblico ?? 0
        const paid = r.pagamenti ?? 0
        return {
          codice: r.codice,
          nome: r.nome,
          costoPubblico: costo,
          costoPubblicoCoesione: r.costo_pubblico_coesione ?? 0,
          pagamenti: paid,
          pagamentiCoesione: r.pagamenti_coesione ?? 0,
          progetti: r.progetti ?? 0,
          quotaPagata: costo > 0 ? paid / costo : 0,
        }
      }),
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// ---- /by-tema ---------------------------------------------------------------

interface TemaRow {
  codice: string | null
  nome: string | null
  costo_pubblico: number | null
  pagamenti: number | null
  progetti: number | null
}

router.get('/by-tema', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await runQuery<TemaRow[]>(
      `SELECT codice, nome, costo_pubblico, pagamenti, progetti
       FROM fondi_temi
       ORDER BY costo_pubblico DESC;`,
    )
    res.json({
      data: (rows ?? []).map((r) => {
        const costo = r.costo_pubblico ?? 0
        const paid = r.pagamenti ?? 0
        return {
          codice: r.codice,
          nome: r.nome,
          costoPubblico: costo,
          pagamenti: paid,
          progetti: r.progetti ?? 0,
          quotaPagata: costo > 0 ? paid / costo : 0,
        }
      }),
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// ---- /by-stato --------------------------------------------------------------

interface StatoRow {
  codice: string | null
  nome: string | null
  ordine: number | null
  costo_pubblico: number | null
  pagamenti: number | null
  progetti: number | null
}

router.get('/by-stato', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await runQuery<StatoRow[]>(
      `SELECT codice, nome, ordine, costo_pubblico, pagamenti, progetti
       FROM fondi_stati
       ORDER BY ordine ASC;`,
    )
    const totalProgetti = (rows ?? []).reduce((sum, r) => sum + (r.progetti ?? 0), 0)
    res.json({
      data: (rows ?? []).map((r) => ({
        codice: r.codice,
        nome: r.nome,
        progetti: r.progetti ?? 0,
        costoPubblico: r.costo_pubblico ?? 0,
        pagamenti: r.pagamenti ?? 0,
        quotaProgetti: totalProgetti > 0 ? (r.progetti ?? 0) / totalProgetti : 0,
      })),
      totals: {
        progetti: totalProgetti,
      },
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// ---- /yearly ----------------------------------------------------------------

interface YearlyRow {
  anno: number | null
  ammontare_impegni: number | null
  ammontare_pagamenti: number | null
}

router.get('/yearly', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await runQuery<YearlyRow[]>(
      `SELECT anno, ammontare_impegni, ammontare_pagamenti
       FROM fondi_yearly
       ORDER BY anno ASC;`,
    )
    res.json({
      data: (rows ?? []).map((r) => ({
        anno: r.anno,
        impegni: r.ammontare_impegni ?? 0,
        pagamenti: r.ammontare_pagamenti ?? 0,
      })),
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

export default router
