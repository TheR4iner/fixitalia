import { Router, type Request, type Response } from 'express'

import { runQuery } from '../lib/query.ts'

const router = Router()

// Two probes with deliberately different jobs.
//
// GET /api/health   LIVENESS. Is the process up and serving HTTP? Touches
//                   nothing else, so it stays fast and cannot be knocked over
//                   by a dependency. This is what a load balancer polls.
//
// GET /api/health/ready  READINESS. Can the process actually do its job, i.e.
//                   reach SurrealDB? Returns 503 when it cannot.
//
// The split exists because of a real incident (2026-08-16): /api/health
// returned a static 200 and was also the Docker healthcheck, so the container
// reported "healthy" for 20 hours while its database connection was dead and
// every scheduled ingest failed. A probe that never touches the DB cannot
// notice a broken DB. See project-kb/Parlamento ingest reliability.md.

router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'fixitalia',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

router.get('/ready', async (_req: Request, res: Response) => {
  const startedAt = Date.now()
  try {
    // Cheapest possible round-trip that still proves the session is
    // authenticated: a constant expression the datastore must answer.
    await runQuery('RETURN 1;')
    res.status(200).json({
      status: 'ready',
      service: 'fixitalia',
      db: 'ok',
      dbLatencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[health] readiness probe failed:', message)
    res.status(503).json({
      status: 'degraded',
      service: 'fixitalia',
      db: 'unreachable',
      // Safe to surface: this is an operational error string from our own
      // datastore layer, never user input and never a credential.
      error: message,
      dbLatencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    })
  }
})

export default router
