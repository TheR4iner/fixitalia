import { slugify } from './slug'

/**
 * Stable key for an "oratore mentioned in a seduta", used to reconcile
 * the speaker entries returned by the seduta detail endpoint with the
 * actual interventions returned by the interventi endpoint. We key by
 * (slugified-name | gruppo | ruolo) because the same surname may appear
 * in multiple parties or roles within one session.
 */
export function oratoreKey(
  nome: string,
  gruppo: string | null,
  ruolo: string | null,
): string {
  return `${slugify(nome)}|${gruppo ?? ''}|${ruolo ?? ''}`
}
