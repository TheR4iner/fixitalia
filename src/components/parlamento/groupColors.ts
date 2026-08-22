// Indicative tint per parliamentary group, used as the left-spine accent
// of an InterventoBlock. The mapping is deliberately broad: source data
// uses many slightly-different abbreviations across years (FdI, Fratelli
// d'Italia, FRATELLI D'ITALIA), so we lowercase + normalise + match
// against substring keys.
//
// Colours are tuned for the editorial palette and stay legible in both
// light and dark themes. They are NOT meant to faithfully reproduce
// each party's official brand: this is a low-saturation accent, not a
// flag.

interface GroupRule {
  match: RegExp
  light: string
  dark: string
}

const RULES: GroupRule[] = [
  { match: /\bfd?i\b|fratelli d'?italia/i, light: '#7a1f23', dark: '#c75055' },
  { match: /\blega\b|salvini/i, light: '#13577a', dark: '#5fb1d8' },
  { match: /forza italia|\bfi\b|berlusconi/i, light: '#2554a3', dark: '#7da3df' },
  { match: /noi moderati|\bnm\b/i, light: '#1f6f5b', dark: '#56bfa3' },
  { match: /\bpd\b|partito democratico/i, light: '#9c1b1b', dark: '#e26161' },
  { match: /\bm5s\b|movimento 5 stelle|cinque stelle/i, light: '#7a4d12', dark: '#d6a04a' },
  { match: /\bavs\b|alleanza verdi|sinistra italiana/i, light: '#2c5e2c', dark: '#7cb16a' },
  { match: /\biv\b|italia viva|renzi/i, light: '#7a3b6a', dark: '#cc9bbf' },
  { match: /\baz\b|azione|calenda/i, light: '#1a4f7a', dark: '#7ab1d8' },
  { match: /pi[uù] europa|\+e\b|\+europa/i, light: '#7a4f1a', dark: '#d6a76a' },
  { match: /misto/i, light: '#444', dark: '#aaa' },
  { match: /governo|esecutivo/i, light: '#222', dark: '#ddd' },
]

const FALLBACK_LIGHT = '#7a7a7a'
const FALLBACK_DARK = '#9a9a9a'

export function groupAccent(
  gruppo: string | null,
  resolved: 'light' | 'dark' = 'light',
): string {
  if (!gruppo) return resolved === 'dark' ? FALLBACK_DARK : FALLBACK_LIGHT
  for (const r of RULES) {
    if (r.match.test(gruppo)) {
      return resolved === 'dark' ? r.dark : r.light
    }
  }
  return resolved === 'dark' ? FALLBACK_DARK : FALLBACK_LIGHT
}
