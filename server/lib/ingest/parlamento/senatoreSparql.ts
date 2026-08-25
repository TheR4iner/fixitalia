// SPARQL-based senator profile fetch via dati.senato.it.
//
// Senate uses the same Linked Open Data pattern as the Camera ontology
// (see cameraHistoricalDeputatoSparql.ts) but exposes a richer Senatore
// model: birth city/date, residence, profession, plus per-leg mandato
// and group adherence with explicit dates.
//
// Key shape differences from Camera:
//
//   senatore/{did}                       -- one resource per person (not per leg)
//     foaf:firstName / foaf:lastName     -- "Alfredo" / "Mantica"
//     osr:dataNascita                    -- "1939-04-13"
//     osr:cittaNascita                   -- "Genova"
//     osr:professione                    -- "Avvocato"
//     osr:mandato -> per-leg mandato
//     ocd:aderisce -> blank node         -- group memberships (NOTE: camera namespace)
//
//   mandato/S_{leg}_{did}_{n}
//     osr:legislatura                    -- 17 (numeric)
//     osr:inizio / osr:fine              -- "2018-03-23" / "2022-10-12"
//     osr:tipoMandato                    -- "elettivo" / "di diritto e a vita, ..."
//
//   aderisce blank node
//     osr:gruppo -> gruppo/{id}          -- group URI
//     osr:inizio / osr:fine              -- adherence dates
//     osr:carica                         -- role within group
//     osr:legislatura                    -- the leg this membership applies to
//
// The senate `aderisce` predicate uses the Camera namespace
// (http://dati.camera.it/ocd/aderisce) for historical reasons; both
// chambers' ontologies federate the same `adesioneGruppo` concept.
//
// One SPARQL round-trip per (senatore, leg) returns the leg-filtered
// snapshot. We don't query aderisce directly via blank nodes (SPARQL
// engines on this endpoint don't always return blank-node properties via
// nested patterns); instead we walk from the senator through aderisce in
// one go with predicates inlined.

import type { DeputatoSnapshot } from './cameraDeputatoScraper.ts'
import { querySparql, sparqlValue, type SparqlResults } from './senatoSparqlClient.ts'

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
  19: 'XIX',
}

const v = sparqlValue

export async function fetchSenatoreViaSparql(
  idPersona: number,
  legislatura: number,
): Promise<DeputatoSnapshot | null> {
  const roman = LEG_ROMAN[legislatura]
  if (!roman) {
    console.warn(
      `[scraper:senatore-sparql] unsupported legislatura ${legislatura}`,
    )
    return null
  }

  const senatoreUri = `http://dati.senato.it/senatore/${idPersona}`

  // Scalar fields + this leg's mandato.
  const scalarQuery = `
    PREFIX osr: <http://dati.senato.it/osr/>
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?firstName ?lastName ?label ?gender ?dataNascita ?cittaNascita
           ?provinciaNascita
           ?mInizio ?mFine ?mTipo
    WHERE {
      OPTIONAL { <${senatoreUri}> foaf:firstName ?firstName . }
      OPTIONAL { <${senatoreUri}> foaf:lastName ?lastName . }
      OPTIONAL { <${senatoreUri}> rdfs:label ?label . }
      OPTIONAL { <${senatoreUri}> foaf:gender ?gender . }
      OPTIONAL { <${senatoreUri}> osr:dataNascita ?dataNascita . }
      OPTIONAL { <${senatoreUri}> osr:cittaNascita ?cittaNascita . }
      OPTIONAL { <${senatoreUri}> osr:provinciaNascita ?provinciaNascita . }
      # osr:professione returns a blank node carrying titolo+dates,
      # similar to the gruppo denominazione pattern. Skipped for now;
      # would need a separate walk to extract the literal string.
      OPTIONAL {
        <${senatoreUri}> osr:mandato ?m .
        ?m osr:legislatura ${legislatura} .
        OPTIONAL { ?m osr:inizio ?mInizio . }
        OPTIONAL { ?m osr:fine ?mFine . }
        OPTIONAL { ?m osr:tipoMandato ?mTipo . }
      }
    }
    LIMIT 5
  `

  // Group adherence history for this leg, with the group's display name
  // resolved through the two-step Senate model:
  //
  //   senator -aderisce-> adherence_bnode -gruppo-> gruppo
  //   gruppo -denominazione-> denomination_bnode -titolo-> name string
  //
  // A group has multiple denomination_bnodes because it gets RENAMED over
  // time. To pick the name in effect when the senator joined, we'd need a
  // date FILTER, but multi-OPTIONAL queries with FILTER trip the WAF. So
  // we ORDER BY denomination start date descending and DISTINCT on the
  // adherence -- the client takes the first row per adherence, which is
  // the most recent name as of the adherence start. Good enough for a
  // display label.
  const groupsQuery = `
    PREFIX osr: <http://dati.senato.it/osr/>
    PREFIX ocd: <http://dati.camera.it/ocd/>
    SELECT ?bn ?inizio ?fine ?carica ?titolo ?titoloBreve ?denomInizio
    WHERE {
      <${senatoreUri}> ocd:aderisce ?bn .
      ?bn osr:legislatura ${legislatura} .
      ?bn osr:gruppo ?g .
      ?g osr:denominazione ?denom .
      ?denom osr:titolo ?titolo .
      OPTIONAL { ?denom osr:titoloBreve ?titoloBreve . }
      OPTIONAL { ?denom osr:inizio ?denomInizio . }
      OPTIONAL { ?bn osr:inizio ?inizio . }
      OPTIONAL { ?bn osr:fine ?fine . }
      OPTIONAL { ?bn osr:carica ?carica . }
    }
    ORDER BY DESC(?denomInizio)
  `

  let scalar: SparqlResults
  let groups: SparqlResults
  try {
    [scalar, groups] = await Promise.all([querySparql(scalarQuery), querySparql(groupsQuery)])
  } catch (err) {
    console.warn(
      `[scraper:senatore-sparql] SPARQL query failed for senatore/${idPersona} leg=${legislatura}:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }

  const scalarRow = scalar.results.bindings[0]
  if (!scalarRow) return null

  // Senate scalar query joins on the mandato; if the senator didn't serve
  // this leg, mInizio will be missing AND there'll be no group rows.
  // Treat the combination of "no mandato dates AND no groups" as "didn't
  // serve this leg" and return null.
  const groupRows = groups.results.bindings
  const hasMandato = !!v(scalarRow, 'mInizio') || !!v(scalarRow, 'mFine')
  if (!hasMandato && groupRows.length === 0) return null

  const firstName = v(scalarRow, 'firstName')
  const lastName = v(scalarRow, 'lastName')
  const label = v(scalarRow, 'label')
  const fullName = firstName && lastName ? `${lastName} ${firstName}` : label

  // Multiple rows per adherence (one per denominazione the group ever had);
  // pick the row with the most recent denomInizio that's <= adherence
  // start. We've ORDER BY DESC(?denomInizio) so the first row per bnode is
  // the candidate.
  const perAdherence = new Map<
    string,
    { gruppo: string; dal: string | null; al: string | null }
  >()
  for (const g of groupRows) {
    const bn = v(g, 'bn') ?? ''
    if (perAdherence.has(bn)) continue
    const adStart = v(g, 'inizio')
    const denomStart = v(g, 'denomInizio')
    // Skip rows where the denomination clearly post-dates the adherence
    // (the group was renamed AFTER this senator joined). Keep looking
    // for an earlier denomination that was valid at adherence start.
    if (adStart && denomStart && denomStart > adStart) continue
    perAdherence.set(bn, {
      gruppo: v(g, 'titolo') ?? v(g, 'titoloBreve') ?? '',
      dal: adStart,
      al: v(g, 'fine'),
    })
  }
  const gruppoStorico = Array.from(perAdherence.values())
  gruppoStorico.sort((a, b) => (b.dal ?? '').localeCompare(a.dal ?? ''))
  const gruppoAttuale = gruppoStorico[0]?.gruppo || null

  const ruoloHint = groupRows
    .map((g) => v(g, 'carica'))
    .find((r): r is string => Boolean(r && r !== 'Membro'))
  const uffici = ruoloHint
    ? [{ ruolo: ruoloHint, organo: gruppoAttuale ?? '', dal: null, al: null }]
    : []

  const snapshot: DeputatoSnapshot = {
    slug: `senato-id-${idPersona}`,
    chamber: 'senato',
    id_ufficiale: String(idPersona),
    nome: fullName,
    gruppo_attuale: gruppoAttuale,
    gruppo_storico: gruppoStorico,
    data_nascita: v(scalarRow, 'dataNascita'),
    comune_nascita: v(scalarRow, 'cittaNascita'),
    // The senate ontology does not expose the electoral region cleanly:
    // senators are elected per-region rather than per-circoscrizione, and
    // the region information sits behind the election-event resource we
    // haven't walked here. Leave null rather than mis-mapping to the
    // birth province.
    circoscrizione: null,
    collegio: null,
    lista_elezione: null,
    data_proclamazione: v(scalarRow, 'mInizio'),
    formazione: null,
    uffici,
    organi: [],
    legislature: [roman],
    source_url: `https://dati.senato.it/senatore/${idPersona}`,
    scrape_status: fullName ? 'ok' : 'parse_error',
  }
  return snapshot
}
