import { Router, type Request, type Response, type NextFunction } from 'express'

import { runQuery } from '../lib/query.ts'
import type { Chamber } from '../lib/ingest/parlamento/persona.ts'
import { MeiliError, meiliEnabled, searchInterventi } from '../lib/meilisearch.ts'
import {
  BadParamError,
  clampInt,
  parseChamber,
  parseIntParam,
  parseLegParam,
  parseStringParam,
} from '../lib/http-params.ts'

// -----------------------------------------------------------------------------
// Read-side API for the Parlamento section.
//
//   GET /api/parlamento/calendar?from=YYYY-MM&to=YYYY-MM   -> month-grouped counts
//   GET /api/parlamento/sedute?chamber=&page=                     -> paginated session list
//   GET /api/parlamento/sedute/:chamber/:leg/:numero               -> seduta + odg + speakers
//   GET /api/parlamento/sedute/:chamber/:leg/:numero/interventi    -> reader content (paginated)
//   GET /api/parlamento/search?q=&chamber=&page=          -> BM25 cross-corpus search
//   GET /api/parlamento/persona/:chamber/:idPersona       -> persona + mandati + interventi
//   GET /api/parlamento/refs/leggi-piu-citate             -> most-cited references
//
// All queries use bind parameters; no user input is interpolated into SQL --
// including LIMIT / START, which take $pageSize / $offset like every other
// value. (They used to be template-interpolated. That was safe in practice
// because clampInt always yields a finite integer, but it made the invariant
// above depend on a caller's discipline rather than on the query builder, and
// two handlers in this same file were already using the bind form.)
//
// Malformed filter values are a 400, not a silently-dropped filter: see the
// BadParamError handler at the bottom of this file.
// -----------------------------------------------------------------------------

const router = Router()

const SOURCE_URL = 'https://dati.camera.it/'

// ---------------------------------------------------------------------------
// HTTP caching. Every parlamento endpoint serves public open data that changes
// at most once a day (the daily ingest appends new sedute; existing historical
// transcripts never change). A short max-age cuts repeat traffic and lets the
// browser / shared edge Caddy serve cold loads without round-tripping to the
// backend; stale-while-revalidate keeps responses instant past the freshness
// window. This complements the client-side localStorage cache in the useQuery
// hook -- that covers warm in-app navigation, these headers cover cold loads,
// new tabs, and shared/edge caches.
const LISTING_MAXAGE = 300 // 5 min: listings shift when the daily ingest runs
const IMMUTABLE_MAXAGE = 3600 // 1h: an ingested historical transcript is static
const SWR_WINDOW = 86400 // serve stale up to a day while revalidating in the bg

function setPublicCache(res: Response, maxAgeSec: number, swrSec = SWR_WINDOW): void {
  res.set('Cache-Control', `public, max-age=${maxAgeSec}, stale-while-revalidate=${swrSec}`)
}

// Default cache policy for every GET in this router. Handlers that serve
// effectively-immutable per-seduta content override this by calling
// setPublicCache again on their SUCCESS path -- doing it there (not here)
// avoids slapping a long TTL on a 404 for a seduta that may be ingested later.
router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'GET') setPublicCache(res, LISTING_MAXAGE)
  next()
})

// SurrealDB's `data` field on parlamento_sedute is typed as `datetime`. Binding
// a raw ISO string makes the comparison fail (string >= datetime is false for
// every row), so the route's date filters used to silently return zero rows.
// Wrapping in a JS Date object makes the SDK serialise as a real datetime.
function ymToStartUtc(ym: string): Date | null {
  // ym is YYYY-MM. The day is fixed at the 1st (start of month).
  const d = new Date(`${ym}-01T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}
function ymToEndUtc(ym: string): Date | null {
  // ym is YYYY-MM; we want the END of that month inclusive. Constructing
  // YYYY-MM-31 wraps for shorter months (Feb), so step to the start of the
  // NEXT month minus 1ms.
  const m = ym.match(/^(\d{4})-(\d{2})$/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2]) // 1-12
  const startOfNext =
    month === 12 ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(Date.UTC(year, month, 1))
  if (Number.isNaN(startOfNext.getTime())) return null
  return new Date(startOfNext.getTime() - 1)
}

interface SedutaRow {
  id: { tb: string; id: string } | string
  chamber: string
  legislatura: number
  numero: number
  data: string
  titolo: string | null
  source_url: string | null
  html_url: string | null
  xml_url: string | null
  video_url: string | null
  interventi_n: number | null
  odg_n: number | null
  body_status: string | null
}

// ---- organo scoping ----------------------------------------------------------
//
// parlamento_sedute holds both plenary sittings and committee sittings, and
// (chamber, legislatura, numero) is unique only WITHIN one of those. So every
// query here has to say which it means. Endpoints that address a single
// sitting are hard-scoped to the plenary corpus and committee sittings get
// their own routes keyed by document scope; endpoints that list or search take
// an `organo` parameter and default to plenary, so an existing client sees
// exactly the results it saw before committee data was ingested.

const ORGANO_ASSEMBLEA = 'assemblea'
const ORGANO_COMMISSIONE = 'commissione'

/**
 * Read the `organo` query parameter.
 *
 * Returns the organo to filter on, or null for "both". Defaults to the
 * plenary corpus: silently widening existing endpoints to include committee
 * work would change every already-published count and mix third-person Senato
 * summaries into result sets that clients render as verbatim speech.
 */
function parseOrgano(raw: unknown): string | null {
  if (raw === 'tutti' || raw === 'all') return null
  if (raw === ORGANO_COMMISSIONE) return ORGANO_COMMISSIONE
  return ORGANO_ASSEMBLEA
}

// ---- /calendar ---------------------------------------------------------------

interface CalendarRow {
  ym: string
  chamber: string
  count: number
}

router.get('/calendar', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const chamberFilter = parseChamber(req.query.chamber)
    const from = typeof req.query.from === 'string' ? req.query.from : null
    const to = typeof req.query.to === 'string' ? req.query.to : null
    const legFilter = parseLegParam(req.query.leg)

    const where: string[] = ['body_status IN ["ok","pending","empty","error"]']
    const bindings: Record<string, unknown> = {}
    const organo = parseOrgano(req.query.organo)
    if (organo) {
      where.push('organo = $organo')
      bindings.organo = organo
    }
    if (chamberFilter) {
      where.push('chamber = $chamber')
      bindings.chamber = chamberFilter
    }
    // The year shortcuts this endpoint feeds sit next to the sedute list,
    // so they have to be scoped the same way. Without this a reader
    // browsing the XV legislatura was offered every year from 1996 to
    // today, which both looked like the legislature filter was being
    // ignored and produced empty pages when a year outside it was picked.
    if (legFilter !== null) {
      where.push('legislatura = $leg')
      bindings.leg = legFilter
    }
    if (from) {
      const start = ymToStartUtc(from)
      if (start) {
        where.push('data >= $from')
        bindings.from = start
      }
    }
    if (to) {
      const end = ymToEndUtc(to)
      if (end) {
        where.push('data <= $to')
        bindings.to = end
      }
    }

    const rows = await runQuery<Array<{ data: string; chamber: string; n: number }>>(
      `SELECT
         time::format(data, '%Y-%m') AS ym,
         chamber,
         count() AS n
       FROM parlamento_sedute
       WHERE ${where.join(' AND ')}
       GROUP BY ym, chamber;`,
      bindings,
    )

    const out: CalendarRow[] = ((rows ?? []) as Array<{ ym?: string; chamber: string; n: number }>).map(
      (r) => ({
        ym: r.ym ?? '',
        chamber: r.chamber,
        count: r.n,
      }),
    )
    out.sort((a, b) => a.ym.localeCompare(b.ym) || a.chamber.localeCompare(b.chamber))
    res.json({ data: out, source: SOURCE_URL })
  } catch (err) {
    next(err)
  }
})

// ---- /sedute -----------------------------------------------------------------

router.get('/sedute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const chamberFilter = parseChamber(req.query.chamber)
    const page = clampInt(req.query.page, 1, 1, 9999)
    const pageSize = clampInt(req.query.pageSize, 30, 1, 100)
    const from = typeof req.query.from === 'string' ? req.query.from : null
    const to = typeof req.query.to === 'string' ? req.query.to : null
    const sort = req.query.sort === 'oldest' ? 'oldest' : 'newest'
    const legFilter = parseLegParam(req.query.leg)

    const where: string[] = []
    const bindings: Record<string, unknown> = {}
    const organo = parseOrgano(req.query.organo)
    if (organo) {
      where.push('organo = $organo')
      bindings.organo = organo
    }
    if (chamberFilter) {
      where.push('chamber = $chamber')
      bindings.chamber = chamberFilter
    }
    if (legFilter !== null) {
      where.push('legislatura = $leg')
      bindings.leg = legFilter
    }
    if (from) {
      const start = ymToStartUtc(from)
      if (start) {
        where.push('data >= $from')
        bindings.from = start
      }
    }
    if (to) {
      const end = ymToEndUtc(to)
      if (end) {
        where.push('data <= $to')
        bindings.to = end
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const orderSql =
      sort === 'oldest'
        ? 'ORDER BY data ASC, chamber ASC'
        : 'ORDER BY data DESC, chamber ASC'

    const offset = (page - 1) * pageSize
    // WITH NOINDEX is REQUIRED for correctness here, not just a perf choice.
    // When a date range filter is present (from/to), SurrealDB serves it via
    // idx_seduta_data and emits rows in INDEX (ascending) order, SILENTLY
    // ignoring `ORDER BY data DESC` -- so "Più recenti" returned the OLDEST
    // sessions of the range first (the 2026 view looked like it stopped in
    // February while June data sat on the last page). Forcing a scan + real
    // sort fixes the order; parlamento_sedute is ~9.5k rows, so the scan is
    // sub-10ms. (If this table ever grows large, revisit with a composite
    // index or a sort that the planner can't satisfy from the index.)
    const rows = await runQuery<SedutaRow[]>(
      `SELECT
         type::string(id) AS id,
         chamber, legislatura, numero, data, titolo,
         source_url, html_url, xml_url, video_url,
         interventi_n, odg_n, body_status,
         organo, organo_cod, organo_nome, organo_slug,
         tipo_resoconto, tipologia, sottotipologia
       FROM parlamento_sedute WITH NOINDEX
       ${whereSql}
       ${orderSql}
       START $offset LIMIT $pageSize;`,
      { ...bindings, offset, pageSize },
    )

    // WITH NOINDEX is REQUIRED for correctness here too, for the same reason
    // as the list query above and then some: with more than one indexable
    // predicate, SurrealDB's count() serves the aggregate from ONE index and
    // silently DROPS the other conjuncts. Measured on this dataset:
    //
    //   count() WHERE chamber = "camera" AND data >= 2026-01-01 AND data <= 2026-12-31
    //     -> 187   (the chamber filter is ignored; 187 is both chambers)
    //   ... WITH NOINDEX                       -> 115   (correct)
    //
    // The reported total drove the paginator, so "Più recenti" for one chamber
    // advertised 38 pages when only 23 had rows. Swapping the order of the two
    // conditions changes which predicate is dropped, which is the tell.
    //
    // The scan costs ~70ms on 9.8k rows. The other count() sites in this file
    // were checked against a materialised `array::len(...)` of the same filter
    // and agree, so they keep their index paths -- NOINDEX there costs 1.4s on
    // parlamento_odg and parlamento_riferimenti and buys nothing.
    const totalRows = await runQuery<Array<{ n: number }>>(
      `SELECT count() AS n FROM parlamento_sedute WITH NOINDEX ${whereSql} GROUP ALL;`,
      bindings,
    )
    const total = totalRows?.[0]?.n ?? 0

    res.json({
      data: rows ?? [],
      page,
      pageSize,
      total,
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// ---- /sedute/:chamber/:leg/:numero -------------------------------------------

router.get(
  '/sedute/:chamber/:leg/:numero',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const chamber = parseChamber(req.params.chamber)
      if (!chamber) return res.status(400).json({ error: 'invalid chamber' })
      const legislatura = Number(req.params.leg)
      if (!Number.isFinite(legislatura) || legislatura <= 0) {
        return res.status(400).json({ error: 'invalid legislatura' })
      }
      const numero = Number(req.params.numero)
      if (!Number.isFinite(numero)) {
        return res.status(400).json({ error: 'invalid numero' })
      }

      // Project the raw record id alongside its string form. The string is
      // what the JSON response carries; the raw id (a SurrealDB RecordId) is
      // bound into the child queries so they can use idx_int_seduta /
      // idx_odg_seduta directly. WHERE seduta_id.chamber = $c AND
      // seduta_id.numero = $n traverses INTO the link and forces a full
      // scan of parlamento_interventi (112k rows -> ~6s); WHERE seduta_id =
      // $sedId hits the index and returns in single-digit ms.
      const sedutaRows = await runQuery<Array<SedutaRow & { rawId: unknown }>>(
        `SELECT
           id AS rawId,
           type::string(id) AS id,
           chamber, legislatura, numero, data, titolo,
           source_url, html_url, xml_url, video_url,
           interventi_n, odg_n, body_status
         FROM parlamento_sedute
         WHERE organo = "assemblea"
           AND chamber = $chamber AND legislatura = $leg AND numero = $num
         LIMIT 1;`,
        { chamber, leg: legislatura, num: numero },
      )
      const sedutaRow = sedutaRows?.[0]
      if (!sedutaRow) return res.status(404).json({ error: 'seduta not found' })
      const { rawId: sedId, ...seduta } = sedutaRow

      const { odg, oratori } = await loadOdgAndOratori(sedId)

      // Historical seduta metadata is effectively immutable once ingested.
      setPublicCache(res, IMMUTABLE_MAXAGE)
      res.json({
        seduta,
        odg,
        oratori,
        source: SOURCE_URL,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ---- /sedute/:chamber/:numero/interventi -------------------------------------

interface InterventoRow {
  id: unknown // RecordId of parlamento_interventi -- used as join key, not sent to client
  posizione: number
  oratore_nome: string | null
  /** Composite key for linking to the speaker's persona page. Null when the
   *  speaker had no profile-link in the transcript (role-only "PRESIDENTE."). */
  oratore_id_persona: number | null
  oratore_chamber: 'camera' | 'senato' | null
  /** Group authoritatively resolved from the mandato when the transcript
   *  itself didn't carry it (typical for Camera). */
  oratore_mandato_gruppo: string | null
  gruppo: string | null
  ruolo: string | null
  testo: string
  anchor: string
  odg_pos: number | null
}

interface RiferimentoRow {
  intervento: unknown // RecordId of parlamento_interventi -- the join key
  tipo: string
  anno: number | null
  numero: string | null
  articolo: number | null
  urn: string | null
  url: string | null
  resolve_status: string
  start: number
  end_offset: number
  raw: string
}

interface PublicRiferimento {
  tipo: string
  anno: number | null
  numero: string | null
  articolo: number | null
  urn: string | null
  url: string | null
  resolve_status: string
  start: number
  end_offset: number
  raw: string
}

router.get(
  '/sedute/:chamber/:leg/:numero/interventi',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const chamber = parseChamber(req.params.chamber)
      if (!chamber) return res.status(400).json({ error: 'invalid chamber' })
      const legislatura = Number(req.params.leg)
      if (!Number.isFinite(legislatura) || legislatura <= 0) {
        return res.status(400).json({ error: 'invalid legislatura' })
      }
      const numero = Number(req.params.numero)
      if (!Number.isFinite(numero)) {
        return res.status(400).json({ error: 'invalid numero' })
      }
      const page = clampInt(req.query.page, 1, 1, 9999)
      // Ceiling raised from 1000 to 5000 so the reader can fetch a whole seduta
      // in one request. The reader renders the transcript as one continuous
      // document (anchors, index jumps, native find all depend on every block
      // being in the DOM), so it asks for everything at once; the old 1000 cap
      // silently truncated the 57 sedute with >1000 interventi (max 2885).
      const pageSize = clampInt(req.query.pageSize, 200, 1, 5000)
      const offset = (page - 1) * pageSize

      // Resolve the seduta record id once, then bind it into the data + count
      // queries so they hit idx_int_seduta. See the comment in the detail
      // handler for why traversing seduta_id.chamber / .numero forces a full
      // scan and the record-id form does not.
      const sedutaIdRows = await runQuery<Array<{ id: unknown; n: number | null }>>(
        // organo is REQUIRED, not decorative: committee resoconti are
        // numbered per-committee, so without it camera/19/1 matches the
        // plenary sitting AND the first sitting of every committee, and
        // LIMIT 1 would hand back whichever the planner reached first.
        `SELECT id, interventi_n AS n FROM parlamento_sedute
         WHERE organo = "assemblea"
           AND chamber = $chamber AND legislatura = $leg AND numero = $num
         LIMIT 1;`,
        { chamber, leg: legislatura, num: numero },
      )
      const sedutaRow = sedutaIdRows?.[0]
      if (!sedutaRow) return res.status(404).json({ error: 'seduta not found' })
      const sedId = sedutaRow.id

      const { data, total } = await loadInterventiPage(
        sedId,
        offset,
        pageSize,
        sedutaRow.n ?? null,
      )

      // A seduta's interventi are static once the body pass has run.
      setPublicCache(res, IMMUTABLE_MAXAGE)
      res.json({
        data,
        page,
        pageSize,
        total,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ---- shared seduta loaders ---------------------------------------------------
//
// The plenary and committee readers render the same thing -- an agenda, a
// speaker roster, and a paginated transcript with inline references -- and
// differ only in how the sitting is addressed (chamber+leg+numero vs a
// document scope). So the addressing lives in the handlers and the loading
// lives here, rather than in two copies that drift.

interface OratoreSummary {
  nome: string
  id_persona: number | null
  gruppo: string | null
  ruolo: string | null
  interventi: number
}

interface OdgEntry {
  posizione: number
  titolo: string
  anchor: string
}

async function loadOdgAndOratori(
  sedId: unknown,
): Promise<{ odg: OdgEntry[]; oratori: OratoreSummary[] }> {
  const [odgRows, oratoriRows] = await Promise.all([
    runQuery<OdgEntry[]>(
      `SELECT posizione, titolo, anchor
       FROM parlamento_odg
       WHERE seduta_id = $sed
       ORDER BY posizione ASC;`,
      { sed: sedId },
    ),
    runQuery<
      Array<{
        oratore_nome: string
        id_persona: number | null
        mandato_gruppo: string | null
        transcript_gruppo: string | null
        ruolo: string | null
        n: number
      }>
    >(
      // Speakers are grouped by their resolved mandato (chamber x leg x
      // id_persona). Camera transcripts don't carry the group inline so
      // `gruppo` on interventi is null for those rows; the authoritative
      // current-leg group is `mandato_id.gruppo_attuale`, populated by the
      // deputati profile-scrape pass. Senato transcripts include the group
      // inline (e.g. "GARAVAGLIA (LSP-PSd'Az).") so `gruppo` is set there and
      // takes precedence on display.
      //
      // Committee sittings add a third case: speakers who are not
      // parliamentarians at all (auditees, consultants, officials). They have
      // no mandato, so id_persona and mandato_gruppo are both null and the
      // row is carried entirely by oratore_nome and ruolo.
      `SELECT oratore_nome,
              mandato_id.id_persona AS id_persona,
              mandato_id.gruppo_attuale AS mandato_gruppo,
              gruppo AS transcript_gruppo,
              ruolo,
              count() AS n
       FROM parlamento_interventi
       WHERE seduta_id = $sed AND oratore_nome IS NOT NONE
       GROUP BY oratore_nome, mandato_id.id_persona, mandato_id.gruppo_attuale, gruppo, ruolo;`,
      { sed: sedId },
    ),
  ])

  const oratori = (oratoriRows ?? [])
    .slice()
    .sort((a, b) => b.n - a.n)
    .map((r) => ({
      nome: r.oratore_nome,
      id_persona: r.id_persona ?? null,
      gruppo: r.transcript_gruppo ?? r.mandato_gruppo ?? null,
      ruolo: r.ruolo,
      interventi: r.n,
    }))

  return { odg: odgRows ?? [], oratori }
}

async function loadInterventiPage(
  sedId: unknown,
  offset: number,
  pageSize: number,
  precomputedTotal: number | null,
): Promise<{ data: unknown[]; total: number }> {
  const rows = await runQuery<InterventoRow[]>(
    `SELECT
       id,
       posizione, oratore_nome,
       mandato_id.id_persona AS oratore_id_persona,
       mandato_id.chamber AS oratore_chamber,
       mandato_id.gruppo_attuale AS oratore_mandato_gruppo,
       gruppo, ruolo, testo, anchor,
       odg_id.posizione AS odg_pos
     FROM parlamento_interventi
     WHERE seduta_id = $sed
     ORDER BY posizione ASC
     START $offset LIMIT $pageSize;`,
    { sed: sedId, offset, pageSize },
  )

  // Pull all refs belonging to this page's interventi in one batched query,
  // then group by intervento id. Done this way (vs. an in-SELECT join)
  // because SurrealDB SCHEMALESS joins via FETCH inflate the row size and
  // require defensive null-checks throughout the response shape.
  const interventoIds = (rows ?? []).map((r) => r.id).filter(Boolean)
  const refsByIntervento = new Map<string, PublicRiferimento[]>()
  if (interventoIds.length > 0) {
    const refRows = await runQuery<RiferimentoRow[]>(
      `SELECT intervento, tipo, anno, numero, articolo, urn, url,
              resolve_status, start, end_offset, raw
       FROM parlamento_riferimenti
       WHERE intervento IN $ids
       ORDER BY start ASC;`,
      { ids: interventoIds },
    )
    for (const r of refRows ?? []) {
      const key = String(r.intervento)
      if (!refsByIntervento.has(key)) refsByIntervento.set(key, [])
      refsByIntervento.get(key)!.push({
        tipo: r.tipo,
        anno: r.anno,
        numero: r.numero,
        articolo: r.articolo,
        urn: r.urn,
        url: r.url,
        resolve_status: r.resolve_status,
        start: r.start,
        end_offset: r.end_offset,
        raw: r.raw,
      })
    }
  }

  // Prefer the precomputed interventi_n written by the body pass over a live
  // count. A precomputed 0 is a legitimate value (an empty sitting) and must
  // not retrigger the fallback, so the test is on null, not falsiness.
  let total: number
  if (precomputedTotal == null) {
    const totalRows = await runQuery<Array<{ n: number }>>(
      `SELECT count() AS n FROM parlamento_interventi WHERE seduta_id = $sed GROUP ALL;`,
      { sed: sedId },
    )
    total = totalRows?.[0]?.n ?? 0
  } else {
    total = precomputedTotal
  }

  const data = (rows ?? []).map((r) => {
    const { id, ...publicFields } = r
    return { ...publicFields, riferimenti: refsByIntervento.get(String(id)) ?? [] }
  })

  return { data, total }
}

// ---- /commissioni ------------------------------------------------------------
//
//   GET /commissioni?chamber=&leg=                 -> committee roster
//   GET /commissioni/:slug/sedute?page=            -> one committee's sittings
//   GET /commissioni/seduta/:scope                 -> sitting + agenda + speakers
//   GET /commissioni/seduta/:scope/interventi      -> transcript (paginated)
//
// Committee sittings are addressed by their document scope (the record id
// suffix, e.g. `cc-19-03-indag-c03-commercio-6`) rather than by numero,
// because committee resoconti are numbered per-committee and a numero is
// therefore not unique within a chamber and legislature.

/** Committee scopes are generated by the ingest; accept only that shape. */
function parseScope(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v || v.length > 120) return null
  return /^[a-z0-9-]+$/i.test(v) ? v : null
}

const COMMISSIONE_SEDUTA_FIELDS = `
  chamber, legislatura, numero, data, titolo,
  source_url, html_url, interventi_n, odg_n, body_status,
  organo, organo_cod, organo_nome, organo_slug,
  tipo_resoconto, tipologia, sottotipologia`

router.get('/commissioni', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const chamberFilter = parseChamber(req.query.chamber)
    const legFilter = parseLegParam(req.query.leg)

    const where: string[] = ['organo = "commissione"']
    const bindings: Record<string, unknown> = {}
    if (chamberFilter) {
      where.push('chamber = $chamber')
      bindings.chamber = chamberFilter
    }
    if (legFilter !== null) {
      where.push('legislatura = $leg')
      bindings.leg = legFilter
    }

    const rows = await runQuery<
      Array<{
        organo_slug: string
        organo_cod: string | null
        organo_nome: string | null
        chamber: string
        tipo_resoconto: string | null
        n: number
        prima: string | null
        ultima: string | null
        interventi: number | null
      }>
    >(
      `SELECT organo_slug, organo_cod, organo_nome, chamber, tipo_resoconto,
              count() AS n,
              time::min(data) AS prima,
              time::max(data) AS ultima,
              math::sum(interventi_n) AS interventi
       FROM parlamento_sedute
       WHERE ${where.join(' AND ')}
       GROUP BY organo_slug, organo_cod, organo_nome, chamber, tipo_resoconto;`,
      bindings,
    )

    // Merge on organo_slug, the stable key.
    //
    // A committee's OFFICIAL NAME changes between legislatures while its code
    // stays put -- camera-39 is "Commissione parlamentare di inchiesta sulle
    // attivita' illecite connesse al ciclo dei rifiuti" in one legislature and
    // carries "e su illeciti ambientali ad esse correlati" in another. Grouping
    // on the name in SQL therefore splits one committee into several cards with
    // partial counts, which reads as duplicates. The detail route already keys
    // on the slug alone, so those cards all led to the same place.
    //
    // The displayed name is taken from the most recent group, so a committee is
    // labelled as Parliament last called it.
    const merged = new Map<string, (typeof rows)[number]>()
    for (const r of rows ?? []) {
      const key = `${r.chamber}:${r.organo_slug}`
      const prev = merged.get(key)
      if (!prev) {
        merged.set(key, { ...r })
        continue
      }
      const newerName = (r.ultima ?? '') > (prev.ultima ?? '')
      merged.set(key, {
        ...prev,
        n: prev.n + r.n,
        interventi: (prev.interventi ?? 0) + (r.interventi ?? 0) || null,
        prima:
          prev.prima && r.prima ? (prev.prima < r.prima ? prev.prima : r.prima) : prev.prima ?? r.prima,
        ultima:
          prev.ultima && r.ultima ? (prev.ultima > r.ultima ? prev.ultima : r.ultima) : prev.ultima ?? r.ultima,
        organo_nome: newerName ? r.organo_nome : prev.organo_nome,
      })
    }

    const data = [...merged.values()].sort(
      (a, b) => b.n - a.n || (a.organo_nome ?? '').localeCompare(b.organo_nome ?? ''),
    )

    setPublicCache(res, LISTING_MAXAGE)
    res.json({ data, total: data.length })
  } catch (err) {
    next(err)
  }
})

router.get(
  '/commissioni/:slug/sedute',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const slug = parseScope(req.params.slug)
      if (!slug) return res.status(400).json({ error: 'invalid commissione slug' })
      const page = clampInt(req.query.page, 1, 1, 9999)
      const pageSize = clampInt(req.query.pageSize, 30, 1, 100)
      const offset = (page - 1) * pageSize
      const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC'
      const legFilter = parseLegParam(req.query.leg)

      const where = ['organo = "commissione"', 'organo_slug = $slug']
      const bindings: Record<string, unknown> = { slug }
      if (legFilter !== null) {
        where.push('legislatura = $leg')
        bindings.leg = legFilter
      }
      // Title filter, so a committee with 400+ sittings is navigable without
      // paging through it. Scoped to one committee already, so the CONTAINS
      // scan is over hundreds of rows, not the whole table.
      const titleQuery = parseStringParam(req.query.q)
      if (titleQuery.length >= 2) {
        where.push('string::lowercase(titolo ?? "") CONTAINS $q')
        bindings.q = titleQuery.toLowerCase()
      }
      const whereSql = `WHERE ${where.join(' AND ')}`

      const [rows, totalRows] = await Promise.all([
        runQuery<Array<Record<string, unknown>>>(
          `SELECT type::string(id) AS id, ${COMMISSIONE_SEDUTA_FIELDS}
           FROM parlamento_sedute
           ${whereSql}
           ORDER BY data ${sort}, numero ${sort}
           START $offset LIMIT $pageSize;`,
          { ...bindings, offset, pageSize },
        ),
        runQuery<Array<{ n: number }>>(
          `SELECT count() AS n FROM parlamento_sedute ${whereSql} GROUP ALL;`,
          bindings,
        ),
      ])

      const total = totalRows?.[0]?.n ?? 0
      setPublicCache(res, LISTING_MAXAGE)
      res.json({
        data: rows ?? [],
        page,
        pageSize,
        total,
        has_more: offset + (rows?.length ?? 0) < total,
      })
    } catch (err) {
      next(err)
    }
  },
)

router.get(
  '/commissioni/seduta/:scope',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = parseScope(req.params.scope)
      if (!scope) return res.status(400).json({ error: 'invalid seduta scope' })

      const rows = await runQuery<Array<Record<string, unknown> & { rawId: unknown }>>(
        `SELECT id AS rawId, type::string(id) AS id, ${COMMISSIONE_SEDUTA_FIELDS}
         FROM type::thing("parlamento_sedute", $scope);`,
        { scope },
      )
      const row = rows?.[0]
      if (!row || row.organo !== 'commissione') {
        return res.status(404).json({ error: 'seduta not found' })
      }
      const { rawId: sedId, ...seduta } = row

      const { odg, oratori } = await loadOdgAndOratori(sedId)

      setPublicCache(res, IMMUTABLE_MAXAGE)
      res.json({ seduta, odg, oratori, source: SOURCE_URL })
    } catch (err) {
      next(err)
    }
  },
)

router.get(
  '/commissioni/seduta/:scope/interventi',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = parseScope(req.params.scope)
      if (!scope) return res.status(400).json({ error: 'invalid seduta scope' })
      const page = clampInt(req.query.page, 1, 1, 9999)
      const pageSize = clampInt(req.query.pageSize, 200, 1, 5000)
      const offset = (page - 1) * pageSize

      const rows = await runQuery<Array<{ id: unknown; n: number | null; organo: string | null }>>(
        `SELECT id, interventi_n AS n, organo
         FROM type::thing("parlamento_sedute", $scope);`,
        { scope },
      )
      const row = rows?.[0]
      if (!row || row.organo !== 'commissione') {
        return res.status(404).json({ error: 'seduta not found' })
      }

      const { data, total } = await loadInterventiPage(row.id, offset, pageSize, row.n ?? null)

      setPublicCache(res, IMMUTABLE_MAXAGE)
      res.json({ data, page, pageSize, total })
    } catch (err) {
      next(err)
    }
  },
)

// ---- /search -----------------------------------------------------------------

interface SearchHit {
  posizione: number
  oratore_nome: string | null
  /** Speaker's official persona id (camera/senato website numeric ID).
   *  Null when the transcript used a role-only label without a profile link. */
  oratore_id_persona: number | null
  oratore_chamber: 'camera' | 'senato' | null
  gruppo: string | null
  testo: string
  snippet: string
  anchor: string
  chamber: string
  legislatura: number
  numero: number
  data: string
  odg_titolo: string | null
  score: number
  /** 'assemblea' | 'commissione'. */
  organo: string | null
  /**
   * 'stenografico' | 'sommario'. The client MUST label a 'sommario' hit as a
   * summary: Senato committee documents paraphrase speakers in the third
   * person, so rendering one as a quotation would attribute words to someone
   * who did not say them.
   */
  tipo_resoconto: string | null
  organo_nome: string | null
  organo_slug: string | null
  /**
   * The sitting's record id as a string. Committee sittings are addressed by
   * document scope rather than by numero, so a committee hit cannot be linked
   * from (chamber, legislatura, numero) the way a plenary one can.
   */
  seduta_id: string | null
}

// Shape of a Meilisearch `parlamento_interventi` document as returned by a
// search (see server/lib/meilisearch.ts mapInterventoRow). `_formatted` holds
// the cropped + <mark>-highlighted `testo`; `_rankingScore` is Meili's 0..1
// relevance (requested via showRankingScore).
interface MeiliInterventoHit {
  posizione?: number
  oratore_nome?: string | null
  oratore_id_persona?: number | null
  gruppo?: string | null
  testo?: string
  anchor?: string | null
  chamber?: string | null
  legislatura?: number
  seduta_numero?: number
  seduta_data?: number
  odg_titolo?: string | null
  organo?: string | null
  tipo_resoconto?: string | null
  organo_nome?: string | null
  organo_slug?: string | null
  seduta?: string | null
  _formatted?: { testo?: string }
  _rankingScore?: number
}

// Project a Meili hit onto the SearchHit shape the /search response and the UI
// expect. `seduta_data` is stored as epoch seconds; the UI formats an ISO
// string, so convert back. `oratore_chamber` uses the seduta chamber (for an
// intervento the speaker's chamber equals the sitting's chamber).
function meiliHitToSearchHit(h: MeiliInterventoHit): SearchHit {
  const chamber = h.chamber ?? ''
  return {
    posizione: typeof h.posizione === 'number' ? h.posizione : 0,
    oratore_nome: h.oratore_nome ?? null,
    oratore_id_persona: typeof h.oratore_id_persona === 'number' ? h.oratore_id_persona : null,
    oratore_chamber: chamber === 'camera' || chamber === 'senato' ? chamber : null,
    gruppo: h.gruppo ?? null,
    testo: h.testo ?? '',
    snippet: h._formatted?.testo ?? '',
    anchor: h.anchor ?? '',
    chamber,
    legislatura: typeof h.legislatura === 'number' ? h.legislatura : 0,
    numero: typeof h.seduta_numero === 'number' ? h.seduta_numero : 0,
    data:
      typeof h.seduta_data === 'number'
        ? new Date(h.seduta_data * 1000).toISOString()
        : '',
    odg_titolo: h.odg_titolo ?? null,
    score: typeof h._rankingScore === 'number' ? h._rankingScore : 0,
    organo: h.organo ?? 'assemblea',
    tipo_resoconto: h.tipo_resoconto ?? 'stenografico',
    organo_nome: h.organo_nome ?? null,
    organo_slug: h.organo_slug ?? null,
    seduta_id: h.seduta ?? null,
  }
}

// `?cita=tipo:anno:numero` -- parts may be empty to mean "any". Examples:
//   cita=legge:2017:205          one specific law
//   cita=decreto.legge::34       any year, decreto-legge n. 34
//   cita=ac::1234                atto Camera n. 1234
// Returns null when the input is missing or malformed.
function parseCita(
  raw: unknown,
): { tipo?: string; anno?: number; numero?: string } | null {
  if (typeof raw !== 'string' || !raw) return null
  const parts = raw.split(':').map((p) => p.trim())
  const tipo = parts[0] || undefined
  const annoStr = parts[1] || ''
  const numero = parts[2] || undefined
  let anno: number | undefined
  if (annoStr) {
    const n = Number(annoStr)
    if (!Number.isFinite(n)) return null
    anno = n
  }
  if (!tipo && anno === undefined && !numero) return null
  return { tipo, anno, numero }
}

router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const cita = parseCita(req.query.cita)
    // Either a meaningful q (>=2 chars) OR a structured cita filter
    // is required. Without one we'd be returning the entire corpus.
    if (q.length < 2 && !cita) {
      return res.json({ data: [], page: 1, pageSize: 0, total: 0, q })
    }
    const chamberFilter = parseChamber(req.query.chamber)
    const organo = parseOrgano(req.query.organo)
    // Narrow to one committee. Implies organo=commissione, so a caller does
    // not have to remember to set both and cannot ask for the contradictory
    // combination of a committee slug inside the plenary corpus.
    const commissione = parseScope(req.query.commissione)
    const page = clampInt(req.query.page, 1, 1, 100)
    const pageSize = clampInt(req.query.pageSize, 20, 1, 50)
    const offset = (page - 1) * pageSize
    // Every paginated query below fetches one extra row to answer "is there a
    // next page?" without counting -- see the has_more note further down.
    const limitPlusOne = pageSize + 1

    // Two-stage strategy: try BM25 (`@@`) first for ranked results with
    // highlights. If the search index is missing or being rebuilt, SurrealDB
    // throws "no suitable index" on the SELECT and we fall back to a plain
    // substring scan (`string::contains`). The fallback is slower (~1-2s for
    // 112k rows) and has no relevance ranking, but it always works -- the
    // user sees results instead of a misleading "no hits" empty state.
    //
    // We deliberately do NOT count BM25 hits. `count() ... WHERE testo @@ $q`
    // forces SurrealDB to walk the full posting list, which dwarfs the cost
    // of the SELECT itself. Instead we fetch one extra row past the page and
    // surface "20+" semantics via `has_more`. The exact total wasn't carrying
    // its weight in the UI anyway.
    // Build the cita predicate parts once. Used in two shapes:
    //   - cita-only path: as the WHERE on parlamento_riferimenti
    //   - q+cita path: wrapped in id IN (...) on parlamento_interventi
    const citaWhere: string[] = []
    const bindings: Record<string, unknown> = {}
    if (q.length >= 2) bindings.q = q
    if (chamberFilter) bindings.chamber = chamberFilter
    if (cita) {
      if (cita.tipo) {
        citaWhere.push('tipo = $cita_tipo')
        bindings.cita_tipo = cita.tipo
      }
      if (cita.anno !== undefined) {
        citaWhere.push('anno = $cita_anno')
        bindings.cita_anno = cita.anno
      }
      if (cita.numero) {
        citaWhere.push('numero = $cita_numero')
        bindings.cita_numero = cita.numero
      }
    }

    let rows: SearchHit[] = []
    let mode: 'meili' | 'substring' | 'cita' = 'meili'

    if (q.length < 2 && cita) {
      // Cita-only path: query parlamento_riferimenti directly using
      // its (tipo, anno, numero) index, then project intervento +
      // seduta info via the record links. Starting from the small
      // refs result set (bounded by the citation count for the law,
      // ~75 max in current data) keeps the seduta-join cost
      // proportional to the filter rather than to the 112k-row
      // intervento table.
      //
      // The chamber filter is applied in JS after projection rather
      // than in the SQL WHERE: pushing seduta.chamber into the
      // riferimenti WHERE forces a seduta link traversal per row in
      // the predicate, which would kill the lookup. Post-filter on a
      // tiny result set is essentially free.
      mode = 'cita'
      // Push the chamber filter into SQL via the denormalised
      // chamber column on parlamento_riferimenti -- avoids the
      // seduta record-link traversal that would otherwise force a
      // full scan. Pagination is also done in SQL with START/LIMIT
      // so we never materialise more than pageSize+1 rows.
      const refWhere = [...citaWhere]
      if (chamberFilter) {
        refWhere.push('chamber = $chamber')
      }
      if (commissione) {
        // parlamento_riferimenti carries organo but not organo_slug, so this
        // one predicate does traverse the seduta link. It is bounded by the
        // citation lookup that precedes it (tens of rows), not by the corpus.
        refWhere.push('seduta.organo_slug = $commissione')
        bindings.commissione = commissione
      }
      if (organo && !commissione) {
        // Denormalised on parlamento_riferimenti, so this stays a plain
        // column predicate rather than a seduta link traversal.
        refWhere.push('organo = $organo')
        bindings.organo = organo
      }
      rows =
        (await runQuery<SearchHit[]>(
          `SELECT
             intervento.posizione AS posizione,
             intervento.oratore_nome AS oratore_nome,
             intervento.gruppo AS gruppo,
             intervento.anchor AS anchor,
             intervento.testo AS testo,
             intervento.mandato_id.id_persona AS oratore_id_persona,
             intervento.mandato_id.chamber AS oratore_chamber,
             '' AS snippet,
             0 AS score,
             seduta.chamber AS chamber,
             seduta.legislatura AS legislatura,
             seduta.numero AS numero,
             seduta.data AS data,
             seduta.organo AS organo,
             seduta.tipo_resoconto AS tipo_resoconto,
             seduta.organo_nome AS organo_nome,
             seduta.organo_slug AS organo_slug,
             type::string(seduta) AS seduta_id,
             intervento.odg_id.titolo AS odg_titolo
           FROM parlamento_riferimenti
           WHERE ${refWhere.join(' AND ')}
           ORDER BY data DESC
           START $offset LIMIT $limitPlusOne;`,
          { ...bindings, offset, limitPlusOne },
        )) ?? []
    } else {
      // q-only or q+cita path.
      const baseWhere: string[] = []
      if (chamberFilter) baseWhere.push('seduta_id.chamber = $chamber')
      if (commissione) {
        baseWhere.push('seduta_id.organo_slug = $commissione')
        bindings.commissione = commissione
      } else if (organo === ORGANO_ASSEMBLEA) {
        // Same reasoning as the Meili filter: rows written before the organo
        // backfill are all plenary. The backfill makes this branch redundant,
        // but it costs nothing and removes an ordering dependency between the
        // deploy and the migration.
        baseWhere.push('(seduta_id.organo = $organo OR seduta_id.organo IS NONE)')
        bindings.organo = organo
      } else if (organo) {
        baseWhere.push('seduta_id.organo = $organo')
        bindings.organo = organo
      }
      if (cita) {
        baseWhere.push(
          `id IN (SELECT VALUE intervento FROM parlamento_riferimenti WHERE ${citaWhere.join(' AND ')})`,
        )
      }

      // The SurrealDB substring scan -- used as the q+cita path (the cita
      // filter lives in parlamento_riferimenti, which Meili docs don't carry)
      // and as the fallback when Meilisearch is unreachable. No relevance
      // ranking, but always works and is bounded by the cita id set when present.
      const runSubstring = async (): Promise<SearchHit[]> => {
        const subWhere = [
          'string::lowercase(testo) CONTAINS string::lowercase($q)',
          ...baseWhere,
        ]
        return (
          (await runQuery<SearchHit[]>(
            `SELECT
               posizione, oratore_nome, gruppo, anchor, testo,
               mandato_id.id_persona AS oratore_id_persona,
               mandato_id.chamber AS oratore_chamber,
               '' AS snippet,
               0 AS score,
               seduta_id.chamber AS chamber,
               seduta_id.legislatura AS legislatura,
               seduta_id.numero AS numero,
               seduta_id.data AS data,
               seduta_id.organo AS organo,
               seduta_id.tipo_resoconto AS tipo_resoconto,
               seduta_id.organo_nome AS organo_nome,
               seduta_id.organo_slug AS organo_slug,
               type::string(seduta_id) AS seduta_id,
               odg_id.titolo AS odg_titolo
             FROM parlamento_interventi
             WHERE ${subWhere.join(' AND ')}
             ORDER BY data DESC
             START $offset LIMIT $limitPlusOne;`,
            { ...bindings, offset, limitPlusOne },
          )) ?? []
        )
      }

      if (!cita && meiliEnabled()) {
        // q-only -> Meilisearch: ranked, typo-tolerant, with a cropped +
        // highlighted snippet around the match. Falls back to the substring
        // scan if the engine is down or mid-rebuild so the user still gets hits.
        try {
          const filter: string[] = []
          if (chamberFilter) filter.push(`chamber = ${JSON.stringify(chamberFilter)}`)
          if (commissione) {
            filter.push(`organo_slug = ${JSON.stringify(commissione)}`)
          } else if (organo === ORGANO_ASSEMBLEA) {
            // Documents indexed before committee support existed carry no
            // `organo` field at all, and Meilisearch treats a missing field as
            // non-matching -- so an exact `organo = "assemblea"` filter scores
            // zero against an index that has not been rebuilt yet. Every one of
            // those legacy documents IS a plenary intervention (committee data
            // did not exist when they were written), so treating "absent" as
            // "assemblea" is exact, not a guess. It also means search keeps
            // working in the window between deploying this and re-running
            // scripts/meili-sync.ts, and converges automatically as sedute are
            // re-synced.
            filter.push(`(organo = "assemblea" OR organo NOT EXISTS)`)
          } else if (organo) {
            filter.push(`organo = ${JSON.stringify(organo)}`)
          }
          const result = await searchInterventi<MeiliInterventoHit>({
            q,
            filter: filter.length ? filter.join(' AND ') : undefined,
            offset,
            limit: limitPlusOne,
            attributesToCrop: ['testo'],
            cropLength: 40,
            attributesToHighlight: ['testo'],
            highlightPreTag: '<mark>',
            highlightPostTag: '</mark>',
            showRankingScore: true,
          })
          rows = result.hits.map(meiliHitToSearchHit)
          mode = 'meili'
        } catch (err) {
          if (!(err instanceof MeiliError)) throw err
          console.warn(
            '[parlamento:search] Meilisearch unavailable, falling back to substring:',
            err.message,
          )
          mode = 'substring'
          rows = await runSubstring()
        }
      } else {
        // q+cita, or Meili disabled.
        mode = 'substring'
        rows = await runSubstring()
      }
    }

    const hasMore = rows.length > pageSize
    if (hasMore) rows = rows.slice(0, pageSize)
    // Backwards-compatible total: page-aware lower bound. Lets the existing
    // UI render "20+ results" (when has_more) or the exact count (last page).
    const total = (page - 1) * pageSize + rows.length + (hasMore ? 1 : 0)

    res.json({
      data: rows,
      page,
      pageSize,
      total,
      has_more: hasMore,
      q,
      mode,
    })
  } catch (err) {
    next(err)
  }
})

// ---- /refs/leggi-piu-citate --------------------------------------------------
//
// Aggregate leaderboard of the most-cited references across the
// parlamento_riferimenti table. Returns up to 50 rows ordered by
// citation count desc.
//
// v1 has no chamber/from/to filters because all current refs come
// from Camera (Senato transcripts are waf_blocked, see
// project-kb/Parlamento ref linking.md). When Senato content lands,
// adding chamber/date filters becomes a single WHERE clause on the
// denormalised seduta link.
//
// SurrealDB's GROUP BY ORDER BY can be flaky (the Appalti route had
// to re-sort in JS for the same reason), so we fetch every group and
// re-sort in app code. CRITICAL: we cannot push a SQL LIMIT here --
// without an ORDER BY, LIMIT returns an arbitrary slice of groups and
// the JS-side top-N would not be the corpus top-N.
//
// Cardinality bound: even with full Camera + Senato corpora, the
// number of distinct (tipo, anno, numero) cited is in the low
// thousands (each Italian legislature produces ~1000 leggi/decreti
// total; only a fraction get cited). One unindexed scan + GROUP is
// well within the 50ms budget the reader page expects.
interface RefAggregateRow {
  tipo: string
  anno: number | null
  numero: string | null
  n: number
}

router.get('/refs/leggi-piu-citate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const legFilter = parseLegParam(req.query.leg)
    const chamberFilter = parseChamber(req.query.chamber)

    let whereExtra = ''
    const bindParams: Record<string, unknown> = {}
    if (legFilter !== null) {
      // Denormalised column, not `seduta.legislatura` (record-link traversal =
      // full scan of ~165k rows). Mirrors the denormalised `chamber` below.
      whereExtra += ' AND legislatura = $leg'
      bindParams['leg'] = legFilter
    }
    if (chamberFilter) {
      whereExtra += ' AND chamber = $chamber'
      bindParams['chamber'] = chamberFilter
    }

    const rows = await runQuery<RefAggregateRow[]>(
      `SELECT tipo, anno, numero, count() AS n
       FROM parlamento_riferimenti
       WHERE tipo != "costituzione" AND numero IS NOT NONE${whereExtra}
       GROUP BY tipo, anno, numero;`,
      Object.keys(bindParams).length ? bindParams : undefined,
    )
    const sorted = (rows ?? [])
      .filter((r) => r.numero !== null && r.numero !== undefined)
      .sort((a, b) => b.n - a.n)
      .slice(0, 50)
    res.json({ data: sorted, source: 'dati.camera.it + parser v1' })
  } catch (err) {
    next(err)
  }
})

// ---- /refs/legge/:tipo/:anno/:numero -----------------------------------------
//
// Per-law detail: all transcript citations of a specific law/decree, paginated
// newest first. Returns the law key, total citation count, and one row per
// citing intervento (speaker, seduta, anchor for deep-linking).
//
// URL params:
//   :tipo   - legge | decreto.legge | decreto.legislativo | dpr | ac | as
//   :anno   - 4-digit year (omitted for timeless refs -- use 0)
//   :numero - law number (may contain letters, e.g. "131-bis")
//
// Query params:
//   page, pageSize - pagination (default 1, 20)
//   chamber        - filter by chamber
//   leg            - filter by legislatura

interface LawCitationRow {
  chamber: string
  legislatura: number
  numero_seduta: number
  data: string
  oratore_nome: string | null
  oratore_id_persona: number | null
  oratore_chamber: string | null
  gruppo: string | null
  ruolo: string | null
  anchor: string | null
}

router.get(
  '/refs/legge/:tipo/:anno/:numero',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tipo = String(req.params.tipo)
      const numero = String(req.params.numero)
      // anno is part of the path, with 0 as the sentinel for a timeless ref
      // ("legge n. 241" with no year). Anything else non-numeric is a client
      // error: previously Number('abc') produced NaN, which was bound into
      // the query, matched nothing, and came back as a 200 with anno:null --
      // indistinguishable from a real timeless law that happens to have no
      // citations.
      const annoRaw = parseIntParam(req.params.anno, 'anno', { min: 0, max: 2999 })
      if (annoRaw === null) return res.status(400).json({ error: 'invalid anno' })
      const anno = annoRaw === 0 ? null : annoRaw
      const page = clampInt(req.query.page, 1, 1, 1000)
      const pageSize = clampInt(req.query.pageSize, 20, 1, 100)
      const offset = (page - 1) * pageSize
      const legFilter = parseLegParam(req.query.leg)
      const chamberFilter = parseChamber(req.query.chamber)

      let whereExtra = ''
      const bindParams: Record<string, unknown> = { tipo, anno, numero }
      if (legFilter !== null) {
        // Denormalised column, not the `seduta.legislatura` traversal.
        whereExtra += ' AND legislatura = $legFilter'
        bindParams['legFilter'] = legFilter
      }
      if (chamberFilter) {
        whereExtra += ' AND chamber = $chamberFilter'
        bindParams['chamberFilter'] = chamberFilter
      }

      const annoWhere = anno === null ? 'anno IS NONE' : 'anno = $anno'

      const [countRows, rows] = await Promise.all([
        runQuery<Array<{ n: number }>>(
          `SELECT count() AS n FROM parlamento_riferimenti
           WHERE tipo = $tipo AND ${annoWhere} AND numero = $numero${whereExtra}
           GROUP ALL;`,
          bindParams,
        ),
        runQuery<LawCitationRow[]>(
          `SELECT
             seduta.chamber AS chamber,
             seduta.legislatura AS legislatura,
             seduta.numero AS numero_seduta,
             seduta.data AS data,
             intervento.oratore_nome AS oratore_nome,
             intervento.mandato_id.id_persona AS oratore_id_persona,
             intervento.mandato_id.chamber AS oratore_chamber,
             intervento.gruppo AS gruppo,
             intervento.ruolo AS ruolo,
             intervento.anchor AS anchor
           FROM parlamento_riferimenti
           WHERE tipo = $tipo AND ${annoWhere} AND numero = $numero${whereExtra}
           ORDER BY seduta.data DESC
           LIMIT $pageSize START $offset;`,
          { ...bindParams, pageSize, offset },
        ),
      ])

      const total = countRows?.[0]?.n ?? 0
      res.json({
        tipo,
        anno,
        numero,
        total,
        page,
        pageSize,
        has_more: offset + (rows?.length ?? 0) < total,
        data: rows ?? [],
      })
    } catch (err) {
      next(err)
    }
  },
)

// ---- /legislature/:n ---------------------------------------------------------
//
// Overview of a single legislature: date range, session counts per chamber,
// top speakers by interventi count, top cited laws.

interface LegislatureStats {
  data_inizio: string | null
  data_fine: string | null
  n: number
}

interface LegislatureTopSpeaker {
  id_persona: number
  chamber: string
  nome: string | null
  gruppo_attuale: string | null
  interventi_n: number
}

interface LegislatureTopLaw {
  tipo: string
  anno: number | null
  numero: string | null
  n: number
}

router.get('/legislature/:n', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leg = Number(req.params.n)
    if (!Number.isFinite(leg) || leg <= 0) {
      return res.status(400).json({ error: 'invalid legislatura' })
    }

    const [statsCamera, statsSenato, topSpeakers, topLawsRaw] = await Promise.all([
      runQuery<LegislatureStats[]>(
        // time::min / time::max, NOT math::*. Surreal's math aggregates are
        // numeric only: applied to a datetime they return nothing at all --
        // the key is absent from the result row, with no error. That is why
        // this endpoint used to answer `{"n":705}` with no date range, and the
        // legislature header rendered an empty period.
        `SELECT
           time::min(data) AS data_inizio,
           time::max(data) AS data_fine,
           count() AS n
         FROM parlamento_sedute
         WHERE organo = "assemblea" AND legislatura = $leg AND chamber = "camera"
         GROUP ALL;`,
        { leg },
      ),
      runQuery<LegislatureStats[]>(
        `SELECT
           time::min(data) AS data_inizio,
           time::max(data) AS data_fine,
           count() AS n
         FROM parlamento_sedute
         WHERE organo = "assemblea" AND legislatura = $leg AND chamber = "senato"
         GROUP ALL;`,
        { leg },
      ),
      runQuery<LegislatureTopSpeaker[]>(
        `SELECT id_persona, chamber, nome, gruppo_attuale, interventi_n
         FROM parlamento_mandato
         WHERE legislatura = $leg AND interventi_n IS NOT NONE AND interventi_n > 0
         ORDER BY interventi_n DESC
         LIMIT 15;`,
        { leg },
      ),
      runQuery<LegislatureTopLaw[]>(
        // Use the DENORMALISED `legislatura` column, never `seduta.legislatura`.
        // The latter is a record-link traversal that dereferences the seduta
        // link for every one of the ~165k riferimenti rows (full scan, no
        // index) -- seconds per call, and minutes under disk contention. The
        // denormalised column (fully populated) is a plain scan and is covered
        // by idx_ref_as_lookup. See the schema comment + parlamento_perf memory.
        `SELECT tipo, anno, numero, count() AS n
         FROM parlamento_riferimenti
         WHERE legislatura = $leg
           AND tipo != "costituzione"
           AND numero IS NOT NONE
         GROUP BY tipo, anno, numero;`,
        { leg },
      ),
    ])

    const topLaws = (topLawsRaw ?? [])
      .filter((r) => r.numero != null)
      .sort((a, b) => b.n - a.n)
      .slice(0, 10)

    res.json({
      legislatura: leg,
      camera: statsCamera?.[0] ?? { data_inizio: null, data_fine: null, n: 0 },
      senato: statsSenato?.[0] ?? { data_inizio: null, data_fine: null, n: 0 },
      top_speakers: topSpeakers ?? [],
      top_laws: topLaws,
    })
  } catch (err) {
    next(err)
  }
})

// ---- /persona/search ---------------------------------------------------------
//
// Speaker name autocomplete. Searches parlamento_persona by name (case-insensitive
// substring). Returns up to `limit` results with their mandati summary so the
// dropdown can show which legislatures each person served in.

interface PersonaSearchRow {
  id: string
  nome: string
  chamber: string
  id_persona: number
}

interface MandatoSearchRow {
  persona_id: string
  legislatura: number
  gruppo_attuale: string | null
  interventi_n: number | null
}

router.get('/persona/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = parseStringParam(req.query.q)
    if (q.length < 2) return res.json({ data: [] })
    const limit = clampInt(req.query.limit, 12, 1, 30)

    const personas = await runQuery<PersonaSearchRow[]>(
      `SELECT id, nome, chamber, id_persona
       FROM parlamento_persona
       WHERE string::lowercase(nome) CONTAINS string::lowercase($q)
       ORDER BY nome
       LIMIT $limit;`,
      { q, limit },
    )
    if (!personas?.length) return res.json({ data: [] })

    // Batch-fetch mandati for all matched personas in one query.
    const ids = personas.map((p) => p.id)
    const mandati = await runQuery<MandatoSearchRow[]>(
      `SELECT persona_id, legislatura, gruppo_attuale, interventi_n
       FROM parlamento_mandato
       WHERE persona_id IN $ids
       ORDER BY legislatura DESC;`,
      { ids },
    )

    const byPersona = new Map<string, MandatoSearchRow[]>()
    for (const m of mandati ?? []) {
      const key = String(m.persona_id)
      if (!byPersona.has(key)) byPersona.set(key, [])
      byPersona.get(key)!.push(m)
    }

    const data = personas.map((p) => {
      const ms = byPersona.get(String(p.id)) ?? []
      const legs = ms.map((m) => m.legislatura).sort((a, b) => b - a)
      const interventi_n = ms.reduce((sum, m) => sum + (m.interventi_n ?? 0), 0)
      const ultimo_gruppo = ms[0]?.gruppo_attuale ?? null
      return { nome: p.nome, chamber: p.chamber, id_persona: p.id_persona, legs, ultimo_gruppo, interventi_n }
    })

    res.json({ data })
  } catch (err) {
    next(err)
  }
})

// ---- /persona/:chamber/:idPersona --------------------------------------------
//
// Returns the speaker's full career: the persona row plus every mandato (one
// per legislature served) plus a paginated, optionally-filtered list of their
// interventi.
//
// Query params:
//   leg=N           : restrict the interventi list to a single legislature
//                     (the persona/mandati blocks always cover all legs)
//   q=...           : BM25 search over the speaker's testo
//   from,to=YYYY-MM-DD : seduta-date bounds
//   page,pageSize   : pagination over the interventi list
//
// The combined endpoint exists so the persona page makes one round-trip
// instead of three. If a future UI needs lighter responses, splitting it is
// trivial -- the persona+mandati and interventi queries are independent.

interface InterventoListRow {
  chamber: string
  legislatura: number
  numero: number
  data: string
  anchor: string
  testo: string
  snippet?: string
  score?: number
  odg_titolo: string | null
}

interface PersonaQuery {
  chamber: Chamber
  idPersona: number
  q: string
  from: string
  to: string
  legFilter: number | null
  page: number
  pageSize: number
}

async function loadPersonaAndMandati(
  chamber: Chamber,
  idPersona: number,
): Promise<{
  persona: Record<string, unknown>
  mandati: Array<Record<string, unknown>>
} | null> {
  const personas = await runQuery<Array<Record<string, unknown>>>(
    `SELECT chamber, id_persona, nome, data_nascita, comune_nascita
     FROM parlamento_persona
     WHERE chamber = $chamber AND id_persona = $id LIMIT 1;`,
    { chamber, id: idPersona },
  )
  const persona = personas?.[0]
  if (!persona) return null
  // Project mandati ordered most-recent leg first -- that's the order the UI
  // wants on the persona card.
  const mandati = await runQuery<Array<Record<string, unknown>>>(
    `SELECT
       legislatura, nome, gruppo_attuale, gruppo_storico,
       circoscrizione, collegio, lista_elezione, data_proclamazione,
       formazione, uffici, organi, ruolo, interventi_n,
       source_url, scrape_status, fetched_at
     FROM parlamento_mandato
     WHERE chamber = $chamber AND id_persona = $id
     ORDER BY legislatura DESC;`,
    { chamber, id: idPersona },
  )
  // Historical legislatures don't populate the array-valued columns, so
  // SurrealDB returns them as missing rather than []. Normalize here so the
  // API honors the Mandato contract (gruppo_storico/uffici/organi are always
  // arrays) and the client never has to guard against undefined.
  const normalizedMandati = (mandati ?? []).map((m) => ({
    ...m,
    gruppo_storico: Array.isArray(m.gruppo_storico) ? m.gruppo_storico : [],
    uffici: Array.isArray(m.uffici) ? m.uffici : [],
    organi: Array.isArray(m.organi) ? m.organi : [],
  }))
  return { persona, mandati: normalizedMandati }
}

async function loadInterventiForPersona(
  q: PersonaQuery,
): Promise<{
  interventi: InterventoListRow[]
  total: number
  has_more: boolean
  searchError: string | null
}> {
  // Resolve the persona's mandato ids first (cheap: uses the unique
  // idx_mandato_chamber_leg_id index) and bind them with IN. Per the
  // parlamento_perf memory, `WHERE mandato_id.chamber = $c AND
  // mandato_id.id_persona = $id` is a record-link traversal that forces
  // a full scan of parlamento_interventi (~112k rows) even with the
  // mandato index in place. Resolving to a small id list keeps the read
  // path on idx_int_mandato.
  const mandatoWhere: string[] = ['chamber = $chamber', 'id_persona = $id']
  const mandatoBind: Record<string, unknown> = { chamber: q.chamber, id: q.idPersona }
  if (q.legFilter != null) {
    mandatoWhere.push('legislatura = $leg')
    mandatoBind.leg = q.legFilter
  }
  const mandatoIdRows = await runQuery<Array<{ id: unknown }>>(
    `SELECT id FROM parlamento_mandato WHERE ${mandatoWhere.join(' AND ')};`,
    mandatoBind,
  )
  const mandatoIds = (mandatoIdRows ?? []).map((r) => r.id).filter(Boolean)
  if (mandatoIds.length === 0) {
    return { interventi: [], total: 0, has_more: false, searchError: null }
  }

  const isSearch = q.q.length >= 2

  // Predicates common to both the plain listing and the substring search.
  // The search term itself is added per-query rather than here: SurrealDB's
  // BM25 operator (`testo @0@ $q`) was retired with the idx_int_text index
  // (see lib/meilisearch.ts), so the only in-database text predicate left is
  // the CONTAINS fallback that runSubstringSearch builds.
  const where: string[] = ['mandato_id IN $mandato_ids']
  const bindings: Record<string, unknown> = { mandato_ids: mandatoIds }
  if (isSearch) bindings.q = q.q

  // Date filters: SurrealDB record-link traversal in WHERE comparisons is
  // unreliable (returns 0 rows). Pre-resolve seduta ids by date and bind
  // them with an IN check.
  const sedutaWhere: string[] = []
  if (q.from) {
    const d = new Date(`${q.from}T00:00:00Z`)
    if (!Number.isNaN(d.getTime())) { sedutaWhere.push('data >= $sed_from'); bindings.sed_from = d }
  }
  if (q.to) {
    const d = new Date(`${q.to}T23:59:59Z`)
    if (!Number.isNaN(d.getTime())) { sedutaWhere.push('data <= $sed_to'); bindings.sed_to = d }
  }
  if (sedutaWhere.length > 0) {
    where.push(`seduta_id IN (SELECT VALUE id FROM parlamento_sedute WHERE ${sedutaWhere.join(' AND ')})`)
  }

  const offset = (q.page - 1) * q.pageSize
  // Fetch one extra row to detect "more results past this page" without
  // paying for a count(). Meili's own path reports a lower-bound total the
  // same way; the SurrealDB paths here are cheap enough to count exactly.
  const limitPlusOne = q.pageSize + 1

  /**
   * Run the interventi listing for a given set of predicates. `total` is an
   * exact count -- both callers are plain indexed/scan queries, not the
   * retired BM25 path whose posting-list count the parlamento_perf memory
   * warns against.
   */
  const runOnce = async (predicates: string[]) => {
    const whereClause = `WHERE ${predicates.join(' AND ')}`
    const rows = await runQuery<InterventoListRow[]>(
      `SELECT
         seduta_id.chamber AS chamber,
         seduta_id.legislatura AS legislatura,
         seduta_id.numero AS numero,
         seduta_id.data AS data,
         anchor, testo,
         '' AS snippet, 0 AS score,
         odg_id.titolo AS odg_titolo
       FROM parlamento_interventi
       ${whereClause}
       ORDER BY data DESC
       START $offset LIMIT $limitPlusOne;`,
      { ...bindings, offset, limitPlusOne },
    )
    const fetched = rows ?? []
    const hasMore = fetched.length > q.pageSize
    const page = hasMore ? fetched.slice(0, q.pageSize) : fetched
    const totalRows = await runQuery<Array<{ n: number }>>(
      `SELECT count() AS n FROM parlamento_interventi ${whereClause} GROUP ALL;`,
      bindings,
    )
    return { rows: page, total: totalRows?.[0]?.n ?? 0, hasMore }
  }

  // Substring scan over this speaker's interventi: the fallback when Meili is
  // unavailable. Reuses the resolved mandato-id predicates plus CONTAINS.
  const runSubstringSearch = () =>
    runOnce([...where, 'string::lowercase(testo) CONTAINS string::lowercase($q)'])

  // Text search -> Meilisearch, filtered to this speaker (oratore_id_persona),
  // chamber, and any leg/date narrowing. Ranked, with a cropped + highlighted
  // snippet. Falls back to the substring scan if the engine is unreachable.
  if (isSearch && meiliEnabled()) {
    try {
      const filter: string[] = [
        `oratore_id_persona = ${q.idPersona}`,
        `chamber = ${JSON.stringify(q.chamber)}`,
      ]
      if (q.legFilter != null) filter.push(`legislatura = ${q.legFilter}`)
      if (q.from) {
        const fromEpoch = Math.floor(new Date(`${q.from}T00:00:00Z`).getTime() / 1000)
        if (!Number.isNaN(fromEpoch)) filter.push(`seduta_data >= ${fromEpoch}`)
      }
      if (q.to) {
        const toEpoch = Math.floor(new Date(`${q.to}T23:59:59Z`).getTime() / 1000)
        if (!Number.isNaN(toEpoch)) filter.push(`seduta_data <= ${toEpoch}`)
      }
      const result = await searchInterventi<MeiliInterventoHit>({
        q: q.q,
        filter: filter.join(' AND '),
        offset,
        limit: limitPlusOne,
        attributesToCrop: ['testo'],
        cropLength: 40,
        attributesToHighlight: ['testo'],
        highlightPreTag: '<mark>',
        highlightPostTag: '</mark>',
        showRankingScore: true,
      })
      const fetched: InterventoListRow[] = result.hits.map((h) => {
        const hit = meiliHitToSearchHit(h)
        return {
          chamber: hit.chamber,
          legislatura: hit.legislatura,
          numero: hit.numero,
          data: hit.data,
          anchor: hit.anchor,
          testo: hit.testo,
          snippet: hit.snippet,
          score: hit.score,
          odg_titolo: hit.odg_titolo,
        }
      })
      const hasMore = fetched.length > q.pageSize
      const page = hasMore ? fetched.slice(0, q.pageSize) : fetched
      const total = (q.page - 1) * q.pageSize + page.length + (hasMore ? 1 : 0)
      return { interventi: page, total, has_more: hasMore, searchError: null }
    } catch (err) {
      if (!(err instanceof MeiliError)) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[persona/${q.chamber}/${q.idPersona}] meili search error (q="${q.q}"):`, msg)
        return { interventi: [], total: 0, has_more: false, searchError: msg }
      }
      console.warn(
        `[persona/${q.chamber}/${q.idPersona}] Meilisearch unavailable, falling back to substring:`,
        err.message,
      )
      // fall through to substring below
    }
  }

  try {
    const { rows, total, hasMore } = isSearch
      ? await runSubstringSearch()
      : await runOnce(where)
    return { interventi: rows, total, has_more: hasMore, searchError: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[persona/${q.chamber}/${q.idPersona}] interventi query failed (q="${q.q}"):`,
      msg,
    )
    return { interventi: [], total: 0, has_more: false, searchError: msg }
  }
}

router.get('/persona/:chamber/:idPersona', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const chamber = parseChamber(req.params.chamber)
    if (!chamber) return res.status(400).json({ error: 'invalid chamber' })
    const idPersona = Number(req.params.idPersona)
    if (!Number.isInteger(idPersona) || idPersona <= 0) {
      return res.status(400).json({ error: 'invalid id_persona' })
    }

    const card = await loadPersonaAndMandati(chamber, idPersona)
    if (!card) return res.status(404).json({ error: 'persona not found' })

    const q = parseStringParam(req.query.q)
    const from = typeof req.query.from === 'string' ? req.query.from : ''
    const to = typeof req.query.to === 'string' ? req.query.to : ''
    const legFilter = parseLegParam(req.query.leg)
    const page = clampInt(req.query.page, 1, 1, 9999)
    const pageSize = clampInt(req.query.pageSize, 30, 1, 100)

    const { interventi, total, has_more, searchError } = await loadInterventiForPersona({
      chamber,
      idPersona,
      q,
      from,
      to,
      legFilter,
      page,
      pageSize,
    })

    res.json({
      persona: card.persona,
      mandati: card.mandati,
      interventi,
      page,
      pageSize,
      total,
      has_more,
      q,
      leg: legFilter,
      search_error: searchError,
      source: SOURCE_URL,
    })
  } catch (err) {
    next(err)
  }
})

// ---- /transfughi ------------------------------------------------------------
//
// Parlamentari who changed group mid-legislature (mid-term party switches).
// Only meaningful for Camera leg 19+ where gruppo_storico is fully populated
// by the profile scraper. Returns rows where the group history has more than
// one entry, newest-leg first.
//
// Query params:
//   leg     - legislatura (default 19)
//   chamber - 'camera' (default; Senato has no scraped group history)

interface TransfugaRow {
  id_persona: number
  chamber: string
  legislatura: number
  nome: string | null
  gruppo_attuale: string | null
  gruppo_storico: Array<{ gruppo: string; dal: string | null; al: string | null }>
  interventi_n: number | null
}

router.get('/transfughi', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leg = clampInt(req.query.leg, 19, 1, 50)
    const chamber = parseChamber(req.query.chamber) ?? 'camera'

    const rows = await runQuery<TransfugaRow[]>(
      `SELECT id_persona, chamber, legislatura, nome, gruppo_attuale, gruppo_storico, interventi_n
       FROM parlamento_mandato
       WHERE legislatura = $leg
         AND chamber = $chamber
         AND gruppo_storico IS NOT NONE
         AND array::len(gruppo_storico) > 1
       ORDER BY nome;`,
      { leg, chamber },
    )

    res.json({ data: rows ?? [], legislatura: leg, chamber })
  } catch (err) {
    next(err)
  }
})

// ---- /odg/search ------------------------------------------------------------
//
// Full-text search over ordine del giorno titles. Uses case-insensitive
// substring match (no search index on parlamento_odg.titolo), so the scan
// itself is unavoidable -- but it is a scan over PLAIN COLUMNS.
//
// This handler used to filter on `seduta_id.body_status`, `seduta_id.legislatura`
// and `seduta_id.chamber` and sort by `seduta_id.data`, i.e. four record-link
// dereferences per row over 212k rows, which this file warns against in three
// other places. Measured on the live corpus, the count query alone took
// 2823ms (and the handler runs two such queries), against a comment that
// claimed "<50ms". chamber / legislatura / data are now denormalised onto
// parlamento_odg -- see the table comment in lib/schema.ts.
//
// body_status has no denormalised twin because, unlike the other three, it is
// mutable: a seduta can move pending -> ok -> partial across ingests, and a
// copy on the odg row would go stale. Instead we resolve the (tiny) set of
// non-ok sedute up front via idx_seduta_status and exclude it. On the live
// corpus that set is 5 rows out of 9,817, and only 30 of 212,939 odg rows
// belong to a non-ok seduta, so the exclusion is close to free while keeping
// the endpoint's semantics byte-identical to the traversing version.
//
// Query params:
//   q         - search string (min 2 chars)
//   leg       - filter by legislatura
//   chamber   - filter by chamber
//   page, pageSize

interface OdgSearchRow {
  titolo: string
  posizione: number
  anchor: string
  chamber: string
  legislatura: number
  numero_seduta: number
  data: string
}

router.get('/odg/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = parseStringParam(req.query.q)
    if (q.length < 2) return res.json({ data: [], total: 0, page: 1, pageSize: 20, has_more: false, q })

    const page = clampInt(req.query.page, 1, 1, 9999)
    const pageSize = clampInt(req.query.pageSize, 20, 1, 100)
    const offset = (page - 1) * pageSize
    const legFilter = parseLegParam(req.query.leg)
    const chamberFilter = parseChamber(req.query.chamber)

    // Match against the stored lowercase copy rather than lowercasing every
    // title on every query -- that recomputation was the endpoint's dominant
    // cost (see the benchmark in lib/schema.ts).
    const where: string[] = ['titolo_lower CONTAINS $q']
    const bindings: Record<string, unknown> = { q: q.toLowerCase() }

    const organo = parseOrgano(req.query.organo)
    if (organo) {
      where.push('organo = $organo')
      bindings.organo = organo
    }
    if (legFilter !== null) {
      where.push('legislatura = $leg')
      bindings.leg = legFilter
    }
    if (chamberFilter) {
      where.push('chamber = $chamber')
      bindings.chamber = chamberFilter
    }

    // Exclude odg rows whose seduta did not finish its body pass. Seeks
    // idx_seduta_status, and the resulting id list is tiny (see the note
    // above the handler), so binding it as an IN check is cheaper than any
    // per-row link dereference would be.
    // Scoped to the same organo as the search itself. Unscoped, this list
    // would also carry every committee sitting still queued for its body pass
    // -- thousands of ids on a fresh corpus -- and they would be bound into
    // the NOT IN below for no purpose, since rows from the other organo are
    // already excluded by the filter above.
    const notOk = await runQuery<Array<{ id: unknown }>>(
      organo
        ? `SELECT id FROM parlamento_sedute WHERE body_status != "ok" AND organo = $organo;`
        : `SELECT id FROM parlamento_sedute WHERE body_status != "ok";`,
      organo ? { organo } : {},
    )
    const excluded = (notOk ?? []).map((r) => r.id).filter(Boolean)
    if (excluded.length > 0) {
      where.push('seduta_id NOT IN $excluded')
      bindings.excluded = excluded
    }

    const whereSql = `WHERE ${where.join(' AND ')}`

    const [countRows, rows] = await Promise.all([
      runQuery<Array<{ n: number }>>(
        `SELECT count() AS n FROM parlamento_odg ${whereSql} GROUP ALL;`,
        bindings,
      ),
      runQuery<OdgSearchRow[]>(
        // seduta_id.numero is the one link dereference left, and it is
        // deliberate: it sits in the PROJECTION, not the WHERE or ORDER BY,
        // so it runs only for the <=100 rows that survive LIMIT rather than
        // for all 212k. Denormalising it too would buy nothing measurable and
        // cost another column plus a backfill.
        `SELECT
           titolo, posizione, anchor,
           chamber, legislatura, data,
           seduta_id.numero AS numero_seduta
         FROM parlamento_odg
         ${whereSql}
         ORDER BY data DESC
         LIMIT $pageSize START $offset;`,
        { ...bindings, pageSize, offset },
      ),
    ])

    const total = countRows?.[0]?.n ?? 0
    res.json({
      data: rows ?? [],
      total,
      page,
      pageSize,
      has_more: offset + (rows?.length ?? 0) < total,
      q,
    })
  } catch (err) {
    next(err)
  }
})

// Router-scoped error handler. The strict param parsers throw BadParamError
// for a value that was supplied but is unusable; that is a client error, so
// it becomes a 400 here instead of falling through to the app-level 500
// handler. Everything else is passed along untouched.
//
// This lives on the router (not in each handler) so every endpoint answers
// malformed input the same way -- the previous per-handler mix meant some
// routes 400'd, some silently dropped the filter and returned an unfiltered
// 200, and one bound NaN into the query and returned a misleading empty page.
router.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof BadParamError) {
    return res.status(400).json({ error: err.message })
  }
  next(err)
})

export default router
