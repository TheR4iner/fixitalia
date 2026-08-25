import { Table, RecordId, DateTime } from 'surrealdb'

import { runQuery, withDbRetry } from '../../query.ts'
import { cleanString } from '../../parse.ts'
import {
  bumpMandatoInterventi,
  mandatoRecordId,
  upsertMandato,
  upsertPersona,
  type Chamber,
  type MandatoId,
} from './persona.ts'
import { buildRifRows, stripNulls } from '../../parlamento/refs/builder.ts'
import { PARSER_VERSION } from '../../parlamento/refs/index.ts'
import { syncSedutaToMeili } from './meiliSync.ts'

// -----------------------------------------------------------------------------
// Shared body-pass persistence for committee sittings.
//
// Camera and Senato committee transcripts arrive in completely different
// formats -- Camera publishes XHTML with CSS classes, Senato publishes Akoma
// Ntoso XML -- but once parsed they land in the database identically: OdG
// rows, intervento rows, speaker mandates, references, Meilisearch documents,
// status bookkeeping. That tail is what this module owns, so the two parsers
// can stay small and format-specific.
//
// It deliberately mirrors the sequence in cameraSession.ts (mark ingesting ->
// wipe children -> insert -> extract refs -> bump counters -> record status ->
// sync Meili) including its failure semantics, because that sequence encodes
// hard-won invariants documented in project-kb/Parlamento body-pass
// atomicity.md. The assembly ingests are NOT retrofitted onto this module:
// they are a working production path and the churn is not worth the risk
// today. See the note at the bottom of
// project-kb/Parlamento commissioni.md.
// -----------------------------------------------------------------------------

/** One agenda item within a committee sitting. */
export interface ParsedOdg {
  posizione: number
  titolo: string
  anchor: string
}

/** One speaker turn. */
export interface ParsedIntervento {
  posizione: number
  /** 1-based index into the OdG list; 0 when the turn precedes any heading. */
  odgPosition: number
  /** Display name as printed in the transcript. */
  oratoreNome: string | null
  /**
   * The chamber's own numeric person id, when the source links the speaker to
   * a parliamentarian profile. Null for the many committee speakers who are
   * NOT parliamentarians -- auditees, consultants, agency officials. Those
   * turns still carry `oratoreNome` and are fully searchable; they simply
   * cannot join to a mandato.
   */
  idPersona: string | null
  gruppo: string | null
  ruolo: string | null
  /** Body paragraphs, already plain text. Joined with a blank line. */
  paragraphs: string[]
}

export interface ParsedBody {
  odg: ParsedOdg[]
  interventi: ParsedIntervento[]
}

export interface CommissioneSedutaRow {
  id: RecordId<'parlamento_sedute'>
  chamber: Chamber
  legislatura: number
  numero: number
  data: DateTime
  /**
   * Stable, collision-free token identifying this sitting within its chamber.
   * Used to namespace the deterministic ids of child rows (OdG, references),
   * which cannot key on `numero` because committee numbering repeats across
   * committees.
   */
  idScope: string
}

export interface PersistResult {
  odg_n: number
  interventi_n: number
  refs_n: number
  status: 'ok' | 'partial' | 'empty'
}

/**
 * Resolve a speaker to a (persona, mandato) pair. Returns null when the
 * source gave no numeric id -- which for committee work is the common case,
 * not an error.
 */
async function resolveMandato(
  chamber: Chamber,
  legislatura: number,
  idPersonaRaw: string | null,
  displayName: string,
  gruppo: string | null,
): Promise<MandatoId | null> {
  if (!idPersonaRaw) return null
  const idPersona = Number(idPersonaRaw)
  if (!Number.isFinite(idPersona) || idPersona <= 0) return null
  const nome = displayName.trim() || `id-${idPersona}`
  await upsertPersona({ chamber, idPersona, nome })
  return await upsertMandato({
    chamber,
    legislatura,
    idPersona,
    nome,
    gruppo,
    ruolo: null,
  })
}

export async function persistCommissioneBody(
  seduta: CommissioneSedutaRow,
  parsed: ParsedBody,
  label: string,
): Promise<PersistResult> {
  const { chamber, legislatura } = seduta

  // Mark in-progress before any destructive write, so a crash between here
  // and the final status update leaves `body_status = "ingesting"` -- a state
  // the orchestrator's pending filter picks up as recoverable. Without it a
  // crash would leave the sitting emptied but flagged "ok".
  await runQuery(`UPDATE $id SET body_status = "ingesting", body_error = NONE;`, {
    id: seduta.id,
  })

  // Idempotent re-run: drop the previous children first. Riferimenti go too,
  // since they link to intervento rows that are about to disappear; they are
  // rebuilt at the end from the fresh interventi.
  await withDbRetry((d) =>
    d.query(
      `DELETE parlamento_odg WHERE seduta_id = $id;
       DELETE parlamento_interventi WHERE seduta_id = $id;
       DELETE parlamento_riferimenti WHERE seduta = $id;`,
      { id: seduta.id },
    ),
  )

  // ---- OdG -------------------------------------------------------------
  const odgIds = new Map<number, RecordId<'parlamento_odg'>>()
  const odgRows = parsed.odg.map((o) => {
    const id = new RecordId('parlamento_odg', `${seduta.idScope}-${o.posizione}`)
    odgIds.set(o.posizione, id)
    return {
      id,
      seduta_id: seduta.id,
      posizione: o.posizione,
      titolo: o.titolo,
      titolo_lower: o.titolo.toLowerCase(),
      anchor: o.anchor,
      chamber,
      legislatura,
      organo: 'commissione',
      data: seduta.data.toDate(),
    }
  })

  if (odgRows.length > 0) {
    try {
      await withDbRetry((d) => d.insert(new Table('parlamento_odg'), odgRows))
    } catch (err) {
      // Non-fatal: without OdG the reader loses jump-to-topic but keeps the
      // transcript. Losing the interventi too would be the real damage.
      console.warn(
        `[ingest:parlamento:commissioni] ${label} OdG insert failed (continuing without OdG):`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // ---- Speakers + interventi -------------------------------------------
  const mandatoCache = new Map<string, MandatoId | null>()
  const perMandatoCount = new Map<string, number>()
  let mandatoFailures = 0

  async function mandatoFor(
    idPersona: string | null,
    displayName: string,
    gruppo: string | null,
  ): Promise<MandatoId | null> {
    if (!idPersona) return null
    if (mandatoCache.has(idPersona)) return mandatoCache.get(idPersona) ?? null
    try {
      const id = await resolveMandato(chamber, legislatura, idPersona, displayName, gruppo)
      mandatoCache.set(idPersona, id)
      return id
    } catch (err) {
      mandatoFailures += 1
      mandatoCache.set(idPersona, null) // poison: don't retry within this sitting
      console.warn(
        `[ingest:parlamento:commissioni] ${label} mandato upsert failed for idPersona=${idPersona}:`,
        err instanceof Error ? err.message : err,
      )
      return null
    }
  }

  const rows: Array<Record<string, unknown>> = []
  let pos = 0
  for (const it of parsed.interventi) {
    const testo = it.paragraphs
      .map((p) => cleanString(p))
      .filter((p): p is string => Boolean(p))
      .join('\n\n')
    if (!testo) continue
    pos += 1
    const displayName = it.oratoreNome ?? ''
    const mandatoId = await mandatoFor(it.idPersona, displayName, it.gruppo)
    if (mandatoId && it.idPersona) {
      perMandatoCount.set(it.idPersona, (perMandatoCount.get(it.idPersona) ?? 0) + 1)
    }
    rows.push({
      seduta_id: seduta.id,
      odg_id: it.odgPosition > 0 ? odgIds.get(it.odgPosition) ?? null : null,
      posizione: pos,
      mandato_id: mandatoId,
      oratore_nome: displayName || null,
      gruppo: it.gruppo,
      ruolo: it.ruolo,
      testo,
      anchor: `int-${pos}`,
    })
  }

  let inserted = 0
  if (rows.length > 0) {
    const cleaned = rows.map((r) => stripNulls(r))
    const table = new Table('parlamento_interventi')
    const BATCH = 200
    for (let i = 0; i < cleaned.length; i += BATCH) {
      const slice = cleaned.slice(i, i + BATCH)
      try {
        await withDbRetry((d) => d.insert<Record<string, unknown>>(table, slice))
        inserted += slice.length
      } catch (err) {
        // One malformed row must not cost the other 199.
        console.warn(
          `[ingest:parlamento:commissioni] ${label} batch insert failed; per-row fallback:`,
          err instanceof Error ? err.message : err,
        )
        for (const row of slice) {
          try {
            await withDbRetry((d) => d.insert<Record<string, unknown>>(table, row))
            inserted += 1
          } catch (rowErr) {
            console.warn(
              `[ingest:parlamento:commissioni] ${label} row pos=${(row as { posizione?: number }).posizione} skipped:`,
              rowErr instanceof Error ? rowErr.message : rowErr,
            )
          }
        }
      }
    }
  }

  // ---- References -------------------------------------------------------
  let refsInserted = 0
  let refsFailures = 0
  try {
    const persisted =
      (await runQuery<
        Array<{ id: RecordId<'parlamento_interventi'>; posizione: number; testo: string }>
      >(
        `SELECT id, posizione, testo FROM parlamento_interventi
         WHERE seduta_id = $id ORDER BY posizione;`,
        { id: seduta.id },
      )) ?? []
    const refRows: Array<Record<string, unknown>> = []
    for (const it of persisted) {
      const built = buildRifRows(
        it,
        {
          id: seduta.id,
          chamber,
          numero: seduta.numero,
          legislatura,
          organo: 'commissione',
          // Committee numbering repeats across committees, so the default
          // `<prefix>-<numero>` scope would collide. See builder.ts.
          idScope: seduta.idScope,
        },
        { chamber, legislatura },
      )
      for (const r of built) refRows.push(stripNulls(r))
    }
    if (refRows.length > 0) {
      const refsTable = new Table('parlamento_riferimenti')
      const BATCH = 500
      for (let i = 0; i < refRows.length; i += BATCH) {
        const slice = refRows.slice(i, i + BATCH)
        try {
          await withDbRetry((d) => d.insert<Record<string, unknown>>(refsTable, slice))
          refsInserted += slice.length
        } catch (err) {
          console.warn(
            `[ingest:parlamento:commissioni] ${label} refs batch failed; per-row fallback:`,
            err instanceof Error ? err.message : err,
          )
          for (const row of slice) {
            try {
              await withDbRetry((d) => d.insert<Record<string, unknown>>(refsTable, row))
              refsInserted += 1
            } catch {
              refsFailures += 1
            }
          }
        }
      }
    }
  } catch (err) {
    refsFailures = -1 // sentinel: extraction itself errored
    console.warn(
      `[ingest:parlamento:commissioni] ${label} ref extraction errored:`,
      err instanceof Error ? err.message : err,
    )
  }

  // ---- Counters ---------------------------------------------------------
  for (const [idPersonaStr, n] of perMandatoCount) {
    const idPersona = Number(idPersonaStr)
    if (!Number.isFinite(idPersona)) continue
    await bumpMandatoInterventi(mandatoRecordId(chamber, legislatura, idPersona), n).catch(
      () => {},
    )
  }

  // ---- Status -----------------------------------------------------------
  const partial = inserted < rows.length || mandatoFailures > 0
  // Reported status vs stored status are deliberately different, matching the
  // convention the assembly ingest already uses.
  //
  // A document that fetched fine and parsed to nothing is an UPSTREAM empty --
  // senato.it publishes stub sommari (a heading, an empty <an:p/>, no
  // <an:speech> at all) for procedural sittings. The run summary should say
  // so, which is what the returned 'empty' is for. But body_status must NOT
  // be 'empty', because the pending filter is `body_status != "ok"`: storing
  // 'empty' would put every stub back in the queue on every single run,
  // forever, each retry costing a throttled WAF request to re-download the
  // same nothing. Genuine failures throw and are recorded as 'error'
  // elsewhere, so they are unaffected by this.
  const reported: PersistResult['status'] = inserted === 0 ? 'empty' : partial ? 'partial' : 'ok'
  const stored = partial ? 'partial' : 'ok'
  const refsStatus = refsFailures < 0 ? 'failed' : refsFailures > 0 ? 'partial' : 'ok'
  const errorNote = partial
    ? `partial: inserted ${inserted}/${rows.length} interventi, ${mandatoFailures} mandato failures`
    : inserted === 0
      ? `empty: source document carries no speeches (${parsed.odg.length} agenda items)`
      : null

  try {
    // SurrealDB's option<T> rejects a bound null, so clearing a field needs
    // the NONE literal rather than a parameter. Hence the branch.
    if (errorNote) {
      await runQuery(
        `UPDATE $id SET odg_n = $odgN, interventi_n = $intN,
           body_status = $st, body_error = $err,
           refs_status = $rst, refs_parser_version = $rv;`,
        {
          id: seduta.id,
          odgN: parsed.odg.length,
          intN: inserted,
          st: stored,
          err: errorNote,
          rst: refsStatus,
          rv: PARSER_VERSION,
        },
      )
    } else {
      await runQuery(
        `UPDATE $id SET odg_n = $odgN, interventi_n = $intN,
           body_status = $st, body_error = NONE,
           refs_status = $rst, refs_parser_version = $rv;`,
        {
          id: seduta.id,
          odgN: parsed.odg.length,
          intN: inserted,
          st: stored,
          rst: refsStatus,
          rv: PARSER_VERSION,
        },
      )
    }
  } catch (err) {
    console.warn(
      `[ingest:parlamento:commissioni] ${label} status update failed:`,
      err instanceof Error ? err.message : err,
    )
  }

  await syncSedutaToMeili(seduta.id, label)

  return {
    odg_n: parsed.odg.length,
    interventi_n: inserted,
    refs_n: refsInserted,
    status: reported,
  }
}
