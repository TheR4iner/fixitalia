// -----------------------------------------------------------------------------
// Shared CKAN client for the dati.mit.gov.it and bdap-opendata.rgs.mef.gov.it
// portals. Both expose the standard CKAN v3 API at <base>/api/3/action/*; we
// only need package_show and package_search.
//
// Why this exists: MIT and BDAP publish a new dataset file roughly once a year
// (MIT) or once a month (BDAP), but they keep older releases in the same
// package, each with a stable UUID. Hard-coding the UUID in our ingest worked
// at first but means every new upstream release silently leaves us behind.
// Resolving the latest resource via CKAN at ingest time means a single
// re-ingest always picks up whatever is newest, no code change required.
//
// We deliberately do NOT add any caching here: ingest runs once per source,
// the catalog response is small (~30 KB), and a fresh fetch every run is the
// correct behaviour.
// -----------------------------------------------------------------------------

export interface CkanResource {
  id: string
  name?: string
  format?: string
  last_modified?: string | null
  created?: string | null
  url: string
}

export interface CkanPackage {
  id: string
  name: string
  title?: string
  metadata_modified?: string
  resources: CkanResource[]
}

interface CkanShowResponse {
  success: boolean
  result: CkanPackage
}

interface CkanSearchResponse {
  success: boolean
  result: { count: number; results: CkanPackage[] }
}

// Both portals sit behind a CDN/WAF that rejects unrealistic User-Agents.
// MIT is permissive; BDAP and ANAC are not. Send a real-browser UA in all
// cases so the same helper works for any future CKAN-based source.
const CKAN_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  accept: 'application/json',
}

function actionUrl(catalogBase: string, action: string, query: string): string {
  // Strip a trailing slash on the base so we don't produce a double-slash.
  const base = catalogBase.replace(/\/$/, '')
  return `${base}/api/3/action/${action}?${query}`
}

export async function ckanPackageShow(
  catalogBase: string,
  packageId: string,
): Promise<CkanPackage> {
  const url = actionUrl(catalogBase, 'package_show', `id=${encodeURIComponent(packageId)}`)
  const res = await fetch(url, { headers: CKAN_HEADERS })
  if (!res.ok) {
    throw new Error(`CKAN package_show failed: HTTP ${res.status} ${res.statusText} (${url})`)
  }
  const json = (await res.json()) as CkanShowResponse
  if (!json.success) {
    throw new Error(`CKAN package_show returned success=false for "${packageId}"`)
  }
  return json.result
}

export async function ckanPackageSearch(
  catalogBase: string,
  q: string,
  rows = 100,
  start = 0,
): Promise<CkanPackage[]> {
  const url = actionUrl(
    catalogBase,
    'package_search',
    `q=${encodeURIComponent(q)}&rows=${rows}&start=${start}`,
  )
  const res = await fetch(url, { headers: CKAN_HEADERS })
  if (!res.ok) {
    throw new Error(`CKAN package_search failed: HTTP ${res.status} ${res.statusText} (${url})`)
  }
  const json = (await res.json()) as CkanSearchResponse
  if (!json.success) {
    throw new Error('CKAN package_search returned success=false')
  }
  return json.result.results
}

/**
 * Walk every page of a package_search result set.
 *
 * Needed because BDAP caps a single response well below the number of
 * packages in a long-running monthly series, and because large `rows`
 * values are a reliability problem in their own right: `rows=200` against
 * bdap-opendata.rgs.mef.gov.it does not respond within two minutes, while
 * `rows=100` returns in a few seconds. Paging with a modest page size is
 * both correct and faster.
 *
 * `maxPages` is a runaway guard, not a coverage limit: it is deliberately
 * set far above any real series length, and hitting it is logged loudly
 * rather than silently truncating the working set.
 */
export async function ckanPackageSearchAll(
  catalogBase: string,
  q: string,
  { pageSize = 100, maxPages = 40 }: { pageSize?: number; maxPages?: number } = {},
): Promise<CkanPackage[]> {
  const all: CkanPackage[] = []
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await ckanPackageSearch(catalogBase, q, pageSize, page * pageSize)
    all.push(...batch)
    if (batch.length < pageSize) return all
  }
  console.warn(
    `[ckan] package_search("${q}") hit the ${maxPages}-page guard at ${all.length} ` +
      'packages; the working set may be incomplete.',
  )
  return all
}

// Compare two CKAN ISO-ish timestamps. CKAN emits "YYYY-MM-DDThh:mm:ss(.fraction)?"
// strings; lexicographic order matches chronological order, so a string
// compare is correct without parsing.
export function ckanLatestFirst(
  a: { metadata_modified?: string; last_modified?: string | null; created?: string | null },
  b: { metadata_modified?: string; last_modified?: string | null; created?: string | null },
): number {
  const aKey = a.metadata_modified || a.last_modified || a.created || ''
  const bKey = b.metadata_modified || b.last_modified || b.created || ''
  return bKey.localeCompare(aKey)
}
