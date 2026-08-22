import { RecordId, Table } from 'surrealdb'

import { runQuery } from '../../query.ts'

// -----------------------------------------------------------------------------
// Persona + Mandato write helpers.
//
// All writes to parlamento_persona / parlamento_mandato go through this module
// so the composite-id convention (and the upsert semantics that depend on it)
// live in exactly one place.
//
// Composite ids:
//   parlamento_persona:[chamber, id_persona]           -- one row per real human in this chamber
//   parlamento_mandato:[chamber, leg, id_persona]      -- one row per term of office
//
// id_persona is the chamber's own numeric ID (Camera /deputati/elenco/{leg}-{id}/
// or Senato /loc/link.asp?tipodoc=sanasen&id={id}). It is stable across legs
// within one chamber.
// -----------------------------------------------------------------------------

export type Chamber = 'camera' | 'senato'

export interface PersonaInput {
  chamber: Chamber
  idPersona: number
  nome: string
  /** YYYY-MM-DD; used only for human disambiguation, not joined on. */
  dataNascita?: string | null
  comuneNascita?: string | null
}

export interface MandatoInput {
  chamber: Chamber
  legislatura: number
  idPersona: number
  nome: string | null
  gruppo: string | null
  ruolo: string | null
}

export type PersonaId = RecordId<'parlamento_persona'>
export type MandatoId = RecordId<'parlamento_mandato'>

/**
 * Composite record id for a persona. Deterministic, so the same human always
 * lands on the same row no matter how many sedute have referenced them.
 */
export function personaRecordId(chamber: Chamber, idPersona: number): PersonaId {
  return new RecordId('parlamento_persona', [chamber, idPersona])
}

/**
 * Composite record id for a mandato. Deterministic per (chamber, leg, person):
 * upserting the same person across an ingest run is idempotent.
 */
export function mandatoRecordId(
  chamber: Chamber,
  legislatura: number,
  idPersona: number,
): MandatoId {
  return new RecordId('parlamento_mandato', [chamber, legislatura, idPersona])
}

/**
 * UPSERT a persona row. Returns its record id.
 *
 * Always overwrites `nome` so the most recent transcript / profile spelling
 * wins (the official site occasionally rewrites case or accents). Optional
 * disambiguation fields are only set when provided -- never blanked.
 */
export async function upsertPersona(input: PersonaInput): Promise<PersonaId> {
  const id = personaRecordId(input.chamber, input.idPersona)
  const set: Record<string, unknown> = {
    chamber: input.chamber,
    id_persona: input.idPersona,
    nome: input.nome,
  }
  if (input.dataNascita) set.data_nascita = input.dataNascita
  if (input.comuneNascita) set.comune_nascita = input.comuneNascita
  await runQuery(`UPSERT $id MERGE $patch;`, { id, patch: set })
  return id
}

/**
 * UPSERT a mandato row. Returns its record id.
 *
 * The `nome / gruppo_attuale / ruolo` fields can be filled either from
 * transcripts (lightweight: speaker label) or from the deputati profile
 * scraper (rich: includes circoscrizione, organi, etc.). This helper handles
 * only the transcript-derived fields; the profile scraper has its own update
 * path that touches the rest.
 *
 * Existing values are not overwritten with NULLs: a richer profile-scraper
 * write later in the pipeline must not be clobbered by a thinner
 * transcript-pass write earlier (or vice versa, given different run orders).
 */
export async function upsertMandato(input: MandatoInput): Promise<MandatoId> {
  const id = mandatoRecordId(input.chamber, input.legislatura, input.idPersona)
  const personaId = personaRecordId(input.chamber, input.idPersona)
  const patch: Record<string, unknown> = {
    persona_id: personaId,
    chamber: input.chamber,
    legislatura: input.legislatura,
    id_persona: input.idPersona,
  }
  if (input.nome) patch.nome = input.nome
  if (input.gruppo) patch.gruppo_attuale = input.gruppo
  if (input.ruolo) patch.ruolo = input.ruolo
  await runQuery(`UPSERT $id MERGE $patch;`, { id, patch })
  return id
}

interface ProfileFields {
  nome?: string | null
  gruppo_attuale?: string | null
  gruppo_storico?: unknown[] | null
  data_nascita?: string | null
  comune_nascita?: string | null
  circoscrizione?: string | null
  collegio?: string | null
  lista_elezione?: string | null
  data_proclamazione?: string | null
  formazione?: string | null
  uffici?: unknown[] | null
  organi?: unknown[] | null
  legislature?: unknown[] | null
  source_url?: string | null
  scrape_status?: string
}

/**
 * Apply a deputati-profile-scrape result onto an existing mandato row. The
 * mandato must already exist (created by the transcript ingest); this call
 * enriches it with the per-leg profile data.
 *
 * Also propagates the profile-scraped `nome` back to the persona row when
 * present. Transcript-derived nomes are scrappy (e.g. occasional
 * "VAI AL SITO DEL PRESIDENTE\nROBERTO FICO" artifacts from the deputies
 * page); the profile scrape is the canonical source of clean display names.
 *
 * The Table+insert dance used by other modules isn't safe here because
 * SurrealDB v2 rejects explicit nulls on `option<T>` fields -- a key that's
 * absent stays unset, a key that's null errors. We strip null/undefined
 * keys before MERGE.
 */
export async function applyMandatoProfile(
  id: MandatoId,
  chamber: Chamber,
  idPersona: number,
  fields: ProfileFields,
): Promise<void> {
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) patch[k] = v
  }
  patch.fetched_at = new Date()
  await runQuery(`UPDATE $id MERGE $patch;`, { id, patch })

  if (fields.nome) {
    const personaId = personaRecordId(chamber, idPersona)
    await runQuery(`UPDATE $id SET nome = $nome;`, { id: personaId, nome: fields.nome })
  }
}

/**
 * Increment `interventi_n` on the mandato. Called from the body pass after
 * every speech is written so a per-leg "most active speakers" ranking is
 * a single indexed query.
 *
 * `interventi_n` defaults to 0 if the field is absent, so the first call
 * sets it to 1 without needing a prior INIT step.
 */
export async function bumpMandatoInterventi(
  id: MandatoId,
  delta: number,
): Promise<void> {
  if (delta === 0) return
  await runQuery(
    `UPDATE $id SET interventi_n = (interventi_n ?? 0) + $delta;`,
    { id, delta },
  )
}

interface MandatoSummary {
  id: MandatoId
  chamber: Chamber
  legislatura: number
  id_persona: number
  nome: string | null
  gruppo_attuale: string | null
  fetched_at: string | null
}

/**
 * Return every mandato for a given chamber + legislatura. Used by the
 * deputati profile-scrape bulk pass: it queries the leg's mandati and
 * scrapes /deputati/elenco/{leg}-{id_persona}/ for each.
 *
 * `fetched_at` is included so callers can implement TTL skipping without an
 * N+1 query per row.
 */
export async function listMandatiByLeg(
  chamber: Chamber,
  legislatura: number,
): Promise<MandatoSummary[]> {
  const rows = await runQuery<MandatoSummary[]>(
    `SELECT id, chamber, legislatura, id_persona, nome, gruppo_attuale, fetched_at
     FROM parlamento_mandato
     WHERE chamber = $chamber AND legislatura = $leg
     ORDER BY id_persona ASC;`,
    { chamber, leg: legislatura },
  )
  return rows ?? []
}

/**
 * Re-export the SurrealDB Table type for callers that need to assemble
 * batch inserts manually (e.g. the body pass inserts ~hundreds of interventi
 * rows in one call).
 */
export { Table }
