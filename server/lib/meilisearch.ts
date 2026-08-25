// Meilisearch client + index configuration for the parlamento full-text search.
//
// Meilisearch replaces the retired SurrealDB BM25 index (`idx_int_text`). That
// index OOM-killed every rebuild on this corpus and its postings/HIGHLIGHTS
// blobs were a major contributor to the 401 GB store bloat. SurrealDB stays the
// source of truth; Meili is a disposable search replica -- it can be rebuilt
// from scratch at any time via `server/scripts/meili-sync.ts`, and is kept
// current incrementally by the ingest body pass (per-seduta replace).
//
// Transport: plain REST over the global `fetch` (Node >=18). No SDK -- the API
// is small and the JS SDK pulls in a heavy dependency tree we do not need.
//
// Config (see docker-compose.override.yml / docker-compose.prod.yml):
//   MEILI_URL         base URL, e.g. http://fixitalia-meili:7700
//   MEILI_MASTER_KEY  optional. Empty in dev (MEILI_ENV=development needs no
//                     auth); required in prod (MEILI_ENV=production).

const MEILI_URL = (process.env.MEILI_URL ?? 'http://fixitalia-meili:7700').replace(/\/+$/, '')
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY ?? ''

export const INTERVENTI_INDEX = 'parlamento_interventi'

// Thrown when Meili cannot be reached or returns a non-2xx. The search route
// catches this to fall back to the SurrealDB substring scan so the user still
// sees results when the engine is down or mid-rebuild.
export class MeiliError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'MeiliError'
  }
}

// `MEILI_URL` is effectively always set (it has a default), but allow an
// explicit empty string to hard-disable the integration in environments that
// have not provisioned the sidecar yet.
export function meiliEnabled(): boolean {
  return MEILI_URL.length > 0
}

interface MeiliTask {
  taskUid?: number
  uid?: number
  status?: string
  error?: { message?: string } | null
}

async function meiliFetch<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (MEILI_MASTER_KEY) headers.Authorization = `Bearer ${MEILI_MASTER_KEY}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(`${MEILI_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    // Network-level failure (engine down, DNS, connection refused).
    throw new MeiliError(
      `meili request failed: ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const text = await res.text()
  const parsed = text ? safeJson(text) : undefined
  if (!res.ok) {
    throw new MeiliError(
      `meili ${method} ${path} -> ${res.status}`,
      res.status,
      parsed ?? text,
    )
  }
  return parsed as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// ----------------------------------------------------------------------------
// Index settings
//
// searchableAttributes order is the relevance priority (a hit in `testo`
// outranks one in `odg_titolo`). filterableAttributes back the facet filters
// the routes push (chamber/leg/gruppo/persona) AND the per-seduta delete the
// ingest hook needs (`seduta`). sortableAttributes lets the route sort by date
// when there is no text query. `seduta_data` is stored as epoch seconds so it
// is both range-filterable and sortable as a number.
// ----------------------------------------------------------------------------

// A compact Italian stopword list. Meili removes these from queries and from
// the indexed text, which both shrinks the index and stops ubiquitous function
// words from dominating relevance. Kept deliberately conservative (high-freq
// closed-class words only) so we never strip a meaningful query term.
const ITALIAN_STOPWORDS = [
  'a', 'ad', 'al', 'allo', 'ai', 'agli', 'alla', 'alle', 'agl',
  'con', 'col', 'coi', 'da', 'dal', 'dallo', 'dai', 'dagli', 'dalla', 'dalle',
  'di', 'del', 'dello', 'dei', 'degli', 'della', 'delle', 'in', 'nel', 'nello',
  'nei', 'negli', 'nella', 'nelle', 'su', 'sul', 'sullo', 'sui', 'sugli',
  'sulla', 'sulle', 'per', 'tra', 'fra', 'il', 'lo', 'la', 'i', 'gli', 'le',
  'un', 'uno', 'una', 'e', 'ed', 'o', 'od', 'ma', 'se', 'che', 'chi', 'cui',
  'non', 'come', 'dove', 'quando', 'anche', 'pi', 'piu', 'meno', 'molto',
  'questo', 'questa', 'questi', 'queste', 'quello', 'quella', 'quelli',
  'quelle', 'ci', 'vi', 'si', 'ne', 'mi', 'ti', 'lui', 'lei', 'loro', 'noi',
  'voi', 'io', 'tu', 'egli', 'essi', 'sono', 'sia', 'stato', 'essere',
  'avere', 'ha', 'ho', 'hai', 'hanno', 'era', 'ero',
]

const INTERVENTI_SETTINGS = {
  searchableAttributes: ['testo', 'oratore_nome', 'odg_titolo'],
  filterableAttributes: [
    'chamber',
    'legislatura',
    'gruppo',
    'oratore_id_persona',
    'seduta',
    'seduta_data',
    'organo',
    'tipo_resoconto',
    'organo_slug',
  ],
  sortableAttributes: ['seduta_data'],
  stopWords: ITALIAN_STOPWORDS,
  // Default ranking rules, made explicit. `sort` sits above `exactness` so an
  // explicit date sort (when there is no text query) takes effect, while text
  // relevance still drives ranking when a query is present and no sort is set.
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
} as const

// Create the index (if missing) and apply settings. Idempotent: safe to call
// on every boot. Returns once the settings task has completed so callers can
// rely on the index being query-ready.
export async function ensureInterventiIndex(): Promise<void> {
  // Create the index (with `id` primary key) only if it does not already
  // exist. Meili reports "already exists" as a FAILED TASK, not an HTTP error,
  // so an existence check is cleaner than parsing the create task's outcome.
  if (!(await indexExists(INTERVENTI_INDEX))) {
    const task = await meiliFetch<MeiliTask>('POST', '/indexes', {
      uid: INTERVENTI_INDEX,
      primaryKey: 'id',
    })
    await waitForTask(task)
  }
  const settingsTask = await meiliFetch<MeiliTask>(
    'PATCH',
    `/indexes/${INTERVENTI_INDEX}/settings`,
    INTERVENTI_SETTINGS,
  )
  await waitForTask(settingsTask)
}

async function indexExists(uid: string): Promise<boolean> {
  try {
    await meiliFetch('GET', `/indexes/${uid}`)
    return true
  } catch (err) {
    if (err instanceof MeiliError && err.status === 404) return false
    throw err
  }
}

// ----------------------------------------------------------------------------
// Document mapping
//
// One mapper shared by the cold-sync script and the ingest hook, fed by the
// shared SQL projection below, so a full rebuild and an incremental update
// always produce byte-identical documents.
// ----------------------------------------------------------------------------

// The exact SELECT projection that yields a row consumable by `mapInterventoRow`.
// Callers append their own `FROM parlamento_interventi WHERE ... `.
export const INTERVENTO_DOC_PROJECTION = `
  id,
  testo,
  oratore_nome,
  gruppo,
  anchor,
  posizione,
  mandato_id.id_persona AS oratore_id_persona,
  seduta_id AS seduta,
  seduta_id.chamber AS chamber,
  seduta_id.legislatura AS legislatura,
  seduta_id.numero AS seduta_numero,
  seduta_id.data AS seduta_data,
  seduta_id.organo AS organo,
  seduta_id.tipo_resoconto AS tipo_resoconto,
  seduta_id.organo_slug AS organo_slug,
  seduta_id.organo_nome AS organo_nome,
  odg_id.titolo AS odg_titolo`

export interface InterventoRow {
  id: unknown
  testo?: string | null
  oratore_nome?: string | null
  gruppo?: string | null
  anchor?: string | null
  posizione?: number | null
  oratore_id_persona?: number | null
  seduta?: unknown
  chamber?: string | null
  legislatura?: number | null
  seduta_numero?: number | null
  seduta_data?: unknown
  organo?: string | null
  tipo_resoconto?: string | null
  organo_slug?: string | null
  organo_nome?: string | null
  odg_titolo?: string | null
}

export interface InterventoDoc {
  id: string
  sid: string
  testo: string
  oratore_nome: string | null
  gruppo: string | null
  anchor: string | null
  posizione: number | null
  oratore_id_persona: number | null
  seduta: string | null
  chamber: string | null
  legislatura: number | null
  seduta_numero: number | null
  seduta_data: number | null
  /**
   * 'assemblea' | 'commissione'. Filterable so the reader can scope a search
   * to plenary work, committee work, or both.
   */
  organo: string | null
  /**
   * 'stenografico' | 'sommario'. This one is an integrity guard rather than a
   * convenience: Senato committee documents are third-person SUMMARIES, so a
   * snippet from one is the secretariat's paraphrase and must never be
   * rendered as a quotation. The reader needs this on every hit to label it.
   */
  tipo_resoconto: string | null
  organo_slug: string | null
  organo_nome: string | null
  odg_titolo: string | null
}

// Meili document ids must match /^[A-Za-z0-9_-]{1,511}$/. SurrealDB record ids
// look like `parlamento_interventi:01J...`; replacing the colon (and any other
// out-of-class char) preserves uniqueness because the key segment is a unique
// ULID/rand of safe characters.
function toDocId(recordId: unknown): string {
  return String(recordId).replace(/[^A-Za-z0-9_-]/g, '_')
}

function toEpochSeconds(value: unknown): number | null {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(String(value))
  const t = d.getTime()
  return Number.isNaN(t) ? null : Math.floor(t / 1000)
}

export function mapInterventoRow(row: InterventoRow): InterventoDoc {
  return {
    id: toDocId(row.id),
    sid: String(row.id),
    testo: row.testo ?? '',
    oratore_nome: row.oratore_nome ?? null,
    gruppo: row.gruppo ?? null,
    anchor: row.anchor ?? null,
    posizione: typeof row.posizione === 'number' ? row.posizione : null,
    oratore_id_persona:
      typeof row.oratore_id_persona === 'number' ? row.oratore_id_persona : null,
    seduta: row.seduta == null ? null : String(row.seduta),
    chamber: row.chamber ?? null,
    legislatura: typeof row.legislatura === 'number' ? row.legislatura : null,
    seduta_numero: typeof row.seduta_numero === 'number' ? row.seduta_numero : null,
    seduta_data: toEpochSeconds(row.seduta_data),
    organo: row.organo ?? 'assemblea',
    tipo_resoconto: row.tipo_resoconto ?? 'stenografico',
    organo_slug: row.organo_slug ?? null,
    organo_nome: row.organo_nome ?? null,
    odg_titolo: row.odg_titolo ?? null,
  }
}

// ----------------------------------------------------------------------------
// Write operations
// ----------------------------------------------------------------------------

// Push (upsert) a batch of documents. Meili indexes asynchronously; pass
// `wait: true` (cold sync) to block until the task settles, or false
// (fire-and-forget ingest hook) to return immediately after enqueue.
export async function addInterventiDocs(
  docs: InterventoDoc[],
  opts: { wait?: boolean } = {},
): Promise<void> {
  if (docs.length === 0) return
  const task = await meiliFetch<MeiliTask>(
    'POST',
    `/indexes/${INTERVENTI_INDEX}/documents`,
    docs,
  )
  if (opts.wait) await waitForTask(task)
}

// Delete every document belonging to a seduta (by its SurrealDB record id
// string). Used by the ingest hook before re-adding the seduta's fresh docs,
// mirroring the DELETE-then-INSERT the body pass does in SurrealDB.
export async function deleteSedutaDocs(
  sedutaId: string,
  opts: { wait?: boolean } = {},
): Promise<void> {
  const task = await meiliFetch<MeiliTask>(
    'POST',
    `/indexes/${INTERVENTI_INDEX}/documents/delete`,
    { filter: `seduta = ${JSON.stringify(sedutaId)}` },
  )
  if (opts.wait) await waitForTask(task)
}

// ----------------------------------------------------------------------------
// Search
// ----------------------------------------------------------------------------

export interface MeiliSearchParams {
  q: string
  filter?: string | string[]
  sort?: string[]
  offset?: number
  limit?: number
  attributesToCrop?: string[]
  cropLength?: number
  attributesToHighlight?: string[]
  highlightPreTag?: string
  highlightPostTag?: string
  attributesToRetrieve?: string[]
  showRankingScore?: boolean
}

export interface MeiliSearchResult<T = Record<string, unknown>> {
  hits: T[]
  estimatedTotalHits?: number
  totalHits?: number
  offset: number
  limit: number
}

export async function searchInterventi<T = Record<string, unknown>>(
  params: MeiliSearchParams,
): Promise<MeiliSearchResult<T>> {
  return meiliFetch<MeiliSearchResult<T>>(
    'POST',
    `/indexes/${INTERVENTI_INDEX}/search`,
    params,
  )
}

// ----------------------------------------------------------------------------
// Task polling
// ----------------------------------------------------------------------------

// Block until an enqueued task reaches a terminal state. Meili task ids come
// back as `taskUid`. Polls /tasks/{uid}; throws on `failed`/`canceled`.
export async function waitForTask(
  task: MeiliTask,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const uid = task.taskUid ?? task.uid
  if (uid == null) return
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000
  const intervalMs = opts.intervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await meiliFetch<MeiliTask>('GET', `/tasks/${uid}`)
    if (status.status === 'succeeded') return
    if (status.status === 'failed' || status.status === 'canceled') {
      throw new MeiliError(
        `meili task ${uid} ${status.status}: ${status.error?.message ?? 'unknown error'}`,
        undefined,
        status,
      )
    }
    if (Date.now() > deadline) {
      throw new MeiliError(`meili task ${uid} did not settle within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// Block until Meili has no enqueued/processing tasks. Used by the cold sync,
// which fires document batches without waiting on each (so SurrealDB reads
// aren't stalled behind Meili indexing on the shared disk) and then drains the
// queue once at the end.
export async function waitForMeiliIdle(
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000
  const intervalMs = opts.intervalMs ?? 1000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await meiliFetch<{ results?: unknown[] }>(
      'GET',
      '/tasks?statuses=enqueued,processing&limit=1',
    )
    if (!res.results || res.results.length === 0) return
    if (Date.now() > deadline) {
      throw new MeiliError(`meili did not drain its task queue within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export async function meiliHealth(): Promise<boolean> {
  try {
    const res = await meiliFetch<{ status?: string }>('GET', '/health')
    return res?.status === 'available'
  } catch {
    return false
  }
}
