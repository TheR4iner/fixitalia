import type { BrowserContext } from 'playwright'
import { XMLParser } from 'fast-xml-parser'
import { RecordId, DateTime } from 'surrealdb'

import { runQuery } from '../../query.ts'
import { cleanString } from '../../parse.ts'
import { shortenTitle, slugify } from './parseHelpers.ts'
import { SenatoBlockError } from './senatoBrowser.ts'
import { senatoThrottle } from './senatoThrottle.ts'
import {
  persistCommissioneBody,
  type ParsedBody,
  type ParsedIntervento,
  type ParsedOdg,
} from './commissioniPersist.ts'

// -----------------------------------------------------------------------------
// Senato della Repubblica -- committee resoconto sommario, body pass.
//
// Source format is Akoma Ntoso (the OASIS standard for legislative documents),
// exported at /leg/{leg}/BGT/Testi/SommComm/{id}.akn. It is strictly better
// than scraping the show-doc HTML:
//
//   <an:debateSection name="..."><an:heading>...   -> agenda item
//   <an:speech by="#p29110" as="#senatore">        -> speaker turn, with the
//     <an:p>...</an:p>                                senator's numeric id
//   <an:TLCPerson id="p29110"                      -> id table in the metadata
//       href=".../Persona/29110" showAs="GRASSO"/>
//
// so the section nesting and the speaker identity come from the source rather
// than being inferred from presentation markup. The `Persona/{id}` value is
// the same numeric senator id the rest of this codebase already keys
// parlamento_persona on, so committee speeches join straight into the existing
// person model.
//
// IMPORTANT SEMANTIC LIMIT: a sommario is a THIRD-PERSON SUMMARY, not a
// verbatim transcript. Its sentences read "Pone domande all'audito il senatore
// GRASSO (Misto-LeU-Eco), al quale risponde il professor CLINI." -- the
// secretariat's paraphrase, not words the speaker said. Rows written here
// carry tipo_resoconto = 'sommario' so the reader can label them, and they
// must never be presented as quotations. Senato's verbatim committee
// resoconti exist only as PDF; see project-kb/Parlamento commissioni.md.
// -----------------------------------------------------------------------------

export interface IngestSenatoCommissioneResult {
  chamber: 'senato'
  scope: string
  odg_n: number
  interventi_n: number
  durationMs: number
  status: 'ok' | 'partial' | 'empty' | 'error'
  error?: string
}

interface SedutaRow {
  id: RecordId<'parlamento_sedute'>
  chamber: 'senato'
  legislatura: number
  numero: number
  data: DateTime
  html_url: string
}

// ---------------------------------------------------------------------------
// fast-xml-parser in preserveOrder mode returns a tree of single-key objects:
//   { 'an:speech': [ ...children ], ':@': { '@_by': '#p29110' } }
// with text as { '#text': '...' }. Order matters here (a speech is mixed
// content: text interleaved with <an:ref> and <an:i>), which is exactly why
// preserveOrder is on and why these accessors exist.
// ---------------------------------------------------------------------------

type XmlNode = Record<string, unknown>

const ATTR_KEY = ':@'

function tagOf(node: XmlNode): string | null {
  for (const k of Object.keys(node)) {
    if (k !== ATTR_KEY) return k
  }
  return null
}

function childrenOf(node: XmlNode): XmlNode[] {
  const tag = tagOf(node)
  if (!tag) return []
  const v = node[tag]
  return Array.isArray(v) ? (v as XmlNode[]) : []
}

function attrsOf(node: XmlNode): Record<string, string> {
  const a = node[ATTR_KEY]
  return (a as Record<string, string>) ?? {}
}

/** Flatten a subtree to plain text. `an:eol` marks an explicit line break. */
function textOf(nodes: XmlNode[]): string {
  let out = ''
  for (const n of nodes) {
    const tag = tagOf(n)
    if (tag === '#text') {
      out += String(n['#text'] ?? '')
      continue
    }
    if (tag === 'an:eol') {
      out += '\n'
      continue
    }
    if (tag) out += textOf(childrenOf(n))
  }
  return out
}

/** Depth-first search for the first descendant with the given tag. */
function findFirst(nodes: XmlNode[], tag: string): XmlNode | null {
  for (const n of nodes) {
    if (tagOf(n) === tag) return n
    const hit = findFirst(childrenOf(n), tag)
    if (hit) return hit
  }
  return null
}

/** Collect every descendant with the given tag, in document order. */
function findAll(nodes: XmlNode[], tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const n of nodes) {
    if (tagOf(n) === tag) out.push(n)
    findAll(childrenOf(n), tag, out)
  }
  return out
}

interface PersonRef {
  /** The chamber's numeric person id, from the dati.senato.it URI. */
  idPersona: string | null
  showAs: string | null
}

/**
 * Build the `#pNNNN` -> person map from the document's TLCPerson table.
 * `href` is a dati.senato.it/osr/Persona/{id} URI whose trailing segment is
 * the same numeric id parlamento_persona uses for senators.
 */
function buildPersonTable(root: XmlNode[]): Map<string, PersonRef> {
  const table = new Map<string, PersonRef>()
  for (const p of findAll(root, 'an:TLCPerson')) {
    const a = attrsOf(p)
    const id = a['@_id']
    if (!id) continue
    const href = a['@_href'] ?? ''
    const m = href.match(/Persona\/(\d+)/i)
    table.set(id, { idPersona: m ? m[1] : null, showAs: a['@_showAs'] ?? null })
  }
  return table
}

/**
 * Pull the parliamentary group out of a speech body.
 *
 * The summary names the speaker then parenthesises their group:
 * `<an:ref href="#p29110">GRASSO</an:ref> (<an:i>Misto-LeU-Eco</an:i>)`. Only
 * the italic run that follows a reference to THIS speech's own speaker counts
 * -- other names in the same sentence carry their own groups.
 */
function findGruppo(nodes: XmlNode[], byId: string | null): string | null {
  if (!byId) return null
  let sawOwnRef = false
  const walk = (list: XmlNode[]): string | null => {
    for (const n of list) {
      const tag = tagOf(n)
      if (tag === 'an:ref') {
        sawOwnRef = attrsOf(n)['@_href'] === byId
        continue
      }
      if (tag === 'an:i' && sawOwnRef) {
        const t = cleanString(textOf(childrenOf(n)))
        if (t) return t
        sawOwnRef = false
        continue
      }
      if (tag === '#text') {
        // Anything other than the opening parenthesis between the name and
        // the italics means the italics belong to something else.
        if (!/^[\s(]*$/.test(String(n['#text'] ?? ''))) sawOwnRef = false
        continue
      }
      const inner = walk(childrenOf(n))
      if (inner) return inner
    }
    return null
  }
  return walk(nodes)
}

export function parseSenatoCommissioneAkn(xml: string): ParsedBody {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    trimValues: false,
    processEntities: true,
  })
  const root = parser.parse(xml) as XmlNode[]

  const persons = buildPersonTable(root)
  const odg: ParsedOdg[] = []
  const interventi: ParsedIntervento[] = []
  let currentOdg = 0

  // Walk sections in document order. Sections nest (a heading can contain
  // sub-headings), and each one that carries a heading becomes its own agenda
  // entry, so the OdG list reads as a flat outline in reading order -- the
  // same shape the Camera side produces from <p class="titolo">.
  const visitSection = (section: XmlNode) => {
    const kids = childrenOf(section)
    const headingNode = kids.find((k) => tagOf(k) === 'an:heading')
    const rawHeading = headingNode ? cleanString(textOf(childrenOf(headingNode))) : null

    // An agenda item is a section that carries a non-empty <an:heading>.
    // Two kinds of section legitimately lack one:
    //   - "InizioSeduta" / "FineSeduta", which wrap the opening and closing
    //     bell. Promoting their `name` attribute would put "InizioSeduta" in
    //     the reader's agenda list.
    //   - a nested section with an EMPTY <an:heading>, which is the source
    //     saying "still the parent item". Its speeches correctly inherit the
    //     parent's position.
    // A section with no heading element at all AND its own speeches is
    // neither, so say so rather than silently filing them under whatever came
    // before. Direct children only: a descending search would also count
    // speeches belonging to nested sections, which the recursion handles.
    if (!headingNode && kids.some((k) => tagOf(k) === 'an:speech')) {
      console.warn(
        `[ingest:parlamento:senato-commissioni] headingless section ` +
          `"${attrsOf(section)['@_name'] ?? '?'}" contains speeches -- they will be ` +
          `attributed to the preceding agenda item`,
      )
    }
    if (rawHeading) {
      currentOdg += 1
      const titolo = shortenTitle(rawHeading)
      odg.push({
        posizione: currentOdg,
        titolo,
        anchor: `odg-${currentOdg}-${slugify(titolo).slice(0, 32)}`,
      })
    }

    for (const kid of kids) {
      const tag = tagOf(kid)
      if (tag === 'an:debateSection') {
        visitSection(kid)
        continue
      }
      if (tag === 'an:speech') {
        const by = attrsOf(kid)['@_by'] ?? null
        const person = by ? persons.get(by.replace(/^#/, '')) ?? null : null
        const paragraphs: string[] = []
        for (const p of findAll(childrenOf(kid), 'an:p')) {
          const t = cleanString(textOf(childrenOf(p)))
          if (t) paragraphs.push(t)
        }
        if (paragraphs.length === 0) continue
        interventi.push({
          posizione: interventi.length + 1,
          odgPosition: currentOdg,
          oratoreNome: person?.showAs ?? null,
          idPersona: person?.idPersona ?? null,
          gruppo: findGruppo(childrenOf(kid), by),
          ruolo: null,
          paragraphs,
        })
        continue
      }
      if (tag === 'an:narrative') {
        // Stage directions ("La seduta inizia alle ore 14,05"). Attach to the
        // preceding turn so the reader keeps them in place; drop them when
        // nothing precedes, since the reader renders sitting times from
        // metadata anyway.
        const t = cleanString(textOf(childrenOf(kid)))
        const last = interventi.at(-1)
        if (t && last) last.paragraphs.push(t)
      }
    }
  }

  const debate = findFirst(root, 'an:debate')
  const container = (debate ? findFirst(childrenOf(debate), 'an:debateBody') : null) ?? debate
  const containerKids = container ? childrenOf(container) : []
  // Only the OUTERMOST sections are seeded: visitSection recurses into nested
  // ones itself, so handing it the result of a descending search would visit
  // every nested section twice and duplicate its speeches.
  const topLevel = containerKids.filter((n) => tagOf(n) === 'an:debateSection')
  for (const s of topLevel) visitSection(s)

  return { odg, interventi }
}

async function loadSeduta(scope: string): Promise<SedutaRow | null> {
  const rows = await runQuery<SedutaRow[]>(
    `SELECT id, chamber, legislatura, numero, data, html_url FROM $id LIMIT 1;`,
    { id: new RecordId('parlamento_sedute', scope) },
  )
  return rows?.[0] ?? null
}

/**
 * Fetch the Akoma Ntoso export through the WAF-warmed browser context.
 *
 * `context.request` reuses the context's cookie jar, so once any navigation
 * has solved the AWS WAF challenge this is a plain HTTP GET carrying the
 * `aws-waf-token` -- much cheaper than a full page navigation per document.
 */
async function fetchAkn(context: BrowserContext, url: string): Promise<string> {
  // Throttle explicitly. navigateWithWaf() does this for page navigations, but
  // this path deliberately skips navigation for speed, so without the call
  // here the body pass would fetch as fast as the network allows and walk
  // straight into a WAF ban.
  await senatoThrottle()
  const res = await context.request.get(url, { timeout: 60_000 })
  const body = await res.text()
  if (res.status() === 202 || (res.status() === 200 && body.trim() === '')) {
    // 202 with an empty body is the WAF challenge, i.e. the token went stale.
    throw new SenatoBlockError(url)
  }
  if (!res.ok()) {
    throw new Error(`Senato AKN fetch failed: HTTP ${res.status()} on ${url}`)
  }
  if (!body.includes('akomaNtoso')) {
    throw new Error(`Senato AKN fetch returned non-AKN content for ${url}`)
  }
  return body
}

export async function ingestSenatoCommissioneSession(
  context: BrowserContext,
  scope: string,
): Promise<IngestSenatoCommissioneResult> {
  const started = Date.now()
  const seduta = await loadSeduta(scope)
  if (!seduta) {
    return {
      chamber: 'senato',
      scope,
      odg_n: 0,
      interventi_n: 0,
      durationMs: Date.now() - started,
      status: 'error',
      error: `sitting ${scope} not in parlamento_sedute -- run the committee index pass first`,
    }
  }

  const xml = await fetchAkn(context, seduta.html_url)
  const parsed = parseSenatoCommissioneAkn(xml)
  const label = `senato-commissione/${seduta.legislatura}/${scope}`
  const result = await persistCommissioneBody(
    {
      id: seduta.id,
      chamber: 'senato',
      legislatura: seduta.legislatura,
      numero: seduta.numero,
      data: seduta.data,
      idScope: scope,
    },
    parsed,
    label,
  )

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:senato-commissioni] ${label} -> ${result.odg_n} odg, ` +
      `${result.interventi_n} interventi, ${result.refs_n} refs (${result.status}) in ${durationMs} ms`,
  )

  return {
    chamber: 'senato',
    scope,
    odg_n: result.odg_n,
    interventi_n: result.interventi_n,
    durationMs,
    status: result.status,
  }
}
