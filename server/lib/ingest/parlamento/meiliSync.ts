// Per-seduta Meilisearch sync, shared by every body-pass session module
// (camera, senato, camera-historical). Called after a seduta's interventi have
// been (re)inserted into SurrealDB, it mirrors that change into the Meili
// `parlamento_interventi` index: delete the seduta's old documents, then upsert
// the fresh ones. This is the incremental counterpart to the one-shot cold
// rebuild in `server/scripts/meili-sync.ts`.
//
// Best-effort by design: any failure is logged (never thrown) so a Meili
// outage cannot break the ingest. A seduta left stale is fully recoverable --
// re-ingest it with `--refresh`, or rebuild the whole index from SurrealDB
// (the source of truth) via `scripts/meili-sync.ts`.

import { runQuery } from '../../query.ts'
import {
  INTERVENTO_DOC_PROJECTION,
  addInterventiDocs,
  deleteSedutaDocs,
  mapInterventoRow,
  meiliEnabled,
  type InterventoRow,
} from '../../meilisearch.ts'

export async function syncSedutaToMeili(sedutaId: unknown, label: string): Promise<void> {
  if (!meiliEnabled()) return
  try {
    const rows =
      (await runQuery<InterventoRow[]>(
        `SELECT ${INTERVENTO_DOC_PROJECTION}
         FROM parlamento_interventi
         WHERE seduta_id = $sid
         ORDER BY posizione;`,
        { sid: sedutaId },
      )) ?? []
    const docs = rows.map(mapInterventoRow)
    // Delete first so interventi dropped by a re-parse don't linger, then
    // upsert the current set. Meili processes the two tasks in order.
    await deleteSedutaDocs(String(sedutaId))
    await addInterventiDocs(docs)
  } catch (err) {
    console.warn(
      `[meili-sync] ${label}: seduta not synced to Meilisearch (left stale; recover via scripts/meili-sync.ts):`,
      err instanceof Error ? err.message : err,
    )
  }
}
