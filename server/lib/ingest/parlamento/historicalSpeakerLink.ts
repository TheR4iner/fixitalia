import type { RosterDeputy } from './cameraHistoricalDeputatoSparql.ts'

// -----------------------------------------------------------------------------
// Name matching for the historical speaker-linking backfill (Camera legs 13-14).
//
// Transcripts from 1996-2006 store the speaker as a free-text label
// ("FIRSTNAME SURNAME", e.g. "CARLO GIOVANARDI") with no idPersona. We match
// that label against the leg roster (which carries idPersona) to attach a
// mandato_id, so cross-legislature "all speeches by person X" queries stop
// silently skipping these legs. We never join on the name string at query time
// (the people-equivalent of the ISTAT-code rule): this resolves to a canonical
// id once, and the id is what gets persisted.
//
// Matching is two-tier, both order-independent and accent/apostrophe-insensitive:
//
//   1. EXACT: the label's token set equals the deputy's (firstName ∪ surname)
//      token set. Highest confidence.
//
//   2. RELAXED (fallback when exact misses): the roster's `firstName` is the
//      full legal given-name string ("CARLO AMEDEO"), but transcripts use the
//      everyday form ("CARLO"). So we accept a label when the deputy's surname
//      tokens are all present, the deputy's primary given name is present, and
//      every non-surname token in the label is one of the deputy's given names
//      (label ⊆ official). This tolerates dropped middle names without ever
//      inventing a match: a foreign given name fails the subset test.
//
// In both tiers, if more than one deputy qualifies (true homonyms) we leave the
// row unlinked rather than guess -- a wrong link silently corrupts per-person
// stats, which is worse than a null.
// -----------------------------------------------------------------------------

// Institutional roles that can prefix a real name in the transcript label.
// Kept in sync with the ROLE_HINT list in cameraHistoricalSession.ts. A leading
// occurrence is stripped before tokenizing; these are never surnames.
const ROLE_TOKENS = new Set([
  'PRESIDENTE',
  'VICEPRESIDENTE',
  'MINISTRO',
  'MINISTRA',
  'SOTTOSEGRETARIO',
  'SOTTOSEGRETARIA',
  'SEGRETARIO',
  'SEGRETARIA',
  'RELATORE',
  'RELATRICE',
])

/**
 * Normalize a name fragment to comparable tokens, preserving order. Diacritics
 * and apostrophes are removed so "COLLÈ"/"COLLE" and "D'AGRÒ"/"DAGRO" collapse.
 * No role stripping here -- that is label-only (see {@link labelTokens}).
 */
export function normTokens(raw: string): string[] {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/['’`]/g, '') // drop apostrophes (D'AGRO -> DAGRO)
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ') // any other punctuation -> separator
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Tokens for a transcript speaker label: like {@link normTokens} but drops a
 * single leading institutional-role token ("PRESIDENTE", "MINISTRO", ...) so a
 * role-prefixed label still resolves to the person. Never strips to empty.
 */
export function labelTokens(raw: string): string[] {
  const tokens = normTokens(raw)
  if (tokens.length > 1 && ROLE_TOKENS.has(tokens[0])) tokens.shift()
  return tokens
}

/** Back-compat alias used by callers/tests that want the sorted exact key form. */
export function nameTokens(raw: string): string[] {
  return [...labelTokens(raw)].sort()
}

interface IndexedDeputy {
  dep: RosterDeputy
  firstTokens: string[]
  surnameTokens: string[]
}

export interface RosterIndex {
  /** sorted full-name token key -> deputies with that exact name. */
  exact: Map<string, IndexedDeputy[]>
  /** all deputies, for the relaxed subset scan. */
  all: IndexedDeputy[]
}

function exactKey(firstTokens: string[], surnameTokens: string[]): string {
  return [...firstTokens, ...surnameTokens].sort().join(' ')
}

export function buildRosterIndex(roster: RosterDeputy[]): RosterIndex {
  const exact = new Map<string, IndexedDeputy[]>()
  const all: IndexedDeputy[] = []
  for (const dep of roster) {
    const firstTokens = normTokens(dep.firstName)
    const surnameTokens = normTokens(dep.surname)
    if (firstTokens.length === 0 && surnameTokens.length === 0) continue
    const indexed: IndexedDeputy = { dep, firstTokens, surnameTokens }
    all.push(indexed)
    const key = exactKey(firstTokens, surnameTokens)
    const list = exact.get(key)
    if (list) list.push(indexed)
    else exact.set(key, [indexed])
  }
  return { exact, all }
}

export type MatchResult =
  | { kind: 'matched'; deputy: RosterDeputy; tier: 'exact' | 'relaxed' }
  | { kind: 'role' } // label is a bare institutional role, no person
  | { kind: 'ambiguous'; candidates: RosterDeputy[] }
  | { kind: 'unmatched' }

/** A label token set is a relaxed match for a deputy when the surname is fully
 *  present, the primary given name is present, and every non-surname label token
 *  is one of the deputy's given names (label ⊆ official given names). */
function relaxedMatches(labelSet: Set<string>, d: IndexedDeputy): boolean {
  if (d.surnameTokens.length === 0 || d.firstTokens.length === 0) return false
  for (const s of d.surnameTokens) if (!labelSet.has(s)) return false
  if (!labelSet.has(d.firstTokens[0])) return false
  const firstSet = new Set(d.firstTokens)
  let givenInLabel = 0
  for (const t of labelSet) {
    if (d.surnameTokens.includes(t)) continue
    if (!firstSet.has(t)) return false // a given name the deputy doesn't have
    givenInLabel += 1
  }
  return givenInLabel > 0 // need at least the first name, not surname-only
}

function uniqueByPersona(list: IndexedDeputy[]): IndexedDeputy[] {
  const seen = new Set<number>()
  const out: IndexedDeputy[] = []
  for (const d of list) {
    if (seen.has(d.dep.idPersona)) continue
    seen.add(d.dep.idPersona)
    out.push(d)
  }
  return out
}

/**
 * Resolve a transcript speaker label to a roster deputy. Pure and deterministic
 * so the backfill is idempotent and the logic is unit-testable without a DB.
 */
export function matchSpeaker(label: string | null | undefined, index: RosterIndex): MatchResult {
  if (!label) return { kind: 'unmatched' }
  const tokens = labelTokens(label)
  if (tokens.length === 0) return { kind: 'role' }
  if (tokens.length === 1 && ROLE_TOKENS.has(tokens[0])) return { kind: 'role' }

  // Tier 1: exact token-set equality.
  const exactHits = uniqueByPersona(index.exact.get([...tokens].sort().join(' ')) ?? [])
  if (exactHits.length === 1) return { kind: 'matched', deputy: exactHits[0].dep, tier: 'exact' }
  if (exactHits.length > 1) return { kind: 'ambiguous', candidates: exactHits.map((d) => d.dep) }

  // Tier 2: relaxed subset (handles dropped middle names).
  const labelSet = new Set(tokens)
  const relaxed = uniqueByPersona(index.all.filter((d) => relaxedMatches(labelSet, d)))
  if (relaxed.length === 1) return { kind: 'matched', deputy: relaxed[0].dep, tier: 'relaxed' }
  if (relaxed.length > 1) return { kind: 'ambiguous', candidates: relaxed.map((d) => d.dep) }
  return { kind: 'unmatched' }
}

/**
 * Canonical display name in the modern "SURNAME Firstname" convention used by
 * the rest of parlamento_mandato/persona, built from the roster fields.
 */
export function canonicalName(dep: RosterDeputy): string {
  const surname = dep.surname.trim()
  const first = dep.firstName.trim()
  if (surname && first) {
    const titled = first
      .toLowerCase()
      .replace(/(^|[\s'’-])([a-zà-ú])/g, (_, sep, ch) => sep + ch.toUpperCase())
    return `${surname} ${titled}`
  }
  return surname || first
}
