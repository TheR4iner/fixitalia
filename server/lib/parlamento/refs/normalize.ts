import type { RawRef } from './parse.ts'
import type { InternalRefTipo } from './types.ts'

// A canonical reference: numero is preserved as a string (laws can
// have suffixes like "12-bis" in theory, though our v1 regex bank
// only captures pure digits), date components are merged into the
// URN form, and the URN is built when applicable.
//
// tipo can still be the internal "ddl_ambiguous" placeholder here;
// the resolution to ac/as happens one layer up in parseRefs().
export interface CanonicalRef {
  tipo: InternalRefTipo
  anno?: number
  numero?: string
  articolo?: number
  urn?: string
  raw: string
  start: number
  end_offset: number
}

const URN_TIPO: Partial<Record<InternalRefTipo, string>> = {
  legge: 'legge',
  'decreto.legge': 'decreto.legge',
  'decreto.legislativo': 'decreto.legislativo',
  dpr: 'decreto.presidente.repubblica',
  costituzione: 'costituzione',
}

// Italian Constitution promulgation date, used as the costituzione
// URN base. Article-specific anchors append `~art{N}`.
const COSTITUZIONE_DATE = '1947-12-27'

export function normalize(raw: RawRef): CanonicalRef {
  const base: CanonicalRef = {
    tipo: raw.tipo,
    anno: raw.anno,
    numero: raw.numero,
    articolo: raw.articolo,
    raw: raw.raw,
    start: raw.start,
    end_offset: raw.end_offset,
  }

  const urnTipo = URN_TIPO[raw.tipo]
  if (!urnTipo) {
    return base
  }

  if (raw.tipo === 'costituzione') {
    if (raw.articolo === undefined) return base // bare Costituzione skipped
    base.urn = `urn:nir:stato:costituzione:${COSTITUZIONE_DATE}~art${raw.articolo}`
    return base
  }

  if (raw.anno === undefined || raw.numero === undefined) return base

  const datePart =
    raw.giorno !== undefined && raw.mese !== undefined
      ? `${raw.anno}-${pad2(raw.mese)}-${pad2(raw.giorno)}`
      : `${raw.anno}`
  base.urn = `urn:nir:stato:${urnTipo}:${datePart};${raw.numero}`
  return base
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}
