import { RecordId } from 'surrealdb'

import { parseRefs, PARSER_VERSION } from './index.ts'
import type { RefContext } from './types.ts'
import { stripNulls } from '../../parse.ts'

// Re-export so existing call sites in cameraSession.ts and refs.ts keep
// the same import path; the canonical implementation lives in
// server/lib/parse.ts.
export { stripNulls }

interface InterventoForRefs {
  id: RecordId<'parlamento_interventi'>
  posizione: number
  testo: string
}

interface SedutaForRefs {
  id: RecordId<'parlamento_sedute'>
  chamber: 'camera' | 'senato'
  numero: number
  legislatura: number
  /** 'assemblea' | 'commissione'; denormalised onto every ref row. */
  organo?: string
  /**
   * Overrides the `<chamber-prefix>-<numero>` half of the generated ref id.
   *
   * Assembly callers leave this unset and keep the historical id format
   * byte-for-byte, which matters: changing it would strand every ref row
   * already in the corpus under an id nothing re-derives.
   *
   * Committee callers MUST set it. Committee resoconti are numbered
   * per-committee, so `numero` alone is not unique within a chamber -- two
   * committees both sitting for the Nth time would generate colliding ref
   * ids and silently overwrite each other.
   */
  idScope?: string
}

// Build the rows that will be inserted into parlamento_riferimenti for
// a single intervento.
//
// Deterministic id format:
//   parlamento_riferimenti:<scope>-<intervento_posizione>-<parser_version>-<start>
//
// where <scope> defaults to <chamber-prefix>-<seduta_numero> and is
// overridden by SedutaForRefs.idScope for committee sittings (see below).
//
// The chamber prefix (c|s) keeps Camera and Senato seduta-numero
// spaces disjoint. start is unique within (intervento, parser_version)
// because patterns dedupe overlapping matches before insertion.
//
// Re-running the parser on the same intervento at the same
// parser_version produces the same ids -> a true UPSERT on the refs
// pass, with no zero-refs window for in-flight reader requests.
export function buildRifRows(
  intervento: InterventoForRefs,
  seduta: SedutaForRefs,
  ctx: RefContext,
): Array<Record<string, unknown>> {
  const refs = parseRefs(intervento.testo, ctx)
  const prefix = seduta.chamber === 'camera' ? 'c' : 's'
  const scope = seduta.idScope ?? `${prefix}-${seduta.numero}`
  return refs.map((r) => {
    const idTag = `${scope}-${intervento.posizione}-${PARSER_VERSION}-${r.start}`
    // Resolve_status: AS bills with no synchronous url are pending the
    // SPARQL resolver; everything else is immediately resolved (ok).
    const status = r.tipo === 'as' && !r.url ? 'pending' : 'ok'
    return {
      id: new RecordId('parlamento_riferimenti', idTag),
      intervento: intervento.id,
      seduta: seduta.id,
      // chamber + legislatura denormalised from the seduta to keep the
      // AS resolver and admin queries off the seduta record link
      // (project memory: link traversal in WHERE forces full scans).
      chamber: seduta.chamber,
      legislatura: seduta.legislatura,
      organo: seduta.organo ?? 'assemblea',
      tipo: r.tipo,
      anno: r.anno,
      numero: r.numero,
      articolo: r.articolo,
      urn: r.urn,
      url: r.url ?? undefined,
      resolve_status: status,
      start: r.start,
      end_offset: r.end_offset,
      raw: r.raw,
      parser_version: PARSER_VERSION,
    }
  })
}

