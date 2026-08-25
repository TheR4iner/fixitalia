import { fetchWithRetry } from './parseHelpers.ts'

// -----------------------------------------------------------------------------
// Shared client for the Senato Linked Open Data endpoint.
//
// This endpoint matters operationally: www.senato.it sits behind an AWS WAF
// that needs a headless browser to satisfy, but dati.senato.it is a separate
// deployment with no such challenge. Anything that can be answered here --
// which sittings exist, when, for which committee -- costs a plain HTTP
// request instead of a browser navigation, and keeps the WAF budget for the
// document fetches that genuinely require it.
// -----------------------------------------------------------------------------

export const SENATO_SPARQL_ENDPOINT = 'https://dati.senato.it/sparql'

export interface SparqlBinding {
  type: string
  value: string
  datatype?: string
}

export interface SparqlResults {
  head: { vars: string[] }
  results: { bindings: Array<Record<string, SparqlBinding>> }
}

/**
 * Run a SPARQL query and return the raw JSON results.
 *
 * dati.senato.it gates plain Node fetch with HTTP 403. Two quirks to satisfy
 * its filter:
 *   1. Browser-like headers (BROWSER_HEADERS, via fetchWithRetry).
 *   2. Spaces must be encoded as `+` (form-urlencoded), NOT `%20`. The filter
 *      flags `%20` inside multi-OPTIONAL queries as suspicious and 403s;
 *      URLSearchParams emits `+` and passes cleanly. This is also why curl
 *      with `--data-urlencode` works where a naive encodeURIComponent does
 *      not.
 */
export async function querySparql(query: string, timeoutMs = 30_000): Promise<SparqlResults> {
  const params = new URLSearchParams()
  params.set('query', query)
  params.set('format', 'application/sparql-results+json')
  const url = `${SENATO_SPARQL_ENDPOINT}?${params.toString()}`
  const res = await fetchWithRetry(url, {
    timeoutMs,
    attempts: 2,
    headers: { accept: 'application/sparql-results+json' },
  })
  if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`)
  return (await res.json()) as SparqlResults
}

/** Read one binding's value, or null when the variable was unbound. */
export function sparqlValue(
  row: Record<string, SparqlBinding>,
  key: string,
): string | null {
  return row[key]?.value ?? null
}
