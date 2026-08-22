import { PATTERNS, MONTH_TO_NUM } from './patterns.ts'
import type { InternalRefTipo } from './types.ts'

// A raw match before normalisation / URL building. tipo carries the
// classification chosen by the regex; the date / numero / articolo
// captures are normalised into numbers in the next stage.
//
// tipo is InternalRefTipo (not RefTipo) because the ddl_ambiguous
// match needs chamber context to resolve into ac/as -- which happens
// in the public parseRefs() wrapper, not here.
export interface RawRef {
  tipo: InternalRefTipo
  raw: string
  start: number
  end_offset: number
  giorno?: number
  mese?: number
  anno?: number
  numero?: string
  articolo?: number
}

// Run the regex bank over `testo`, dedupe overlapping matches, and
// return them in document order.
//
// Dedupe rule: when two matches overlap, the one starting earliest
// wins; ties on start position are broken by the longer match. This
// keeps "decreto-legge n. 34 del 2020" as a single decreto.legge
// reference rather than splitting it into a duplicate `legge` match.
export function findRefs(testo: string): RawRef[] {
  const matches: RawRef[] = []
  for (const { tipo, re } of PATTERNS) {
    re.lastIndex = 0
    for (const m of testo.matchAll(re)) {
      if (m.index === undefined) continue
      const groups = m.groups ?? {}
      matches.push({
        tipo,
        raw: m[0],
        start: m.index,
        end_offset: m.index + m[0].length,
        giorno: groups.giorno ? parseInt(groups.giorno, 10) : undefined,
        mese: groups.mese ? MONTH_TO_NUM[groups.mese.toLowerCase()] : undefined,
        anno: groups.anno ? parseInt(groups.anno, 10) : undefined,
        numero: groups.numero,
        articolo: groups.articolo ? parseInt(groups.articolo, 10) : undefined,
      })
    }
  }
  return dedupe(matches)
}

function dedupe(matches: RawRef[]): RawRef[] {
  const sorted = [...matches].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return b.end_offset - b.start - (a.end_offset - a.start)
  })
  const kept: RawRef[] = []
  let lastEnd = -1
  for (const m of sorted) {
    if (m.start >= lastEnd) {
      kept.push(m)
      lastEnd = m.end_offset
    }
  }
  return kept
}
