#!/usr/bin/env tsx
// Wipe the parlamento body data so a fresh ingest can repopulate it under
// the new persona+mandato schema (2026-05-15 refactor).
//
// Run once on prod -- after a fresh image is deployed -- before kicking off
// `ingest.ts parlamento --all-legislatures` and `... --chamber senato`.
//
// What this script DELETES:
//   - parlamento_interventi   (every row)
//   - parlamento_odg          (every row)
//   - parlamento_riferimenti  (every row)
//   - parlamento_persona      (re-populated by the body pass from anchors)
//   - parlamento_mandato      (re-populated by the body pass + deputati scrape)
//
// What this script KEEPS:
//   - parlamento_sedute       (metadata is correct + html_url already points
//                              to the right show-doc URLs after the Senato
//                              Playwright refactor). The body_status of each
//                              row is reset to "pending" so the next ingest
//                              run will refetch the body.
//
// The old parlamento_oratori / parlamento_deputati tables are removed via
// `REMOVE TABLE IF EXISTS` in schema.ts and do not need to be touched here.

import { runQuery } from '../lib/query.ts'
import { closeDb } from '../lib/db.ts'

async function wipe(table: string): Promise<void> {
  const rows = await runQuery<Array<{ n: number }>>(
    `SELECT count() AS n FROM ${table} GROUP ALL;`,
  )
  const before = rows?.[0]?.n ?? 0
  await runQuery(`DELETE ${table};`)
  console.log(`  ${table.padEnd(28)} -- deleted ${before} rows`)
}

async function main(): Promise<void> {
  console.log('[wipe] starting parlamento body wipe')

  // Full-text search is served by Meilisearch, which is rebuilt from SurrealDB
  // via scripts/meili-sync.ts after a wipe + re-ingest; there is no SurrealDB
  // search index to drop or rebuild here. (Historically, on SurrealDB v2.1.4 a
  // BM25 SEARCH index on this table crashed the connection on every INSERT --
  // that index has since been retired. See
  // project-kb/BM25 index blocks parlamento ingest.md.)

  await wipe('parlamento_interventi')
  await wipe('parlamento_odg')
  await wipe('parlamento_riferimenti')
  await wipe('parlamento_persona')
  await wipe('parlamento_mandato')

  await runQuery(
    `UPDATE parlamento_sedute SET
       body_status = "pending",
       body_error = NONE,
       refs_status = NONE,
       refs_parser_version = NONE,
       interventi_n = NONE,
       odg_n = NONE;`,
  )
  const sedute = await runQuery<Array<{ n: number }>>(
    `SELECT count() AS n FROM parlamento_sedute GROUP ALL;`,
  )
  console.log(
    `  parlamento_sedute            -- kept ${sedute?.[0]?.n ?? 0} rows, statuses reset to "pending"`,
  )

  console.log('[wipe] done')
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[wipe] failed:', err)
    await closeDb().catch(() => {})
    process.exit(1)
  })
