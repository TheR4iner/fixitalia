import type { DeputatoSnapshot } from './cameraDeputatoScraper.ts'

// -----------------------------------------------------------------------------
// SPARQL-based deputato profile fetch for historical legislatures (1-18).
//
// The HTML scraper in cameraDeputatoScraper.ts targets the current Camera
// website (`/deputati/elenco/{leg}-{id}/`) which only resolves for the
// currently sitting legislature. Archived legs are served on the historical
// portal (`storia.camera.it`), which gates its deputy LISTING behind a
// reCAPTCHA. Detail pages on storia are also a moving target -- they're
// JS-heavy and the slug embeds a birthdate we don't have.
//
// Both gates are bypassable by going to the Linked Open Data backend at
// `dati.camera.it/sparql`. The OCD ontology exposes the complete deputy
// graph keyed by the same numeric `id_persona` we already have in our
// parlamento_persona records:
//
//   deputato.rdf/d{id_persona}_{leg}    -- per-leg deputy profile
//     foaf:firstName / foaf:surname     -- "EMMA" / "BONINO"
//     dc:description                    -- education + profession blurb
//     foaf:gender                       -- male/female
//     foaf:depiction                    -- photo URL
//     ocd:aderisce -> blank node        -- group membership (multi-row history)
//     ocd:rif_mandatoCamera -> mandato  -- per-leg term-of-office
//
//   mandatoCamera.rdf/mc{leg}_{id}_{startDate}
//     ocd:startDate / ocd:endDate       -- proclamation / mandate end
//     ocd:motivoTermine                 -- "Fine Legislatura" / "Dimissioni" / ...
//     ocd:rif_elezione -> election event
//
//   elezione.rdf/e{leg}_{id}_{date}
//     dc:coverage                       -- "VENETO 2" (circoscrizione)
//     ocd:lista                         -- "ROSA NEL PUGNO" (party list)
//     dc:date                           -- "20060409" (election date)
//
// One query per deputy gets us everything. The cartesian explosion across
// the multi-row `aderisce` (group history) is small (most deputies have
// 1-3 groups per leg) and easier to consume client-side than two queries.
//
// The endpoint and pattern mirror what `senato-ddl-resolver.test.ts` already
// uses for AS bill resolution against `dati.senato.it/sparql` -- same shape,
// same idempotent retry strategy.
// -----------------------------------------------------------------------------

const SPARQL_ENDPOINT = 'https://dati.camera.it/sparql'

// Italian republic legs use Roman numerals in the ontology; we encode the
// arabic-to-roman conversion only for the legs we actually call this for
// (1-18). When leg 20+ arrives, extend the table.
const LEG_ROMAN: Record<number, string> = {
  1: 'I',
  2: 'II',
  3: 'III',
  4: 'IV',
  5: 'V',
  6: 'VI',
  7: 'VII',
  8: 'VIII',
  9: 'IX',
  10: 'X',
  11: 'XI',
  12: 'XII',
  13: 'XIII',
  14: 'XIV',
  15: 'XV',
  16: 'XVI',
  17: 'XVII',
  18: 'XVIII',
}

interface SparqlBinding {
  type: string
  value: string
  datatype?: string
}

interface SparqlResults {
  head: { vars: string[] }
  results: { bindings: Array<Record<string, SparqlBinding>> }
}

async function querySparql(query: string, timeoutMs = 30_000): Promise<SparqlResults> {
  // URLSearchParams uses `+` for spaces (form-urlencoded). Some Italian
  // gov endpoints (senate's WAF in particular) reject `%20` on complex
  // multi-OPTIONAL queries; using `+` for spaces matches what curl emits
  // and passes cleanly on both endpoints.
  const params = new URLSearchParams()
  params.set('query', query)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const url = `${SPARQL_ENDPOINT}?${params.toString()}`
    const res = await fetch(url, {
      headers: {
        Accept: 'application/sparql-results+json',
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new Error(`SPARQL HTTP ${res.status}`)
    }
    return (await res.json()) as SparqlResults
  } finally {
    clearTimeout(timer)
  }
}

// Convert YYYYMMDD or YYYY-MM-DD to ISO YYYY-MM-DD. The ontology mixes both.
function normaliseDate(s: string | undefined | null): string | null {
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return null
}

function v(row: Record<string, SparqlBinding>, key: string): string | null {
  const b = row[key]
  return b?.value ?? null
}

// -----------------------------------------------------------------------------
// Roster enumeration: every deputy of a legislature, with idPersona + name.
//
// Used by the historical speaker-linking backfill (legs 13-14 transcripts carry
// names but no idPersona). The per-deputy fetch above needs an id we don't have
// for those legs; this returns the whole roster so the backfill can match the
// transcript's `oratore_nome` against it.
//
// The numeric idPersona is embedded in the deputato URI
// (`deputato.rdf/d{idPersona}_{leg}`); we extract it rather than carrying a
// separate persona-link column.
// -----------------------------------------------------------------------------

export interface RosterDeputy {
  idPersona: number
  firstName: string
  surname: string
  /** Most recent parliamentary group in this legislature, if known. */
  gruppo: string | null
}

const DEP_URI_RE = /\/deputato\.rdf\/d(\d+)_\d+$/

export async function fetchLegRosterViaSparql(legislatura: number): Promise<RosterDeputy[]> {
  const legUri = `http://dati.camera.it/ocd/legislatura.rdf/repubblica_${legislatura}`

  // Scalar roster: one row per (deputy) with first/last name. DISTINCT collapses
  // the cartesian fan-out the ontology produces across multi-valued predicates.
  const rosterQuery = `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    SELECT DISTINCT ?dep ?firstName ?surname
    WHERE {
      ?dep a ocd:deputato .
      ?dep ocd:rif_leg <${legUri}> .
      OPTIONAL { ?dep foaf:firstName ?firstName . }
      OPTIONAL { ?dep foaf:surname ?surname . }
    }
  `

  // Group history, separately to avoid multiplying the roster rows. We keep the
  // most recent group per deputy (latest startDate) as the "current" affiliation.
  const groupsQuery = `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT DISTINCT ?dep ?gruppoLabel ?startDate
    WHERE {
      ?dep a ocd:deputato .
      ?dep ocd:rif_leg <${legUri}> .
      ?dep ocd:aderisce ?bn .
      ?bn ocd:rif_gruppoParlamentare ?gruppoUri .
      ?gruppoUri rdfs:label ?gruppoLabel .
      OPTIONAL { ?bn ocd:startDate ?startDate . }
    }
  `

  const [roster, groups] = await Promise.all([
    querySparql(rosterQuery, 60_000),
    querySparql(groupsQuery, 60_000),
  ])

  // idPersona -> most-recent gruppo label.
  const gruppoByPersona = new Map<number, { label: string; start: string | null }>()
  for (const g of groups.results.bindings) {
    const id = idFromDepUri(v(g, 'dep'))
    const label = v(g, 'gruppoLabel')
    if (id === null || !label) continue
    const start = normaliseDate(v(g, 'startDate'))
    const prev = gruppoByPersona.get(id)
    if (!prev || (start ?? '').localeCompare(prev.start ?? '') > 0) {
      gruppoByPersona.set(id, { label, start })
    }
  }

  const byPersona = new Map<number, RosterDeputy>()
  for (const row of roster.results.bindings) {
    const id = idFromDepUri(v(row, 'dep'))
    if (id === null) continue
    const firstName = (v(row, 'firstName') ?? '').trim()
    const surname = (v(row, 'surname') ?? '').trim()
    if (!firstName && !surname) continue
    // Same idPersona can recur if name fields differ by whitespace/case; first
    // non-empty wins, which is fine since names are stable within a leg.
    if (!byPersona.has(id)) {
      byPersona.set(id, {
        idPersona: id,
        firstName,
        surname,
        gruppo: gruppoByPersona.get(id)?.label ?? null,
      })
    }
  }
  return Array.from(byPersona.values())
}

function idFromDepUri(uri: string | null): number | null {
  if (!uri) return null
  const m = uri.match(DEP_URI_RE)
  return m ? Number(m[1]) : null
}

export async function fetchCameraDeputatoViaSparql(
  idPersona: number,
  legislatura: number,
): Promise<DeputatoSnapshot | null> {
  const roman = LEG_ROMAN[legislatura]
  if (!roman) {
    console.warn(
      `[scraper:camera-historical-sparql] unsupported legislatura ${legislatura} (no roman mapping)`,
    )
    return null
  }

  const depUri = `http://dati.camera.it/ocd/deputato.rdf/d${idPersona}_${legislatura}`
  const personaUri = `http://dati.camera.it/ocd/persona.rdf/p${idPersona}`

  // One round-trip pulls scalar deputato fields + mandato dates + electoral
  // district. The multi-row groups query is separate to avoid a cartesian
  // explosion -- a deputy with 3 groups and 2 mandato variants would otherwise
  // return 6 rows of duplicated scalar data.
  const scalarQuery = `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    PREFIX dc: <http://purl.org/dc/elements/1.1/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?firstName ?surname ?gender ?bio ?personaLabel
           ?startDate ?endDate ?motivoTermine
           ?circoscrizione ?lista ?dataElezione
    WHERE {
      OPTIONAL { <${depUri}> foaf:firstName ?firstName . }
      OPTIONAL { <${depUri}> foaf:surname ?surname . }
      OPTIONAL { <${depUri}> foaf:gender ?gender . }
      OPTIONAL { <${depUri}> dc:description ?bio . }
      OPTIONAL { <${personaUri}> rdfs:label ?personaLabel . }
      OPTIONAL {
        <${depUri}> ocd:rif_mandatoCamera ?mandato .
        OPTIONAL { ?mandato ocd:startDate ?startDate . }
        OPTIONAL { ?mandato ocd:endDate ?endDate . }
        OPTIONAL { ?mandato ocd:motivoTermine ?motivoTermine . }
        OPTIONAL {
          ?mandato ocd:rif_elezione ?elezione .
          OPTIONAL { ?elezione dc:coverage ?circoscrizione . }
          OPTIONAL { ?elezione ocd:lista ?lista . }
          OPTIONAL { ?elezione dc:date ?dataElezione . }
        }
      }
    }
    LIMIT 5
  `

  const groupsQuery = `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT DISTINCT ?gruppoLabel ?startDate ?endDate
    WHERE {
      <${depUri}> ocd:aderisce ?bn .
      ?bn ocd:rif_gruppoParlamentare ?gruppoUri .
      ?gruppoUri rdfs:label ?gruppoLabel .
      OPTIONAL { ?bn ocd:startDate ?startDate . }
      OPTIONAL { ?bn ocd:endDate ?endDate . }
    }
    ORDER BY ?startDate
  `

  let scalar: SparqlResults
  let groups: SparqlResults
  try {
    [scalar, groups] = await Promise.all([querySparql(scalarQuery), querySparql(groupsQuery)])
  } catch (err) {
    console.warn(
      `[scraper:camera-historical-sparql] SPARQL query failed for d${idPersona}_${legislatura}:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }

  const scalarRow = scalar.results.bindings[0]
  if (!scalarRow) {
    // No data for this (persona, leg). The mandato might exist (we created
    // the shell during body-pass) but the ontology doesn't know about this
    // deputy/leg combo -- a sign the id_persona was misclassified or the
    // deputy is too old for the ontology. Return null and let the bulk
    // pass record "failed".
    return null
  }

  const firstName = v(scalarRow, 'firstName')
  const surname = v(scalarRow, 'surname')
  // The deputato.rdf resource is leg-specific: its firstName/surname only
  // exist when (id, leg) is a real deputy. If both are missing, the call
  // is effectively asking about a leg the person didn't serve -- return
  // null so the bulk pass records this as failed rather than writing a
  // row with only a persona label and nothing else.
  if (!firstName && !surname) return null
  const fullName =
    firstName && surname
      ? `${surname} ${firstName.charAt(0)}${firstName.slice(1).toLowerCase()}`
      : v(scalarRow, 'personaLabel') ?? surname ?? firstName

  // Group history with current group at top (most recent endDate or no
  // endDate means active during the legislature's close).
  const groupRows = groups.results.bindings
  const gruppoStorico = groupRows.map((g) => ({
    gruppo: v(g, 'gruppoLabel') ?? '',
    dal: normaliseDate(v(g, 'startDate')),
    al: normaliseDate(v(g, 'endDate')),
  }))
  // Sort descending by `dal`: the most recent group is "current" for the
  // legislature in question. For ties keep ontology order.
  gruppoStorico.sort((a, b) => (b.dal ?? '').localeCompare(a.dal ?? ''))
  const gruppoAttuale = gruppoStorico[0]?.gruppo || null

  const snapshot: DeputatoSnapshot = {
    slug: `camera-id-${idPersona}`,
    chamber: 'camera',
    id_ufficiale: String(idPersona),
    nome: fullName,
    gruppo_attuale: gruppoAttuale,
    gruppo_storico: gruppoStorico,
    data_nascita: null,
    comune_nascita: null,
    circoscrizione: v(scalarRow, 'circoscrizione'),
    collegio: null,
    lista_elezione: v(scalarRow, 'lista'),
    data_proclamazione: normaliseDate(v(scalarRow, 'startDate')),
    formazione: v(scalarRow, 'bio'),
    uffici: [],
    organi: [],
    legislature: [roman],
    source_url: `https://dati.camera.it/ocd/deputato.rdf/d${idPersona}_${legislatura}`,
    scrape_status: fullName ? 'ok' : 'parse_error',
  }
  return snapshot
}
