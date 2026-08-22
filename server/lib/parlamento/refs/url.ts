import type { CanonicalRef } from './normalize.ts'
import type { RefContext } from './types.ts'

// Build the destination URL for a canonical reference.
//
// - Normattiva (legge / decreto.legge / decreto.legislativo / dpr /
//   costituzione) is built deterministically from the URN. Year-only
//   URNs are accepted by the N2Ls resolver, so we never require the
//   full promulgation date.
// - Camera bills (AC) use idDocumento, which equals the AC ordinal
//   (verified empirically against camera.it/leg19/126?idDocumento=N).
//   We default the legislatura to the seduta's, since cross-leg
//   citations are out of scope for v1.
// - Senato bills (AS) need a numero -> idDdl SPARQL lookup that
//   doesn't belong in this synchronous step. We return null and let
//   the refs ingest pass call the resolver.
export function buildUrl(ref: CanonicalRef, ctx: RefContext): string | null {
  if (ref.urn) {
    return `https://www.normattiva.it/uri-res/N2Ls?${ref.urn}`
  }
  if (ref.tipo === 'ac' && ref.numero) {
    return `https://www.camera.it/leg${ctx.legislatura}/126?leg=${ctx.legislatura}&idDocumento=${ref.numero}`
  }
  // AS: return null -- the refs pass resolves this asynchronously and
  // either fills the resolved URL or marks the row resolve_status=failed.
  return null
}
