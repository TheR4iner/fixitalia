// -----------------------------------------------------------------------------
// Cold (re)build of the Meilisearch `parlamento_interventi` index from
// SurrealDB, the source of truth. Run once after provisioning the sidecar, and
// any time the index needs a full rebuild (it is disposable). The ingest body
// pass keeps it current incrementally afterwards.
//
// Performance: the naive approach (one SELECT per seduta that dereferences
// seduta_id.*, mandato_id.*, odg_id.* per intervento) decelerates badly on the
// HDD -- each of the 1.85M rows triggers 3 random record-link reads, thrashing
// the RocksDB block cache (the exact trap project-kb/parlamento_perf warns
// about). Instead we resolve the three small dimension tables (sedute ~9.5k,
// mandati ~6k, odg ~200k) into in-memory maps ONCE, then read interventi
// per-seduta with NO link traversal at all -- a pure idx_int_seduta range scan.
// The doc fields are assembled in JS and fed through the shared mapper, so the
// documents are byte-identical to the incremental hook's output.
//
// Idempotent: documents are upserted by id, so re-running re-pushes the same
// docs without duplicating. Safe to re-run after an interruption.
//
// Usage (inside the workspace):
//   dev exec backend npx tsx scripts/meili-sync.ts
//   dev exec backend npx tsx scripts/meili-sync.ts --fresh   # delete index first
// -----------------------------------------------------------------------------

import { runQuery } from '../lib/query.ts'
import { closeDb } from '../lib/db.ts'
import {
  INTERVENTI_INDEX,
  addInterventiDocs,
  ensureInterventiIndex,
  mapInterventoRow,
  meiliHealth,
  waitForMeiliIdle,
  waitForTask,
  type InterventoDoc,
  type InterventoRow,
} from '../lib/meilisearch.ts'

const FLUSH_AT = 5000 // documents buffered before a blocking push to Meili

interface SedutaMeta {
  chamber: string | null
  legislatura: number | null
  numero: number | null
  data: unknown
}

// Raw interventi row: mandato_id / odg_id are the RAW record links (selecting
// the field without `.subfield` does NOT traverse), resolved via the maps.
interface RawInterventoRow {
  id: unknown
  testo?: string | null
  oratore_nome?: string | null
  gruppo?: string | null
  anchor?: string | null
  posizione?: number | null
  mandato_id?: unknown
  odg_id?: unknown
}

async function deleteIndexIfFresh(): Promise<void> {
  if (!process.argv.includes('--fresh')) return
  const MEILI_URL = (process.env.MEILI_URL ?? 'http://fixitalia-meili:7700').replace(/\/+$/, '')
  const key = process.env.MEILI_MASTER_KEY ?? ''
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  console.log('[meili-sync] --fresh: deleting index before rebuild')
  const res = await fetch(`${MEILI_URL}/indexes/${INTERVENTI_INDEX}`, {
    method: 'DELETE',
    headers,
  })
  if (res.ok) {
    const task = (await res.json()) as { taskUid?: number; uid?: number }
    await waitForTask(task)
  }
}

async function main(): Promise<void> {
  console.log('[meili-sync] start', new Date().toISOString())

  if (!(await meiliHealth())) {
    console.error('[meili-sync] Meilisearch is not reachable/available. Aborting.')
    process.exit(1)
  }

  await deleteIndexIfFresh()
  await ensureInterventiIndex()
  console.log(`[meili-sync] index "${INTERVENTI_INDEX}" ensured (settings applied)`)

  // --- Resolve dimension tables into in-memory maps (3 small scans) ---
  const sedutaRows =
    (await runQuery<Array<{ id: unknown } & SedutaMeta>>(
      `SELECT id, chamber, legislatura, numero, data FROM parlamento_sedute;`,
    )) ?? []
  const sedutaMap = new Map<string, SedutaMeta>()
  for (const s of sedutaRows) {
    sedutaMap.set(String(s.id), {
      chamber: s.chamber ?? null,
      legislatura: typeof s.legislatura === 'number' ? s.legislatura : null,
      numero: typeof s.numero === 'number' ? s.numero : null,
      data: s.data,
    })
  }
  console.log(`[meili-sync] loaded ${sedutaMap.size} sedute`)

  const mandatoRows =
    (await runQuery<Array<{ id: unknown; id_persona?: number | null }>>(
      `SELECT id, id_persona FROM parlamento_mandato;`,
    )) ?? []
  const mandatoMap = new Map<string, number | null>()
  for (const m of mandatoRows) {
    mandatoMap.set(String(m.id), typeof m.id_persona === 'number' ? m.id_persona : null)
  }
  console.log(`[meili-sync] loaded ${mandatoMap.size} mandati`)

  const odgRows =
    (await runQuery<Array<{ id: unknown; titolo?: string | null }>>(
      `SELECT id, titolo FROM parlamento_odg;`,
    )) ?? []
  const odgMap = new Map<string, string | null>()
  for (const o of odgRows) odgMap.set(String(o.id), o.titolo ?? null)
  console.log(`[meili-sync] loaded ${odgMap.size} odg`)

  // --- Stream interventi per seduta via idx_int_seduta (no link traversal:
  // seduta meta / id_persona / odg titolo come from the maps above). Bind the
  // seduta RecordId (a stringified key matches nothing). Batches are fired to
  // Meili WITHOUT waiting, so SurrealDB reads aren't stalled behind Meili
  // indexing on the shared disk; the queue is drained once at the end.
  //
  // (A whole-table `WHERE id > cursor ORDER BY id` keyset scan was tried and is
  // ~40x slower here -- SurrealDB does not turn it into a cheap range scan --
  // so the per-seduta index scan is the right shape.)
  let buffer: InterventoDoc[] = []
  let pushed = 0
  let scannedSedute = 0
  const startedAt = Date.now()

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return
    const batch = buffer
    buffer = []
    await addInterventiDocs(batch) // non-blocking: enqueue only
    pushed += batch.length
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0)
    console.log(
      `[meili-sync] enqueued ${pushed} docs (${scannedSedute}/${sedutaRows.length} sedute, ${elapsed}s)`,
    )
  }

  for (const s of sedutaRows) {
    const sidStr = String(s.id)
    const meta = sedutaMap.get(sidStr)
    const rows =
      (await runQuery<RawInterventoRow[]>(
        `SELECT id, testo, oratore_nome, gruppo, anchor, posizione, mandato_id, odg_id
         FROM parlamento_interventi
         WHERE seduta_id = $sid
         ORDER BY posizione;`,
        { sid: s.id },
      )) ?? []
    for (const r of rows) {
      const row: InterventoRow = {
        id: r.id,
        testo: r.testo ?? '',
        oratore_nome: r.oratore_nome ?? null,
        gruppo: r.gruppo ?? null,
        anchor: r.anchor ?? null,
        posizione: typeof r.posizione === 'number' ? r.posizione : null,
        oratore_id_persona: r.mandato_id == null ? null : mandatoMap.get(String(r.mandato_id)) ?? null,
        seduta: sidStr,
        chamber: meta?.chamber ?? null,
        legislatura: meta?.legislatura ?? null,
        seduta_numero: meta?.numero ?? null,
        seduta_data: meta?.data,
        odg_titolo: r.odg_id == null ? null : odgMap.get(String(r.odg_id)) ?? null,
      }
      buffer.push(mapInterventoRow(row))
    }
    scannedSedute += 1
    if (buffer.length >= FLUSH_AT) await flush()
  }
  await flush()

  console.log(`[meili-sync] all ${pushed} docs enqueued; waiting for Meili to drain...`)
  await waitForMeiliIdle()
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0)
  console.log(`[meili-sync] DONE: ${pushed} documents in ${elapsed}s`)
}

main()
  .then(async () => {
    await closeDb()
    process.exit(0)
  })
  .catch(async (e) => {
    console.error('[meili-sync] FAILED:', e)
    await closeDb().catch(() => {})
    process.exit(1)
  })
