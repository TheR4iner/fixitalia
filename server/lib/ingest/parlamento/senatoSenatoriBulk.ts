// Bulk Senate senator profile-fetch pass.
//
// For a given legislature, walks every `parlamento_mandato` row in that
// (chamber=senato, leg=N) and refreshes its profile data from the
// dati.senato.it SPARQL endpoint. Parallels cameraDeputatiBulk.ts for the
// Camera side; uses SPARQL instead of HTML scraping because the senate
// historical profile pages are AWS-WAF-gated and the SPARQL data is
// strictly richer (group history with dates, birth info, profession).
//
// Idempotent and resumable: a mandato whose `fetched_at` is fresher than
// SENATORI_TTL_MS is skipped unless `refresh: true` is passed.

import { applyMandatoProfile, listMandatiByLeg } from './persona.ts'
import { fetchSenatoreViaSparql } from './senatoreSparql.ts'

export interface BulkSenatoriOptions {
  legislatura: number
  limit?: number
  refresh?: boolean
}

export interface BulkSenatoriResult {
  legislatura: number
  total: number
  scraped: number
  skipped: number
  failed: number
  durationMs: number
}

const SENATORI_TTL_MS = 7 * 24 * 60 * 60 * 1000
const POLITE_GAP_MS = 300

function isFreshAt(fetchedAt: string | null): boolean {
  if (!fetchedAt) return false
  return Date.now() - new Date(fetchedAt).getTime() < SENATORI_TTL_MS
}

export async function ingestSenatoSenatori(
  options: BulkSenatoriOptions,
): Promise<BulkSenatoriResult> {
  const started = Date.now()
  const { legislatura, limit, refresh = false } = options

  const all = await listMandatiByLeg('senato', legislatura)
  const queue = limit ? all.slice(0, limit) : all

  console.log(
    `[ingest:parlamento:senato-senatori] leg ${legislatura}: ` +
      `${queue.length} mandato(s) to process (refresh=${refresh}, limit=${limit ?? 'none'})`,
  )

  let scraped = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < queue.length; i += 1) {
    const m = queue[i]
    if (!refresh && isFreshAt(m.fetched_at)) {
      skipped += 1
      continue
    }

    if (i > 0) await new Promise((r) => setTimeout(r, POLITE_GAP_MS))

    let snapshot
    try {
      snapshot = await fetchSenatoreViaSparql(m.id_persona, legislatura)
    } catch (err) {
      failed += 1
      console.warn(
        `[ingest:parlamento:senato-senatori] fetch threw for senatore/${m.id_persona} leg ${legislatura}:`,
        err instanceof Error ? err.message : err,
      )
      continue
    }
    if (!snapshot) {
      failed += 1
      continue
    }

    try {
      const { slug: _s, id_ufficiale: _u, chamber: _c, ...profileFields } = snapshot
      void _s; void _u; void _c
      await applyMandatoProfile(m.id, 'senato', m.id_persona, profileFields)
      scraped += 1
    } catch (err) {
      failed += 1
      console.warn(
        `[ingest:parlamento:senato-senatori] persist failed for senatore/${m.id_persona} leg ${legislatura}:`,
        err instanceof Error ? err.message : err,
      )
      continue
    }

    if (queue.length <= 20 || (i + 1) % 25 === 0) {
      console.log(
        `[ingest:parlamento:senato-senatori] leg ${legislatura} progress ` +
          `${i + 1}/${queue.length} (scraped=${scraped}, skipped=${skipped}, failed=${failed})`,
      )
    }
  }

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:senato-senatori] leg ${legislatura} DONE in ` +
      `${(durationMs / 1000).toFixed(1)}s -- scraped=${scraped}, skipped=${skipped}, ` +
      `failed=${failed}, total=${queue.length}`,
  )

  return {
    legislatura,
    total: queue.length,
    scraped,
    skipped,
    failed,
    durationMs,
  }
}
