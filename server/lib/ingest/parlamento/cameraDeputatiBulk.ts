// Bulk Camera deputies profile-scrape pass.
//
// For a given legislature, walks every `parlamento_mandato` row in that
// (chamber=camera, leg=N) and refreshes its profile data from the official
// page at `https://www.camera.it/deputati/elenco/{leg}-{id_persona}/`.
//
// Runs as a third orchestrator phase after the Camera index + body passes,
// so every speaker we observed in transcripts has a mandato row to enrich.
//
// Idempotent and resumable: a mandato whose `fetched_at` is fresher than
// DEPUTATI_TTL_MS is skipped unless `refresh: true` is passed.
//
// Cleanly leg-aware: when the orchestrator's `--all-legislatures` loop calls
// this for each leg, the per-leg URL is constructed from the mandato's own
// id_persona -- no risk of fetching a leg-1 deputy URL with a leg-19 id.

import { applyMandatoProfile, listMandatiByLeg } from './persona.ts'
import { scrapeCameraDeputato } from './cameraDeputatoScraper.ts'
import { fetchCameraDeputatoViaSparql } from './cameraHistoricalDeputatoSparql.ts'
import { CURRENT_LEGISLATURE } from './constants.ts'

export interface BulkDeputatiOptions {
  legislatura: number
  /** Cap the number of mandates attempted in this run. */
  limit?: number
  /** Re-scrape even rows fresher than the TTL. */
  refresh?: boolean
}

export interface BulkDeputatiResult {
  legislatura: number
  total: number
  scraped: number
  skipped: number
  failed: number
  durationMs: number
}

const DEPUTATI_TTL_MS = 7 * 24 * 60 * 60 * 1000
const POLITE_GAP_MS = 500

function isFreshAt(fetchedAt: string | null): boolean {
  if (!fetchedAt) return false
  return Date.now() - new Date(fetchedAt).getTime() < DEPUTATI_TTL_MS
}

export async function ingestCameraDeputati(
  options: BulkDeputatiOptions,
): Promise<BulkDeputatiResult> {
  const started = Date.now()
  const { legislatura, limit, refresh = false } = options

  const all = await listMandatiByLeg('camera', legislatura)
  const queue = limit ? all.slice(0, limit) : all

  console.log(
    `[ingest:parlamento:camera-deputati] leg ${legislatura}: ` +
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

    // Current leg uses the live www.camera.it HTML scrape; archived legs
    // resolve the same fields via the dati.camera.it SPARQL endpoint
    // because /deputati/elenco/{leg}-{id}/ 404s for any non-current leg.
    // See project-kb/Camera deputati historical URLs.md for the rationale.
    const slug = `camera-id-${m.id_persona}`
    let snapshot
    try {
      snapshot =
        legislatura === CURRENT_LEGISLATURE
          ? await scrapeCameraDeputato(slug, legislatura)
          : await fetchCameraDeputatoViaSparql(m.id_persona, legislatura)
    } catch (err) {
      failed += 1
      console.warn(
        `[ingest:parlamento:camera-deputati] scrape threw for ${slug} (leg ${legislatura}):`,
        err instanceof Error ? err.message : err,
      )
      continue
    }
    if (!snapshot) {
      failed += 1
      continue
    }

    try {
      // The snapshot mirrors the mandato profile fields by name, so a
      // straight pass-through is safe. We drop only the fields that don't
      // belong on a mandato (slug, id_ufficiale, chamber -- already on the
      // mandato row itself).
      const { slug: _s, id_ufficiale: _u, chamber: _c, ...profileFields } = snapshot
      void _s; void _u; void _c
      await applyMandatoProfile(m.id, 'camera', m.id_persona, profileFields)
      scraped += 1
    } catch (err) {
      failed += 1
      console.warn(
        `[ingest:parlamento:camera-deputati] persist failed for ${slug} (leg ${legislatura}):`,
        err instanceof Error ? err.message : err,
      )
      continue
    }

    if (queue.length <= 20 || (i + 1) % 25 === 0) {
      console.log(
        `[ingest:parlamento:camera-deputati] leg ${legislatura} progress ` +
          `${i + 1}/${queue.length} (scraped=${scraped}, skipped=${skipped}, failed=${failed})`,
      )
    }
  }

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:camera-deputati] leg ${legislatura} DONE in ` +
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
