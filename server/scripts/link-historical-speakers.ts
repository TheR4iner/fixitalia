// -----------------------------------------------------------------------------
// Backfill: link Camera leg 13-14 transcript speakers to a mandato_id.
//
// These legs' transcripts store the speaker as a free-text label and leave
// `mandato_id` null (see project-kb/Historical speaker mandato linking.md). This
// pass pulls each leg's roster (with idPersona) from dati.camera.it SPARQL,
// matches the label against it, and -- for confident matches -- upserts the
// persona+mandato and stamps `mandato_id` onto the interventi rows.
//
// Idempotent: only rows with a null mandato_id are linked, so re-running (e.g.
// after improving the matcher) picks up what's still unlinked and never
// double-counts. Dry-run by default; pass --apply to write.
//
// Read strategy: parlamento_interventi has no `legislatura` column and lives on
// a slow HDD, where per-seduta lookups are random I/O (~15s each). Instead we
// keyset-paginate the whole table by primary key -- a single *sequential* scan
// (~99ms/5000 rows) -- and filter to legs 13/14 in JS via a seduta-id map. See
// the timing notes in project-kb/Historical speaker mandato linking.md.
//
// Usage:
//   tsx scripts/link-historical-speakers.ts            # dry-run, legs 13 14
//   tsx scripts/link-historical-speakers.ts --apply    # write
//   tsx scripts/link-historical-speakers.ts --leg 14 --apply
// -----------------------------------------------------------------------------

import { RecordId } from 'surrealdb'

import { runQuery, withDbRetry } from '../lib/query.ts'
import { closeDb } from '../lib/db.ts'
import {
  fetchLegRosterViaSparql,
  type RosterDeputy,
} from '../lib/ingest/parlamento/cameraHistoricalDeputatoSparql.ts'
import {
  buildRosterIndex,
  matchSpeaker,
  canonicalName,
  type RosterIndex,
} from '../lib/ingest/parlamento/historicalSpeakerLink.ts'
import {
  upsertPersona,
  upsertMandato,
  bumpMandatoInterventi,
} from '../lib/ingest/parlamento/persona.ts'

const CHAMBER = 'camera' as const
// Adaptive scan paging. The interventi table lives on a slow HDD; most of it is
// warm (recent ingest) and pages return in milliseconds, but cold tail regions
// can take minutes. SurrealDB only sends response headers once a query finishes,
// so a single page slower than undici's ~5min headers timeout would kill the
// scan. We start optimistic and, on a timeout, halve the page and retry from the
// same cursor -- fast where the data is warm, self-throttling where it is cold.
// Cap the page so even a fully-cold page completes well under undici's headers
// timeout (a 10k-row cold page overran ~5min and wedged the connection). Cold
// reads on the HDD are ~tens of ms/row, so ~1.5k rows stays comfortably bounded.
const SCAN_PAGE_MAX = 1_500
const SCAN_PAGE_MIN = 200
const UPDATE_CHUNK = 500

// Derive the SurrealDB /health URL from the RPC URL the client uses.
const HEALTH_URL = (process.env.SURREALDB_URL ?? 'http://fixitalia-surrealdb:8000/rpc').replace(
  /\/rpc\/?$/,
  '/health',
)

function isTransientReadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err)
  return /HEADERS_TIMEOUT|fetch failed|transport|timeout|ECONNREFUSED|ECONNRESET|socket/i.test(msg)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// After a transport error the SDK connection may be wedged and SurrealDB may be
// momentarily busy finishing the abandoned query. Drop the client and poll
// /health until it answers, so the retry lands on a fresh, ready connection.
async function recoverConnection(): Promise<void> {
  await closeDb()
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) })
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await sleep(5_000)
  }
  console.warn('[scan] surreal still unhealthy after 10min; retrying anyway')
}

interface Args {
  legs: number[]
  apply: boolean
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply')
  const legIdx = argv.indexOf('--leg')
  const legs = legIdx >= 0 && argv[legIdx + 1] ? [Number(argv[legIdx + 1])] : [13, 14]
  return { legs, apply }
}

interface IntRow {
  id: RecordId<'parlamento_interventi'>
  oratore_nome: string | null
  seduta_id: RecordId<'parlamento_sedute'>
  mandato_id: RecordId<'parlamento_mandato'> | null
}

interface LegContext {
  index: RosterIndex
}

interface PersonaLink {
  leg: number
  dep: RosterDeputy
  intIds: RecordId<'parlamento_interventi'>[]
}

interface LegStats {
  matched: number
  roleSkipped: number
  ambiguous: number
  unmatched: number
  nullName: number
  unmatchedNames: Map<string, number>
  ambiguousNames: Map<string, number>
}

function emptyStats(): LegStats {
  return {
    matched: 0,
    roleSkipped: 0,
    ambiguous: 0,
    unmatched: 0,
    nullName: 0,
    unmatchedNames: new Map(),
    ambiguousNames: new Map(),
  }
}

async function main() {
  const { legs, apply } = parseArgs(process.argv.slice(2))
  console.log(`link-historical-speakers: legs ${legs.join(', ')} mode=${apply ? 'apply' : 'dry-run'}`)

  // 1. Map every leg-13/14 camera seduta id -> its legislatura. Small table,
  //    indexed by (chamber, legislatura): cheap even on the HDD.
  const sedutaLeg = new Map<string, number>()
  for (const leg of legs) {
    const rows = await runQuery<Array<{ id: RecordId<'parlamento_sedute'> }>>(
      `SELECT id FROM parlamento_sedute
       WHERE chamber = $ch AND legislatura = $leg AND body_status IN ["ok", "partial"];`,
      { ch: CHAMBER, leg },
    )
    for (const r of rows ?? []) sedutaLeg.set(String(r.id), leg)
    console.log(`[sedute] leg ${leg}: ${rows?.length ?? 0} sedute with a body`)
  }

  // 2. Roster index per leg, from dati.camera.it SPARQL.
  const ctxByLeg = new Map<number, LegContext>()
  for (const leg of legs) {
    const roster = await fetchLegRosterViaSparql(leg)
    console.log(`[roster] leg ${leg}: ${roster.length} deputies from dati.camera.it`)
    if (roster.length === 0) {
      console.warn(`[roster] empty roster for leg ${leg} -- its speakers will all be unmatched`)
    }
    ctxByLeg.set(leg, { index: buildRosterIndex(roster) })
  }

  // 3. Single sequential keyset scan of the whole interventi table.
  const stats = new Map<number, LegStats>(legs.map((l) => [l, emptyStats()]))
  const links = new Map<string, PersonaLink>() // key: `${leg}:${idPersona}`
  let cursor: RecordId<'parlamento_interventi'> | null = null
  let scanned = 0
  let pages = 0
  let pageSize = SCAN_PAGE_MAX
  let lastLogged = 0

  for (;;) {
    let page: IntRow[]
    try {
      const cur = cursor // captured for the closure
      const lim = pageSize
      page = await withDbRetry((d) =>
        d
          .query<[IntRow[]]>(
            cur
              ? `SELECT id, oratore_nome, seduta_id, mandato_id FROM parlamento_interventi WHERE id > $cur LIMIT $lim;`
              : `SELECT id, oratore_nome, seduta_id, mandato_id FROM parlamento_interventi LIMIT $lim;`,
            { cur, lim },
          )
          .then((r) => r[0] ?? []),
      )
    } catch (err) {
      if (isTransientReadError(err)) {
        const next = Math.max(SCAN_PAGE_MIN, Math.floor(pageSize / 2))
        console.warn(
          `[scan] transport error at ${scanned} rows; resetting connection, page ${pageSize} -> ${next}, retrying same cursor`,
        )
        pageSize = next
        await recoverConnection()
        continue
      }
      throw err
    }
    if (page.length === 0) break
    pages += 1
    scanned += page.length
    cursor = page[page.length - 1].id
    // Recover toward the fast page size once a cold patch is behind us.
    if (pageSize < SCAN_PAGE_MAX) pageSize = Math.min(SCAN_PAGE_MAX, pageSize * 2)

    for (const row of page) {
      const leg = sedutaLeg.get(String(row.seduta_id))
      if (leg === undefined) continue // not a leg we are linking
      const st = stats.get(leg)!
      if (row.mandato_id) continue // already linked
      if (!row.oratore_nome) {
        st.nullName += 1
        continue
      }
      const res = matchSpeaker(row.oratore_nome, ctxByLeg.get(leg)!.index)
      switch (res.kind) {
        case 'matched': {
          st.matched += 1
          const key = `${leg}:${res.deputy.idPersona}`
          const entry = links.get(key)
          if (entry) entry.intIds.push(row.id)
          else links.set(key, { leg, dep: res.deputy, intIds: [row.id] })
          break
        }
        case 'role':
          st.roleSkipped += 1
          break
        case 'ambiguous':
          st.ambiguous += 1
          bump(st.ambiguousNames, row.oratore_nome)
          break
        case 'unmatched':
          st.unmatched += 1
          bump(st.unmatchedNames, row.oratore_nome)
          break
      }
    }
    if (scanned - lastLogged >= 100_000) {
      lastLogged = scanned
      console.log(`[scan] ${scanned} rows scanned (page=${pageSize})...`)
    }
  }
  console.log(`[scan] done: ${scanned} interventi across ${pages} pages`)

  for (const leg of legs) reportLeg(leg, stats.get(leg)!, links)

  if (!apply) {
    console.log('\n[dry-run] no writes; pass --apply to persist')
    await closeDb()
    return
  }

  // 4. Write: upsert persona+mandato per matched deputy, stamp mandato_id on
  //    their interventi, then record the speech count on the mandato.
  let writtenDeputies = 0
  let writtenInterventi = 0
  for (const { leg, dep, intIds } of links.values()) {
    const nome = canonicalName(dep)
    await upsertPersona({ chamber: CHAMBER, idPersona: dep.idPersona, nome })
    const mandatoId = await upsertMandato({
      chamber: CHAMBER,
      legislatura: leg,
      idPersona: dep.idPersona,
      nome,
      gruppo: dep.gruppo,
      ruolo: null,
    })
    for (let i = 0; i < intIds.length; i += UPDATE_CHUNK) {
      const slice = intIds.slice(i, i + UPDATE_CHUNK)
      // Target the records directly by id. `UPDATE $ids` (array of RecordIds)
      // is a direct record update (~ms); `WHERE id IN $ids` would instead scan
      // the whole 1.46M-row table per chunk (~34s each, measured).
      await withDbRetry((d) =>
        d.query(`UPDATE $ids SET mandato_id = $m;`, { ids: slice, m: mandatoId }),
      )
    }
    await bumpMandatoInterventi(mandatoId, intIds.length)
    writtenDeputies += 1
    writtenInterventi += intIds.length
  }
  console.log(`\n[apply] linked ${writtenInterventi} interventi across ${writtenDeputies} mandati`)
  await closeDb()
}

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1)
}

function reportLeg(leg: number, st: LegStats, links: Map<string, PersonaLink>): void {
  let deputies = 0
  for (const k of links.keys()) if (k.startsWith(`${leg}:`)) deputies += 1
  const total = st.matched + st.roleSkipped + st.ambiguous + st.unmatched
  console.log(
    `\n=== leg ${leg} ===\n` +
      `[match] ${total} unlinked interventi: ${st.matched} matched (${deputies} deputies), ` +
      `${st.roleSkipped} role-only, ${st.ambiguous} ambiguous, ${st.unmatched} unmatched ` +
      `(+${st.nullName} null-name rows skipped)`,
  )
  report('top unmatched names', st.unmatchedNames)
  report('ambiguous names', st.ambiguousNames)
}

function report(label: string, counts: Map<string, number>): void {
  if (counts.size === 0) return
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  const totalShown = top.reduce((s, [, n]) => s + n, 0)
  console.log(`[${label}] ${counts.size} distinct (showing top ${top.length}, ${totalShown} rows):`)
  for (const [name, n] of top) console.log(`    ${String(n).padStart(5)}  ${name}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
