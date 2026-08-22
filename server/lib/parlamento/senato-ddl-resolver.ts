import { Table } from 'surrealdb'

import { getDb } from '../db.ts'
import { runQuery } from '../query.ts'
import { fetchWithRetry } from '../ingest/parlamento/parseHelpers.ts'

// Resolve "atto Senato n. NUM" references into a deep-link URL on
// senato.it. The senato.it scheda URL needs an internal idDdl that the
// public-facing ordinal does not expose; we fetch the mapping via the
// dati.senato.it SPARQL endpoint and persist it in
// parlamento_senato_ddl_idmap so subsequent lookups are local.
//
// Failure modes are non-throwing: every public function returns null on
// any error, and the caller marks the ref resolve_status='failed'. A
// flaky SPARQL endpoint should never break the refs ingest pass.

const SPARQL_ENDPOINT = 'https://dati.senato.it/sparql'

export interface ResolveResult {
  id_ddl: string
  url: string
}

interface IdmapRow {
  leg: number
  numero: number
  id_ddl: string
  url: string
}

interface SparqlBinding {
  ddl?: { value: string }
}

interface SparqlResponse {
  results?: { bindings?: SparqlBinding[] }
}

// SPARQL query verified empirically against the live endpoint:
//   - osr:legislatura is a plain integer literal (no quotes around the
//     value, no language tag).
//   - osr:numeroFase is the public-facing ordinal (the "1236" in
//     "S. 1236") as a string. The URI tail of ?ddl is the idDdl that
//     senato.it scheda URLs need (different from osr:idDdl, which is a
//     phase-specific identifier).
//
// Multiple rows per (leg, numero) are possible because each Ddl phase
// creates its own row with the same numeroFase; we LIMIT 1 because all
// phases land on the same senato.it scheda page.
function buildSparql(leg: number, numero: number): string {
  return `
    PREFIX osr: <http://dati.senato.it/osr/>
    SELECT ?ddl WHERE {
      ?ddl a osr:Ddl ;
           osr:legislatura ${leg} ;
           osr:numeroFase ?num .
      FILTER(STR(?num) = "${numero}")
    }
    LIMIT 1
  `.trim()
}

// Pulled out so the test can mock it directly without monkey-patching
// fetchWithRetry. Returns the raw idDdl string from the URI tail
// (e.g. "58519" from "http://dati.senato.it/ddl/58519"), or null.
export async function sparqlLookup(leg: number, numero: number): Promise<string | null> {
  const query = buildSparql(leg, numero)
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=application%2Fsparql-results%2Bjson`
  const res = await fetchWithRetry(url, {
    timeoutMs: 30_000,
    attempts: 2,
    headers: { accept: 'application/sparql-results+json' },
  })
  if (!res.ok) {
    throw new Error(`SPARQL HTTP ${res.status}`)
  }
  const data = (await res.json()) as SparqlResponse
  const ddlUri = data.results?.bindings?.[0]?.ddl?.value
  if (!ddlUri) return null
  const m = ddlUri.match(/\/ddl\/([^/]+)$/)
  return m ? m[1] : null
}

function buildSchedaUrl(leg: number, idDdl: string): string {
  return `https://www.senato.it/leg/${leg}/BGT/Schede/Ddliter/${idDdl}.htm`
}

// Public API. Cache hit returns immediately; cache miss attempts the
// SPARQL lookup and persists on success. All errors are caught and
// reported as null so the caller can mark the ref resolve_status
// without dragging the whole ingest down.
export async function resolveSenatoBill(
  leg: number,
  numero: number,
): Promise<ResolveResult | null> {
  const cached = await runQuery<IdmapRow[]>(
    `SELECT leg, numero, id_ddl, url
     FROM parlamento_senato_ddl_idmap
     WHERE leg = $leg AND numero = $num
     LIMIT 1;`,
    { leg, num: numero },
  )
  if (cached?.[0]) {
    return { id_ddl: cached[0].id_ddl, url: cached[0].url }
  }

  let idDdl: string | null = null
  try {
    idDdl = await sparqlLookup(leg, numero)
  } catch (err) {
    console.warn(
      `[senato-resolver] leg=${leg} numero=${numero} SPARQL failed:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
  if (!idDdl) return null

  const url = buildSchedaUrl(leg, idDdl)
  // Persist the mapping; on UNIQUE conflict (another worker beat us
  // to it) ignore the failure -- we already have the data we need.
  try {
    const db = await getDb()
    await db.insert(new Table('parlamento_senato_ddl_idmap'), {
      leg,
      numero,
      id_ddl: idDdl,
      url,
    })
  } catch (err) {
    console.warn(
      `[senato-resolver] idmap insert leg=${leg} numero=${numero} failed (probably already cached):`,
      err instanceof Error ? err.message : err,
    )
  }
  return { id_ddl: idDdl, url }
}
