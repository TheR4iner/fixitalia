#!/usr/bin/env tsx
// Phase 0c probe: does SPARQL expose SESSION (seduta) metadata for the PDF era?
//
// We already know dati.camera.it/sparql has per-DEPUTY data for legs 1-18, and
// dati.senato.it/sparql has senator + seduta data for the HTML era. The open
// question for legs 1-12 is whether the SAME endpoints carry session metadata
// (numero, data, tipoSeduta) that far back -- if so, the PDF-era index pass is
// free (a SPARQL query, no Playwright), and only the body pass needs the PDFs.
//
// This probe COUNTs sedute per legislature on both endpoints. Read-only HTTP,
// no DB writes -- safe during an active ingest.
//
// Usage:
//   dev exec backend npx tsx scripts/_probe-pdf-sparql-sedute.ts

// Standalone probe: no project imports, so TypeScript would treat this file
// as a global script and collide with the other probes' top-level UA/helpers.
// This empty export makes it a module. No runtime effect.
export {}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface SparqlBinding {
  type: string
  value: string
  datatype?: string
}
interface SparqlResults {
  head: { vars: string[] }
  results: { bindings: Array<Record<string, SparqlBinding>> }
}

async function querySparql(endpoint: string, query: string): Promise<SparqlResults | string> {
  const params = new URLSearchParams()
  params.set('query', query)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 40_000)
  try {
    const res = await fetch(`${endpoint}?${params.toString()}`, {
      headers: { Accept: 'application/sparql-results+json', 'user-agent': UA },
      signal: ctrl.signal,
    })
    if (!res.ok) return `HTTP ${res.status}`
    return (await res.json()) as SparqlResults
  } catch (err) {
    return `ERR ${err instanceof Error ? err.message : String(err)}`
  } finally {
    clearTimeout(timer)
  }
}

// --- Camera: OCD ontology. seduta resources are `seduta.rdf/sed_{...}` and link
// to a legislatura via ocd:rif_leg. We count per repubblica_{N}. ---
function cameraSeduteCount(leg: number): string {
  const legUri = `http://dati.camera.it/ocd/legislatura.rdf/repubblica_${leg}`
  return `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE {
      ?s a ocd:seduta .
      ?s ocd:rif_leg <${legUri}> .
    }`
}

// --- Senato: the LOD graph models sedute under the osr/ocd ontology. We probe
// generically: count resources whose type label contains "eduta" and which
// carry a legislatura reference. The exact predicate may differ; if this comes
// back 0 or errors, we fall back to introspecting the class list. ---
function senatoSeduteCount(leg: number): string {
  return `
    PREFIX ocd: <http://dati.senato.it/osr/>
    SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE {
      ?s a ?t .
      ?s ?legPred ?leg .
      FILTER(CONTAINS(LCASE(STR(?t)), "seduta"))
      FILTER(CONTAINS(STR(?leg), "${leg}"))
    } LIMIT 1`
}

function readCount(r: SparqlResults | string): string {
  if (typeof r === 'string') return r
  const b = r.results.bindings[0]
  if (!b) return '0 (no rows)'
  const key = r.head.vars[0]
  return b[key]?.value ?? '?'
}

async function main(): Promise<void> {
  const legs = [1, 5, 10, 12, 13, 14] // include 13-14 as a known-populated sanity baseline

  console.log('=== Camera: dati.camera.it/sparql -- seduta count per leg ===')
  for (const leg of legs) {
    const r = await querySparql('https://dati.camera.it/sparql', cameraSeduteCount(leg))
    console.log(`  leg ${String(leg).padStart(2)}: ${readCount(r)}`)
  }

  console.log('\n=== Senato: dati.senato.it/sparql -- seduta-like count per leg ===')
  for (const leg of legs) {
    const r = await querySparql('https://dati.senato.it/sparql', senatoSeduteCount(leg))
    console.log(`  leg ${String(leg).padStart(2)}: ${readCount(r)}`)
  }

  console.log(
    '\nNote: a nonzero Camera count for legs 1-12 means the index pass can be SPARQL-driven',
  )
  console.log('(numero + data + tipoSeduta), leaving only the PDF body to fetch + parse.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[probe-pdf-sparql-sedute] failed:', err)
    process.exit(1)
  })
