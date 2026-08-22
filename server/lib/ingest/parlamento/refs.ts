import { Table, RecordId } from 'surrealdb'

import { getDb } from '../../db.ts'
import { runQuery } from '../../query.ts'
import { buildRifRows, stripNulls } from '../../parlamento/refs/builder.ts'
import { PARSER_VERSION } from '../../parlamento/refs/index.ts'
import type { RefContext } from '../../parlamento/refs/types.ts'
import { resolveSenatoBill } from '../../parlamento/senato-ddl-resolver.ts'

// Standalone reference-extraction pass over already-ingested sedute.
//
// This is the sibling subcommand of `parlamento` (rather than a flag
// on it), because:
// - Iteration on the regex bank does not require re-fetching XML; the
//   refs pass is self-contained over interventi already in the DB.
// - The CLI help is clearer when the two passes are visibly different
//   commands ("ingest.ts parlamento" vs "ingest.ts parlamento-refs")
//   than when one nests under flags of the other.
//
// Atomic per-seduta semantics: the wipe + re-insert + refs_status
// update happen inside a SurrealDB transaction, so a reader never
// observes a partial/zero-refs state for a seduta that previously had
// refs.
//
// AS bills are extracted with resolve_status='pending' here; the
// SPARQL resolver (--reresolve) lifts them to 'ok' or 'failed' in a
// later pass. v1 ships with the resolver as a no-op; commit 5 plugs
// it in.

interface RunRefsOpts {
  chamber: 'camera' | 'senato' | 'both'
  legislatura: number
  reparse: boolean
  reresolve: boolean
  limit?: number
}

export interface RunRefsResult {
  sedute_total: number
  sedute_processed: number
  sedute_skipped: number
  sedute_failed: number
  refs_written: number
  as_resolved: number
  as_failed: number
  durationMs: number
}

interface SedutaRow {
  id: RecordId<'parlamento_sedute'>
  chamber: 'camera' | 'senato'
  numero: number
  legislatura: number
  refs_status: string | null
  refs_parser_version: number | null
}

interface InterventoRow {
  id: RecordId<'parlamento_interventi'>
  posizione: number
  testo: string
}

async function listSedute(opts: RunRefsOpts): Promise<SedutaRow[]> {
  // Only process sedute whose body pass landed something. body_status
  // 'ok' / 'partial' both mean we have interventi rows to scan;
  // 'empty' / 'failed' / 'waf_blocked' mean there is nothing to look
  // at and re-attempting is wasted work.
  //
  // When reparse is false we additionally skip sedute already at the
  // current parser_version. The opposite of `IN` for nullables is
  // tricky in SurrealQL; we keep the predicate explicit.
  let where = `(body_status = "ok" OR body_status = "partial")
    AND legislatura = $leg`
  if (opts.chamber !== 'both') {
    where += ` AND chamber = $ch`
  }
  if (!opts.reparse) {
    where += ` AND (refs_parser_version IS NONE OR refs_parser_version < $v OR refs_status != "ok")`
  }
  const limitClause = opts.limit && opts.limit > 0 ? `LIMIT ${opts.limit}` : ''
  const rows = await runQuery<SedutaRow[]>(
    `SELECT id, chamber, numero, legislatura, refs_status, refs_parser_version
     FROM parlamento_sedute
     WHERE ${where}
     ORDER BY chamber, numero
     ${limitClause};`,
    {
      leg: opts.legislatura,
      ch: opts.chamber,
      v: PARSER_VERSION,
    },
  )
  return rows ?? []
}

async function processSeduta(seduta: SedutaRow): Promise<{ refs_written: number }> {
  const interventi = await runQuery<InterventoRow[]>(
    `SELECT id, posizione, testo
     FROM parlamento_interventi
     WHERE seduta_id = $id
     ORDER BY posizione;`,
    { id: seduta.id },
  )
  const ctx: RefContext = { chamber: seduta.chamber, legislatura: seduta.legislatura }

  const refRows: Array<Record<string, unknown>> = []
  for (const it of interventi ?? []) {
    const rows = buildRifRows(
      it,
      {
        id: seduta.id,
        chamber: seduta.chamber,
        numero: seduta.numero,
        legislatura: seduta.legislatura,
      },
      ctx,
    )
    for (const r of rows) refRows.push(stripNulls(r))
  }

  const db = await getDb()

  // Per-seduta replace strategy:
  //
  // The empty case (no refs to write) is genuinely transactional via
  // BEGIN/COMMIT: DELETE + UPDATE both run inside the script.
  //
  // The non-empty case can NOT be wrapped in BEGIN/COMMIT because
  // db.insert() uses its own RPC and would not join the script-level
  // transaction. The deterministic-id design (parlamento_riferimenti:
  // <prefix>-<numero>-<pos>-<version>-<start>) closes most of the
  // window: rerunning the parser at the same parser_version produces
  // the same row ids, so a true UPSERT is possible without a wipe.
  //
  // We therefore SKIP the DELETE entirely when the parser version is
  // unchanged AND the row set is non-empty, relying on the
  // deterministic ids to overwrite in place. Stale rows from a
  // previous run with FEWER refs survive only at offsets the new run
  // didn't touch -- a corner case worth a single sweeping DELETE on
  // version bumps. When parser_version changes we wipe-then-insert
  // so the old version's ids cannot leak into the new row set.
  const refsTable = new Table('parlamento_riferimenti')
  if (refRows.length === 0) {
    await db.query(
      `BEGIN TRANSACTION;
       DELETE parlamento_riferimenti WHERE seduta = $sed;
       UPDATE $sed SET refs_status = "ok", refs_parser_version = $v;
       COMMIT TRANSACTION;`,
      { sed: seduta.id, v: PARSER_VERSION },
    )
    return { refs_written: 0 }
  }

  const versionChanged =
    seduta.refs_parser_version !== PARSER_VERSION
  if (versionChanged) {
    // Old-version rows would otherwise leak: their ids carry the
    // previous parser_version segment so the new INSERTs cannot
    // overwrite them by id collision. Wipe before insert.
    await db.query(`DELETE parlamento_riferimenti WHERE seduta = $sed;`, { sed: seduta.id })
  }

  try {
    await db.insert<Record<string, unknown>>(refsTable, refRows)
  } catch (err) {
    // Per-row fallback so a single bad row does not lose the rest.
    let inserted = 0
    let failed = 0
    for (const row of refRows) {
      try {
        await db.insert<Record<string, unknown>>(refsTable, row)
        inserted += 1
      } catch (perRowErr) {
        failed += 1
        console.warn(
          `[refs] camera/${seduta.numero} row skipped:`,
          perRowErr instanceof Error ? perRowErr.message : perRowErr,
        )
      }
    }
    if (inserted === 0) {
      throw err
    }
    console.warn(
      `[refs] ${seduta.chamber}/${seduta.numero} batch insert fell back to per-row: ${inserted} ok, ${failed} skipped`,
    )
  }

  // When parser_version is unchanged the deterministic ids handle
  // additions/changes in place but cannot evict rows the new pass
  // didn't emit (e.g. the regex got narrower, fewer matches found).
  // Sweep them now: any row at this seduta whose start offset is not
  // in the freshly-written set is stale.
  if (!versionChanged) {
    const freshIds = refRows.map((r) => (r as { id: unknown }).id)
    await runQuery(
      `DELETE parlamento_riferimenti
       WHERE seduta = $sed AND id NOT IN $keep;`,
      { sed: seduta.id, keep: freshIds },
    )
  }

  await runQuery(
    `UPDATE $sed SET refs_status = "ok", refs_parser_version = $v;`,
    { sed: seduta.id, v: PARSER_VERSION },
  )

  return { refs_written: refRows.length }
}

// Phase-2 step: resolve AS bill references that landed with
// resolve_status='pending'. The lookup is per (leg, numero) tuple, not
// per ref row, so we deduplicate first to avoid hammering SPARQL with
// the same query when the same bill is cited 30 times across the
// corpus. With --reresolve we also retry rows previously marked
// 'failed'.
//
// Persistence model: when the lookup succeeds, every ref row with that
// (leg, numero) is patched in one UPDATE; when it fails, we mark them
// 'failed' so the next ordinary pass skips them and only --reresolve
// retries.
// Small inter-call sleep so a few hundred SPARQL lookups do not hit
// dati.senato.it as a tight burst. The endpoint is generous in
// practice but the only rate-limit signal we'd get back is HTTP 429,
// which fetchWithRetry handles -- this is preventative good citizenship,
// not a fix for an observed problem.
const SPARQL_INTER_CALL_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function resolvePendingAs(reresolve: boolean): Promise<{
  resolved: number
  failed: number
  unique_bills: number
}> {
  const statusFilter = reresolve
    ? `(resolve_status = "pending" OR resolve_status = "failed")`
    : `resolve_status = "pending"`
  // Uses the denormalised legislatura column (not seduta.legislatura)
  // so the GROUP/UPDATE can ride the (tipo, legislatura, numero)
  // composite index instead of forcing a record-link traversal on
  // every row -- see project memory `parlamento_perf_2026-05-04`.
  const pending = await runQuery<Array<{ legislatura: number; numero: string }>>(
    `SELECT legislatura, numero
     FROM parlamento_riferimenti
     WHERE tipo = "as" AND ${statusFilter} AND legislatura IS NOT NONE
     GROUP BY legislatura, numero;`,
  )
  const tuples = (pending ?? []).filter(
    (r): r is { legislatura: number; numero: string } =>
      r.numero !== undefined && r.legislatura !== undefined,
  )
  if (tuples.length === 0) return { resolved: 0, failed: 0, unique_bills: 0 }

  console.log(`[refs] resolving ${tuples.length} unique AS bills via dati.senato.it SPARQL`)
  let resolved = 0
  let failed = 0
  let firstCall = true
  for (const { legislatura, numero } of tuples) {
    const numeroNum = Number(numero)
    if (!Number.isFinite(numeroNum)) continue
    if (!firstCall) await sleep(SPARQL_INTER_CALL_MS)
    firstCall = false
    const result = await resolveSenatoBill(legislatura, numeroNum)
    if (result) {
      await runQuery(
        `UPDATE parlamento_riferimenti
         SET url = $url, resolve_status = "ok"
         WHERE tipo = "as" AND legislatura = $leg AND numero = $num;`,
        { url: result.url, leg: legislatura, num: numero },
      )
      resolved += 1
    } else {
      await runQuery(
        `UPDATE parlamento_riferimenti
         SET resolve_status = "failed"
         WHERE tipo = "as" AND legislatura = $leg AND numero = $num
               AND ${statusFilter};`,
        { leg: legislatura, num: numero },
      )
      failed += 1
    }
  }
  console.log(`[refs] AS resolution: ${resolved} resolved, ${failed} failed`)
  return { resolved, failed, unique_bills: tuples.length }
}

export async function runRefsPass(opts: RunRefsOpts): Promise<RunRefsResult> {
  const started = Date.now()
  const sedute = await listSedute(opts)
  let processed = 0
  let failed = 0
  let refsWritten = 0
  console.log(
    `[refs] ${sedute.length} sedute pending (chamber=${opts.chamber}, leg=${opts.legislatura}, reparse=${opts.reparse}, parser=v${PARSER_VERSION})`,
  )

  for (const sed of sedute) {
    try {
      const r = await processSeduta(sed)
      refsWritten += r.refs_written
      processed += 1
      if (processed % 25 === 0) {
        console.log(
          `[refs] progress ${processed}/${sedute.length}, ${refsWritten} refs written so far`,
        )
      }
    } catch (err) {
      failed += 1
      console.warn(
        `[refs] ${sed.chamber}/${sed.numero} failed:`,
        err instanceof Error ? err.message : err,
      )
      try {
        await runQuery(
          `UPDATE $sed SET refs_status = "failed";`,
          { sed: sed.id },
        )
      } catch {
        // best effort
      }
    }
  }

  // AS resolution phase. Always runs (cheap when no pending rows
  // exist); --reresolve additionally retries failed lookups.
  let resolveSummary: { resolved: number; failed: number; unique_bills: number } = {
    resolved: 0,
    failed: 0,
    unique_bills: 0,
  }
  try {
    resolveSummary = await resolvePendingAs(opts.reresolve)
  } catch (err) {
    console.warn(
      `[refs] AS resolution phase errored:`,
      err instanceof Error ? err.message : err,
    )
  }

  const durationMs = Date.now() - started
  console.log(
    `[refs] done in ${durationMs} ms: processed=${processed}, failed=${failed}, refs_written=${refsWritten}, as_resolved=${resolveSummary.resolved}/${resolveSummary.unique_bills}`,
  )

  return {
    sedute_total: sedute.length,
    sedute_processed: processed,
    sedute_skipped: 0, // listSedute already filtered out skipped ones
    sedute_failed: failed,
    refs_written: refsWritten,
    as_resolved: resolveSummary.resolved,
    as_failed: resolveSummary.failed,
    durationMs,
  }
}
