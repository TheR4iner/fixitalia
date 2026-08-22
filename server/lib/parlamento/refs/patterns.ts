import type { InternalRefTipo } from './types.ts'

// Regex bank for detecting Italian legal references in transcript text.
//
// Design notes:
// - Long-form markers (legge, decreto-legge, ...) carry the `i` flag
//   because Italian capitalises sentence-initial words inconsistently
//   in oral transcripts. Short-form abbreviations (L., D.L., AC, AS,
//   D.P.R., D.Lgs.) are case-sensitive on purpose, otherwise lowercase
//   "ac"/"as" inside ordinary words trip false positives.
// - Patterns require both a tipo marker AND a number. Bare year
//   mentions, bare numbers, and bare law-related words alone never
//   match -- false positives are worse than false negatives in a
//   reader UI.
// - Multiple patterns per tipo intentionally overlap (date form, del
//   form, slash form). The parser dedupes overlapping matches keeping
//   the longest, so this redundancy increases recall without
//   producing duplicates.

const MONTH = '(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)'

interface Pattern {
  tipo: InternalRefTipo
  re: RegExp
}

// Build the four canonical numero/anno extraction patterns for a
// long-form marker (case-insensitive). The negative lookbehind
// `(?<!decreto[- ])` keeps the bare `legge` pattern from matching the
// tail of `decreto-legge`; the dedupe step would catch it anyway, but
// pruning at the regex level keeps the candidate list smaller.
function longForms(marker: string, tipo: InternalRefTipo, opts: { lookbehind?: string } = {}): Pattern[] {
  const lb = opts.lookbehind ? `(?<!${opts.lookbehind})` : ''
  return [
    // Date form: "<marker> 27 dicembre 2017, n. 205"  (comma optional)
    {
      tipo,
      re: new RegExp(
        `${lb}\\b(?:${marker})\\s+(?<giorno>\\d{1,2})\\s+(?<mese>${MONTH})\\s+(?<anno>\\d{4})\\s*,?\\s*n\\.\\s*(?<numero>\\d{1,5})\\b`,
        'gi',
      ),
    },
    // n. del with day-month-year following:  "<marker> n. 205 del 27 dicembre 2017"
    {
      tipo,
      re: new RegExp(
        `${lb}\\b(?:${marker})\\s+n\\.\\s*(?<numero>\\d{1,5})\\s+del\\s+(?<giorno>\\d{1,2})\\s+(?<mese>${MONTH})\\s+(?<anno>\\d{4})\\b`,
        'gi',
      ),
    },
    // del + year:  "<marker> n. 205 del 2017"  or  "<marker> 205 del 2017"
    {
      tipo,
      re: new RegExp(
        `${lb}\\b(?:${marker})\\s+(?:n\\.\\s*)?(?<numero>\\d{1,5})\\s+del\\s+(?<anno>\\d{4})\\b`,
        'gi',
      ),
    },
    // Slash form:  "<marker> 205/2017"  or  "<marker> n. 205/2017"
    {
      tipo,
      re: new RegExp(
        `${lb}\\b(?:${marker})\\s+(?:n\\.\\s*)?(?<numero>\\d{1,5})\\s*\\/\\s*(?<anno>\\d{4})\\b`,
        'gi',
      ),
    },
  ]
}

// Same shape as longForms but case-sensitive (no `i` flag). Used for
// short abbreviations where lowercase forms would over-match common
// Italian words.
function shortForms(marker: string, tipo: InternalRefTipo): Pattern[] {
  return [
    {
      tipo,
      re: new RegExp(
        `\\b(?:${marker})\\s+(?<giorno>\\d{1,2})\\s+(?<mese>${MONTH})\\s+(?<anno>\\d{4})\\s*,?\\s*n\\.\\s*(?<numero>\\d{1,5})\\b`,
        'g',
      ),
    },
    {
      tipo,
      re: new RegExp(
        `\\b(?:${marker})\\s+(?:n\\.\\s*)?(?<numero>\\d{1,5})\\s+del\\s+(?<anno>\\d{4})\\b`,
        'g',
      ),
    },
    {
      tipo,
      re: new RegExp(
        `\\b(?:${marker})\\s+(?:n\\.\\s*)?(?<numero>\\d{1,5})\\s*\\/\\s*(?<anno>\\d{4})\\b`,
        'g',
      ),
    },
  ]
}

export const PATTERNS: Pattern[] = [
  // ---- legge / leggi ----
  // Long form accepts singular "legge" and plural "leggi". Note this
  // is `legg[ei]` not `leggi?`: the `?` quantifier would make the
  // trailing `i` optional, leaving "legg" / "leggi" instead of the
  // intended "legge" / "leggi".
  ...longForms('legg[ei]', 'legge', { lookbehind: 'decreto[- ]' }),
  // Short form: bare L. (rare but real). Lowercase l. excluded -- too noisy.
  ...shortForms('L\\.', 'legge'),

  // ---- decreto-legge ----
  // Long form covers "decreto-legge" and "decreto legge" (single space).
  ...longForms('decreto[- ]legge', 'decreto.legge'),
  // Short form: D.L. or DL. Negative lookahead `(?!gs)` keeps it from
  // partially-matching D.Lgs.
  ...shortForms('D\\.?L\\.?(?!gs)', 'decreto.legge'),

  // ---- decreto legislativo ----
  ...longForms('decreto\\s+legislativo', 'decreto.legislativo'),
  // Short forms: D.Lgs., D. Lgs., Dlgs (no periods).
  ...shortForms('D\\.?\\s?Lgs\\.?|Dlgs', 'decreto.legislativo'),

  // ---- D.P.R. ----
  ...longForms('decreto\\s+del\\s+Presidente\\s+della\\s+Repubblica', 'dpr'),
  ...shortForms('D\\.?P\\.?R\\.?|DPR', 'dpr'),

  // ---- Costituzione (article-only, never bare) ----
  // Matches "art. 138 della Costituzione", "articolo 81 Cost.",
  // "art. 41, comma 2 della Costituzione" (the comma + commi tail is
  // outside the captured raw; we link to the article only).
  {
    tipo: 'costituzione',
    re: /\bart(?:icolo|\.)\s*(?<articolo>\d{1,3})(?:\s*,\s*comma\s+\d+)?\s+(?:della\s+|dell['’]\s*)?(?:Costituzione|Cost\.)/gi,
  },

  // ---- atto Camera ----
  {
    tipo: 'ac',
    re: /\batto\s+Camera\s+(?:n\.\s*)?(?<numero>\d{1,5})\b/gi,
  },
  {
    tipo: 'ac',
    re: /\bA\.?C\.?\s+(?<numero>\d{1,5})\b/g, // case-sensitive
  },
  {
    tipo: 'ac',
    re: /\bproposta\s+di\s+legge\s+C\.?\s+(?<numero>\d{1,5})\b/gi,
  },

  // ---- atto Senato ----
  {
    tipo: 'as',
    re: /\batto\s+Senato\s+(?:n\.\s*)?(?<numero>\d{1,5})\b/gi,
  },
  {
    tipo: 'as',
    re: /\bA\.?S\.?\s+(?<numero>\d{1,5})\b/g, // case-sensitive
  },
  {
    tipo: 'as',
    re: /\bdisegno\s+di\s+legge\s+S\.?\s+(?<numero>\d{1,5})\b/gi,
  },

  // ---- proposta di legge n. NUM (always Camera; only deputies file
  // a proposta di legge) ----
  {
    tipo: 'ac',
    re: /\bproposta\s+di\s+legge\s+n\.\s*(?<numero>\d{1,5})\b/gi,
  },

  // ---- disegno di legge n. NUM (chamber-of-origin implicit). The
  // final ac/as resolution happens in parseRefs() based on the
  // seduta's chamber: in a Camera transcript the implied chamber is
  // Camera (since the speaker is referencing the bill at hand), in a
  // Senato transcript it is Senato. ----
  {
    tipo: 'ddl_ambiguous',
    re: /\bdisegno\s+di\s+legge\s+n\.\s*(?<numero>\d{1,5})\b/gi,
  },
]

export const MONTH_TO_NUM: Record<string, number> = {
  gennaio: 1,
  febbraio: 2,
  marzo: 3,
  aprile: 4,
  maggio: 5,
  giugno: 6,
  luglio: 7,
  agosto: 8,
  settembre: 9,
  ottobre: 10,
  novembre: 11,
  dicembre: 12,
}
