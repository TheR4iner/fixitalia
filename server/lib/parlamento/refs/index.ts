import { findRefs } from './parse.ts'
import { normalize } from './normalize.ts'
import { buildUrl } from './url.ts'
import type { Ref, RefContext, RefTipo } from './types.ts'

export { PARSER_VERSION } from './version.ts'
export type { Ref, RefContext, RefTipo } from './types.ts'

// Public API: parse `testo` into the persisted Ref shape, with URLs
// built where possible (Normattiva URNs, Camera bills) and null
// otherwise (AS bills pending SPARQL resolution).
//
// Bare costituzione mentions (no article) are dropped here: their
// canonical form has no urn, so they would persist as URL-less rows
// that the frontend cannot link.
//
// "disegno di legge n. NUM" (without S. or A.S. abbreviation) is
// resolved to ac/as based on ctx.chamber: the speaker discussing the
// bill in chamber X is referencing the X-numbered ordinal.
export function parseRefs(testo: string, ctx: RefContext): Ref[] {
  const out: Ref[] = []
  for (const raw of findRefs(testo)) {
    const canonical = normalize(raw)
    if (canonical.tipo === 'costituzione' && canonical.articolo === undefined) {
      continue
    }
    const resolvedTipo: RefTipo =
      canonical.tipo === 'ddl_ambiguous' ? (ctx.chamber === 'senato' ? 'as' : 'ac') : canonical.tipo
    out.push({
      tipo: resolvedTipo,
      anno: canonical.anno,
      numero: canonical.numero,
      articolo: canonical.articolo,
      urn: canonical.urn,
      url: buildUrl({ ...canonical, tipo: resolvedTipo }, ctx),
      raw: canonical.raw,
      start: canonical.start,
      end_offset: canonical.end_offset,
    })
  }
  return out
}
