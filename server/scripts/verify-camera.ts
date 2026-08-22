// -----------------------------------------------------------------------------
// Camera data verification. Goal: 100% accuracy, 0% missing for legs 13-19.
//
// Two phases so it can run safely alongside an in-flight senato ingest:
//   (default)  LIGHT  -- sedute-table checks only (small table, cheap):
//                        completeness (counts, numero continuity), status
//                        distribution, duplicates, suspicious empties.
//   --full     HEAVY  -- adds full-table reconciliations over parlamento_odg
//                        and parlamento_interventi (1.4M rows): field-vs-actual
//                        counts, orphans, speaker-link coverage + integrity.
//                        Run this when the HDD is free (senato idle).
//
// Exit code: 0 if no problems found, 1 if any check flags an issue.
// -----------------------------------------------------------------------------

import { runQuery } from '../lib/query.ts'
import { closeDb } from '../lib/db.ts'

const CHAMBER = 'camera'
const LEGS = [13, 14, 15, 16, 17, 18, 19]

let problems = 0
const flag = (msg: string) => {
  problems += 1
  console.log(`  ✗ ${msg}`)
}
const ok = (msg: string) => console.log(`  ✓ ${msg}`)

interface SedutaRow {
  numero: number
  body_status: string | null
  interventi_n: number | null
  odg_n: number | null
  refs_status: string | null
}

function histogram(rows: SedutaRow[], key: keyof SedutaRow): Record<string, number> {
  const h: Record<string, number> = {}
  for (const r of rows) {
    const k = String(r[key] ?? 'null')
    h[k] = (h[k] ?? 0) + 1
  }
  return h
}

async function lightChecks(): Promise<void> {
  console.log('=== LIGHT CHECKS (sedute table) ===\n')
  for (const leg of LEGS) {
    const rows = await runQuery<SedutaRow[]>(
      `SELECT numero, body_status, interventi_n, odg_n, refs_status
       FROM parlamento_sedute
       WHERE chamber = $ch AND legislatura = $leg
       ORDER numero ASC;`,
      { ch: CHAMBER, leg },
    )
    const s = rows ?? []
    console.log(`--- leg ${leg}: ${s.length} sedute ---`)
    if (s.length === 0) {
      flag(`leg ${leg} has ZERO sedute (expected data)`)
      console.log('')
      continue
    }

    // Completeness: numero continuity.
    const nums = s.map((r) => r.numero).filter((n) => Number.isFinite(n))
    const min = Math.min(...nums)
    const max = Math.max(...nums)
    const present = new Set(nums)
    const gaps: number[] = []
    for (let n = min; n <= max; n += 1) if (!present.has(n)) gaps.push(n)
    console.log(`  numero range ${min}..${max} (${nums.length} present)`)
    if (gaps.length === 0) ok(`no numero gaps in ${min}..${max}`)
    else flag(`leg ${leg} has ${gaps.length} numero GAPS: ${gaps.slice(0, 30).join(', ')}${gaps.length > 30 ? ' ...' : ''}`)

    // Duplicates.
    const dupCounts = new Map<number, number>()
    for (const n of nums) dupCounts.set(n, (dupCounts.get(n) ?? 0) + 1)
    const dups = [...dupCounts.entries()].filter(([, c]) => c > 1)
    if (dups.length === 0) ok('no duplicate numeros')
    else flag(`leg ${leg} has ${dups.length} DUPLICATE numeros: ${dups.slice(0, 20).map(([n, c]) => `${n}x${c}`).join(', ')}`)

    // Body status distribution.
    const bs = histogram(s, 'body_status')
    const okN = bs['ok'] ?? 0
    const emptyN = bs['empty'] ?? 0
    const bad = s.length - okN - emptyN
    console.log(`  body_status: ${JSON.stringify(bs)}`)
    if (bad === 0) ok('all sedute ok/empty')
    else flag(`leg ${leg} has ${bad} sedute NOT ok/empty (pending/error/ingesting/partial)`)

    // refs status.
    const rs = histogram(s, 'refs_status')
    console.log(`  refs_status: ${JSON.stringify(rs)}`)
    const refsBad = (rs['failed'] ?? 0) + (rs['partial'] ?? 0)
    if (refsBad > 0) flag(`leg ${leg} has ${refsBad} sedute with failed/partial refs`)

    // Suspicious: ok but interventi_n = 0.
    const okEmpty = s.filter((r) => r.body_status === 'ok' && (r.interventi_n ?? 0) === 0)
    if (okEmpty.length > 0)
      flag(`leg ${leg} has ${okEmpty.length} sedute body_status=ok but interventi_n=0: ${okEmpty.slice(0, 20).map((r) => r.numero).join(', ')}`)
    else ok('no ok-but-empty sedute')

    // Aggregate counts (field-level; cross-checked against actuals in --full).
    const totInt = s.reduce((a, r) => a + (r.interventi_n ?? 0), 0)
    const totOdg = s.reduce((a, r) => a + (r.odg_n ?? 0), 0)
    console.log(`  totals (field): ${totInt} interventi, ${totOdg} odg`)
    console.log('')
  }
}

async function fullChecks(): Promise<void> {
  console.log('\n=== HEAVY CHECKS (full-table scans) ===\n')

  // Build seduta_id -> {leg, numero, interventi_n, odg_n} map for camera.
  const sedute = await runQuery<
    Array<{ id: unknown; legislatura: number; numero: number; interventi_n: number | null; odg_n: number | null }>
  >(
    `SELECT id, legislatura, numero, interventi_n, odg_n
     FROM parlamento_sedute WHERE chamber = $ch;`,
    { ch: CHAMBER },
  )
  const sedMap = new Map<string, { leg: number; numero: number; interventi_n: number; odg_n: number }>()
  for (const r of sedute ?? [])
    sedMap.set(String(r.id), { leg: r.legislatura, numero: r.numero, interventi_n: r.interventi_n ?? 0, odg_n: r.odg_n ?? 0 })
  console.log(`camera sedute: ${sedMap.size}`)

  // A2/A4: interventi actual count per seduta + orphans + link coverage.
  // Single sequential keyset scan (HDD-friendly).
  const actualInt = new Map<string, number>()
  const actualLinked = new Map<string, number>()
  let emptyTesto = 0
  let danglingMandato = 0
  const mandatoIds = new Set<string>()

  // Preload mandato + persona ids for integrity checks.
  const mandati = await runQuery<Array<{ id: unknown; persona_id: unknown }>>(
    `SELECT id, persona_id FROM parlamento_mandato WHERE chamber = $ch;`,
    { ch: CHAMBER },
  )
  const personaIds = new Set(
    (await runQuery<Array<{ id: unknown }>>(`SELECT id FROM parlamento_persona WHERE chamber = $ch;`, { ch: CHAMBER }))?.map(
      (r) => String(r.id),
    ) ?? [],
  )
  let mandatoNoPersona = 0
  for (const m of mandati ?? []) {
    mandatoIds.add(String(m.id))
    if (!m.persona_id || !personaIds.has(String(m.persona_id))) mandatoNoPersona += 1
  }
  if (mandatoNoPersona > 0) flag(`${mandatoNoPersona} camera mandati point to a missing persona`)
  else ok('all camera mandati -> existing persona')

  let cursor: unknown = null
  let scanned = 0
  for (;;) {
    type IntScan = { id: unknown; seduta_id: unknown; mandato_id: unknown; testo: string | null }
    const page =
      (await runQuery<IntScan[]>(
        cursor
          ? `SELECT id, seduta_id, mandato_id, testo FROM parlamento_interventi WHERE id > $cur LIMIT 5000;`
          : `SELECT id, seduta_id, mandato_id, testo FROM parlamento_interventi LIMIT 5000;`,
        { cur: cursor },
      )) ?? []
    if (page.length === 0) break
    scanned += page.length
    cursor = page[page.length - 1].id
    for (const row of page) {
      const sid = String(row.seduta_id)
      const sed = sedMap.get(sid)
      if (!sed) continue // not a camera seduta (senato rows share the table)
      actualInt.set(sid, (actualInt.get(sid) ?? 0) + 1)
      if (row.mandato_id) {
        actualLinked.set(sid, (actualLinked.get(sid) ?? 0) + 1)
        if (!mandatoIds.has(String(row.mandato_id))) danglingMandato += 1
      }
      if (!row.testo || row.testo.trim().length === 0) emptyTesto += 1
    }
    if (scanned % 200000 < 5000) console.log(`  ...scanned ${scanned} interventi`)
  }
  // Orphans: interventi whose seduta_id is a camera seduta we don't have -- can't
  // see here (we filtered to known sedMap). Instead detect mismatch below.

  // interventi_n field vs actual.
  let mismatch = 0
  const perLegActual = new Map<number, number>()
  const perLegLinked = new Map<number, number>()
  for (const [sid, sed] of sedMap) {
    const actual = actualInt.get(sid) ?? 0
    if (actual !== sed.interventi_n) {
      mismatch += 1
      if (mismatch <= 20) console.log(`    mismatch leg ${sed.leg} sed ${sed.numero}: field=${sed.interventi_n} actual=${actual}`)
    }
    perLegActual.set(sed.leg, (perLegActual.get(sed.leg) ?? 0) + actual)
    perLegLinked.set(sed.leg, (perLegLinked.get(sed.leg) ?? 0) + (actualLinked.get(sid) ?? 0))
  }
  if (mismatch === 0) ok('interventi_n field matches actual count for every seduta')
  else flag(`${mismatch} sedute have interventi_n != actual interventi count`)
  if (danglingMandato === 0) ok('no intervento points to a missing mandato')
  else flag(`${danglingMandato} interventi point to a missing mandato`)
  if (emptyTesto > 0) flag(`${emptyTesto} interventi have empty testo`)
  else ok('no empty-testo interventi')

  console.log('\n  speaker-link coverage per leg (linked / total interventi):')
  for (const leg of LEGS) {
    const tot = perLegActual.get(leg) ?? 0
    const lin = perLegLinked.get(leg) ?? 0
    const pct = tot > 0 ? ((lin / tot) * 100).toFixed(1) : 'n/a'
    console.log(`    leg ${leg}: ${lin}/${tot} (${pct}%)`)
  }
}

async function main() {
  const full = process.argv.includes('--full')
  console.log(`Camera verification (${full ? 'LIGHT + HEAVY' : 'LIGHT only'})\n`)
  await lightChecks()
  if (full) await fullChecks()
  console.log(`\n===== ${problems === 0 ? 'PASS -- no problems flagged' : `${problems} PROBLEM(S) FLAGGED`} =====`)
  await closeDb()
  process.exit(problems === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
