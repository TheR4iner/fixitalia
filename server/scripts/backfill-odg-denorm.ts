// CLI wrapper for the parlamento_odg denormalisation backfill.
//
// The actual work lives in lib/ingest/parlamento/odgDenormBackfill.ts because
// it also runs automatically at boot -- the VPS deploy key is pinned to a
// forced `docker compose pull && up -d` and cannot invoke a migration script,
// so a release must be able to heal itself. This wrapper exists for the
// operator case: forcing a rewrite, or running it on demand with progress.
//
// Usage, from inside the workspace container:
//   cd server && npx tsx scripts/backfill-odg-denorm.ts [--force]
//
// In production (no tsx in the image), the compiled form:
//   docker exec fixitalia-backend node /app/dist/scripts/backfill-odg-denorm.js

import { backfillOdgDenorm } from '../lib/ingest/parlamento/odgDenormBackfill.ts'
import { closeDb } from '../lib/db.ts'

const force = process.argv.includes('--force')

async function main(): Promise<void> {
  console.log(`[backfill-odg] starting (force=${force})`)

  const result = await backfillOdgDenorm({ force }, (done, total, rows) => {
    console.log(`[backfill-odg] ${done}/${total} sedute (odg_rows=${rows})`)
  })

  if (result.alreadyComplete) {
    console.log('[backfill-odg] nothing to do -- every odg row already has the columns')
    return
  }

  console.log(
    `[backfill-odg] DONE sedute_updated=${result.seduteUpdated} ` +
      `skipped=${result.seduteSkipped} odg_rows_written=${result.odgRowsWritten} ` +
      `in ${(result.durationMs / 1000).toFixed(1)}s`,
  )
  console.log(`[backfill-odg] odg rows still missing a denormalised column: ${result.remaining}`)
  if (result.remaining > 0) {
    console.warn('[backfill-odg] re-run with --force to rewrite the stragglers')
  }
}

main()
  .catch((err) => {
    console.error('[backfill-odg] failed:', err)
    process.exitCode = 1
  })
  .finally(() => closeDb())
