// Targeted reprocess of Camera leg-14 sedute left non-ok by the pre-fix run.
// Uses the current (fixed) historical session code with its sintero->chunked
// fallback. Polite 800ms gap between sedute to avoid throttling leg14.camera.it.
import { runQuery } from '../lib/query.ts'
import { closeDb } from '../lib/db.ts'
import { ingestCameraHistoricalSession } from '../lib/ingest/parlamento/cameraHistoricalSession.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const rows = await runQuery<Array<{ numero: number }>>(
    `SELECT numero FROM parlamento_sedute
     WHERE chamber = "camera" AND legislatura = 14 AND body_status != "ok"
     ORDER BY numero ASC;`,
  )
  const numeros = (rows ?? []).map((r) => r.numero)
  console.log(`[camera14-cleanup] ${numeros.length} non-ok sedute to reprocess`)
  let ok = 0, partial = 0, empty = 0, error = 0
  for (let i = 0; i < numeros.length; i++) {
    const n = numeros[i]
    try {
      const r = await ingestCameraHistoricalSession(14, n)
      if (r.status === 'ok') ok++
      else if (r.status === 'partial') partial++
      else if (r.status === 'empty') empty++
      else error++
    } catch (e) {
      error++
      console.warn(`[camera14-cleanup] sed ${n} threw:`, e instanceof Error ? e.message : e)
    }
    if ((i + 1) % 10 === 0) {
      console.log(`[camera14-cleanup] ${i + 1}/${numeros.length} (ok=${ok} partial=${partial} empty=${empty} error=${error})`)
    }
    await sleep(800)
  }
  console.log(`[camera14-cleanup] DONE ok=${ok} partial=${partial} empty=${empty} error=${error}`)
  await closeDb()
}
main().catch((e) => { console.error(e); process.exit(1) })
