import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'

import healthRoutes from './routes/health.ts'
import opereIncompiuteRoutes from './routes/opereIncompiute.ts'
import spesaPubblicaRoutes from './routes/spesaPubblica.ts'
import fondiEuropeiRoutes from './routes/fondiEuropei.ts'
import appaltiRoutes from './routes/appalti.ts'
import parlamentoRoutes from './routes/parlamento.ts'
import { getDb, closeDb } from './lib/db.ts'
import { runSchema } from './lib/schema.ts'
import { INTERVENTI_INDEX, ensureInterventiIndex, meiliEnabled } from './lib/meilisearch.ts'
import { startOpenDataRefresh } from './lib/openDataRefresh.ts'
import { startParlamentoScheduler } from './lib/scheduler.ts'
import { backfillOdgDenorm } from './lib/ingest/parlamento/odgDenormBackfill.ts'

const app = express()

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10)
const HOST = process.env.HOST ?? '0.0.0.0'
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173'
const isDevelopment = process.env.NODE_ENV !== 'production'

// Trust reverse proxy (Caddy in prod, Vite dev-proxy in dev).
app.set('trust proxy', 1)

// Security headers. This server only serves JSON, so the CSP can be strict.
// frame-src is opened to the official Camera/Senato webtv hosts so the
// Parlamento reader can embed session videos when the user opts in.
//
// `useDefaults: true` makes the merge with helmet's default directives
// explicit, so a future helmet release that changes default-merge behavior
// cannot silently weaken our policy.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        frameSrc: [
          "'self'",
          'https://webtv.camera.it',
          'https://webtv.senato.it',
        ],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
)

// CORS: tight in production, permissive-ish in dev for localhost variants.
app.use(
  cors({
    origin: isDevelopment ? [FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'] : FRONTEND_URL,
    credentials: true,
  }),
)

app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true, limit: '1mb' }))

// Routes
app.use('/api/health', healthRoutes)
app.use('/api/opere-incompiute', opereIncompiuteRoutes)
app.use('/api/spesa-pubblica', spesaPubblicaRoutes)
app.use('/api/fondi-europei', fondiEuropeiRoutes)
app.use('/api/appalti', appaltiRoutes)
app.use('/api/parlamento', parlamentoRoutes)

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found', path: req.originalUrl })
})

// Error handler. Express identifies this as an error handler by arity === 4,
// so the `req` and `next` parameters must stay even though they are unused;
// the leading underscore is what keeps the lint rule quiet.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server] Unhandled error:', err)
  const message = isDevelopment ? err.message : 'Internal server error'
  res.status(500).json({ error: message })
})

const server = app.listen(PORT, HOST, () => {
  console.log(`[server] fixitalia backend listening on ${HOST}:${PORT}`)
  console.log(`[server]   NODE_ENV=${process.env.NODE_ENV ?? 'development'}`)
  console.log(`[server]   FRONTEND_URL=${FRONTEND_URL}`)
})

// Schema bootstrap. Runs in the background so a slow initial download never
// blocks the HTTP server from binding.
//
// The four open-data sources are NOT bootstrapped here any more. They are
// owned by lib/openDataRefresh.ts, which runs a pass at boot (covering the
// old empty-table case and any schema migration) and once a day thereafter
// (covering staleness). The previous "ingest only if the table is empty"
// rule is what let production serve a months-old BDAP snapshot.
async function bootstrapData() {
  try {
    await runSchema()
    const db = await getDb()
    // Start the open-data refresh only after the schema exists: its boot pass
    // writes rows immediately.
    startOpenDataRefresh()
    // Parlamento is *deliberately* not auto-ingested at boot: the initial
    // full crawl is multi-hour, so a server restart should never kick off
    // a fresh-from-scratch run. Once the corpus exists, the daily scheduler
    // (startParlamentoScheduler below) keeps it current with one polite
    // run per day. Log a hint when the table is empty so the operator
    // knows to run the CLI for the initial population.
    try {
      const [pRows] = (await db.query(
        `SELECT count() AS count FROM parlamento_sedute GROUP ALL;`,
      )) as unknown as Array<Array<{ count: number }>>
      const existing = pRows?.[0]?.count ?? 0
      if (existing === 0) {
        console.log(
          '[bootstrap] parlamento_sedute empty -- run `dev exec backend npx tsx scripts/ingest.ts parlamento` (dev) or `docker compose -f docker-compose.prod.yml exec backend npx tsx scripts/ingest.ts parlamento` (prod) to populate.',
        )
      } else {
        console.log(`[bootstrap] parlamento_sedute has ${existing} rows`)
      }
    } catch (err) {
      console.warn('[bootstrap] parlamento check failed:', err)
    }
    // Schema migration: fill the denormalised columns on parlamento_odg for
    // rows ingested before they existed.
    //
    // This runs at boot rather than as a deploy step because it HAS to: the
    // VPS deploy key is pinned to a forced `docker compose pull && up -d` and
    // cannot invoke a migration script. Without this, the first release after
    // the schema change would leave 212k odg rows with empty columns and
    // /odg/search matching nothing until a human intervened.
    //
    // Guarded and idempotent: once the corpus is filled this is a single
    // LIMIT 1 probe per boot. Errors are logged and swallowed -- a failed
    // backfill must not stop the API from serving everything else, and the
    // next boot (or the CLI) retries.
    try {
      const backfill = await backfillOdgDenorm({}, (done, total, rows) =>
        console.log(`[bootstrap] odg backfill ${done}/${total} sedute (rows=${rows})`),
      )
      if (backfill.alreadyComplete) {
        console.log('[bootstrap] odg denorm columns already populated')
      } else {
        console.log(
          `[bootstrap] odg backfill wrote ${backfill.odgRowsWritten} rows across ` +
            `${backfill.seduteUpdated} sedute in ${(backfill.durationMs / 1000).toFixed(1)}s ` +
            `(${backfill.remaining} still missing)`,
        )
        if (backfill.remaining > 0) {
          console.warn(
            '[bootstrap] some odg rows still lack the denormalised columns -- ' +
              'run scripts/backfill-odg-denorm.js --force',
          )
        }
      }
    } catch (err) {
      console.error('[bootstrap] odg backfill failed (/odg/search may under-return):', err)
    }

    // Ensure the Meilisearch search index + settings exist. Idempotent and
    // best-effort: a Meili outage at boot must not block the API (search
    // falls back to the SurrealDB substring scan until the engine returns).
    if (meiliEnabled()) {
      try {
        await ensureInterventiIndex()
        console.log(`[bootstrap] meili index "${INTERVENTI_INDEX}" ready`)
      } catch (err) {
        console.warn('[bootstrap] meili index ensure failed (search will fall back):', err)
      }
    }
  } catch (err) {
    console.error('[bootstrap] data bootstrap failed:', err)
  }
}
void bootstrapData()

// Daily auto-fetch for new parliamentary sessions. Idempotent (uses the
// body_status checkpoint), zero-deps, in-memory state. Disable via
// PARLAMENTO_AUTOFETCH_ENABLED=false (e.g. in CI).
startParlamentoScheduler()

const gracefulShutdown = (signal: string) => {
  console.log(`[server] ${signal} received, shutting down...`)
  server.close(() => {
    void closeDb().finally(() => {
      console.log('[server] HTTP server closed.')
      process.exit(0)
    })
  })
  setTimeout(() => {
    console.error('[server] Forced shutdown after 10s timeout.')
    process.exit(1)
  }, 10_000)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
