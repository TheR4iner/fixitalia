import { runQuery } from '../lib/query.ts'
import { closeDb } from '../lib/db.ts'

const PARLAMENTO_TABLES = [
  'parlamento_ingest_state',
  'parlamento_interventi',
  'parlamento_mandato',
  'parlamento_odg',
  'parlamento_persona',
  'parlamento_riferimenti',
  'parlamento_sedute',
  'parlamento_senato_ddl_idmap',
  'parlamento_oratori',
  'parlamento_deputati',
]

async function removeWithRetry(table: string, attempts = 6): Promise<void> {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await runQuery(`REMOVE TABLE IF EXISTS ${table};`)
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/read or write conflict|retried/i.test(msg) || i === attempts) throw err
      const backoff = 250 * 2 ** (i - 1)
      console.log(`  ${table} conflict on attempt ${i}, retrying in ${backoff}ms`)
      await new Promise((r) => setTimeout(r, backoff))
    }
  }
}

async function main() {
  for (const t of PARLAMENTO_TABLES) {
    await removeWithRetry(t)
    console.log(`removed ${t}`)
  }
  console.log('done')
  await closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
