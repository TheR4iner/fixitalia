import { runQuery } from '../lib/query.ts'
import { closeDb } from '../lib/db.ts'

interface InfoForDb {
  tables: Record<string, unknown>
}

async function main() {
  const info = await runQuery<InfoForDb>(`INFO FOR DB;`)
  const tables = Object.keys(info.tables ?? {}).sort()
  console.log(`tables: ${tables.length}`)
  for (const t of tables) {
    try {
      const row = await runQuery<{ n: number }[]>(`SELECT count() AS n FROM ${t} GROUP ALL;`)
      console.log(`  ${t}: ${row[0]?.n ?? 0}`)
    } catch (e) {
      console.log(`  ${t}: error - ${(e as Error).message}`)
    }
  }
  await closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
