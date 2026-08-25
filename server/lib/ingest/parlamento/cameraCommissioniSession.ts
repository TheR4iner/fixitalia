import { parseHTML } from 'linkedom'
import { RecordId, DateTime } from 'surrealdb'

import { runQuery } from '../../query.ts'
import { cleanString } from '../../parse.ts'
import { fetchWithRetry, shortenTitle, slugify } from './parseHelpers.ts'
import {
  persistCommissioneBody,
  type ParsedBody,
  type ParsedIntervento,
  type ParsedOdg,
} from './commissioniPersist.ts'

// -----------------------------------------------------------------------------
// Camera dei Deputati -- committee stenographic transcript, body pass.
//
// The markup is a close cousin of the assembly stenografico, but three
// differences make the assembly parser (cameraSession.ts) wrong here rather
// than merely suboptimal:
//
//  1. PARAGRAPHS. On the floor, each paragraph of a speech is its own sibling
//     `<p class="interventoVirtuale">`. In committee the WHOLE speech is one
//     `<p class="intervento">` with `<br />` separators. A parser that keys on
//     sibling paragraphs collapses a 12-paragraph committee speech into one
//     unbroken block, destroying the paragraph structure `testo` is specified
//     to preserve (schema.ts: breaks are encoded as a blank line).
//
//  2. NON-PARLIAMENTARIAN SPEAKERS. Committee transcripts are full of people
//     who are not deputies -- auditees, consultants, agency officials -- and
//     they appear as a bare `<a>NAME</a>` with NO href, because they have no
//     deputy profile to link to. The assembly parser selects the speaker with
//     `a[href*="idPersona"]`, so for those turns it finds no speaker at all
//     and folds the name into the body text. Since audizioni exist precisely
//     to hear those people, that is the worst possible thing to drop.
//
//  3. INLINE PAGE MARKERS. `<span class="numeroPagina">Pag. 4</span>` sits
//     INSIDE the speech text (the assembly puts page numbers in their own
//     `<p>`), so a naive textContent read splices "Pag. 4" into the middle of
//     a sentence.
//
// Everything after parsing -- OdG rows, intervento rows, speaker mandates,
// references, Meilisearch -- is shared with the Senato committee ingest and
// lives in commissioniPersist.ts.
// -----------------------------------------------------------------------------

export interface IngestCommissioneSessionResult {
  chamber: 'camera'
  scope: string
  odg_n: number
  interventi_n: number
  durationMs: number
  status: 'ok' | 'partial' | 'empty' | 'error' | 'missing'
  error?: string
}

interface SedutaRow {
  id: RecordId<'parlamento_sedute'>
  chamber: 'camera'
  legislatura: number
  numero: number
  data: DateTime
  html_url: string
  organo_nome?: string
}

/**
 * Longest string still plausible as a speaker qualification. Anything longer
 * is treated as ordinary speech, so a sentence that merely happens to start
 * with a comma cannot swallow a paragraph into the `ruolo` column.
 */
const MAX_ROLE_LEN = 160

/**
 * Split the attribution off the start of a speech.
 *
 * Committee transcripts write the attribution in exactly two shapes:
 *
 *   <a>NAME</a>. Body starts here.
 *   <a>NAME</a>, qualification. Body starts here.
 *
 * so the role, when present, is delimited by the leading comma and the first
 * sentence break. Parsing it from the text is more robust than reading the
 * `<em>` that usually wraps it: the source splits a single qualification
 * across several `<em>` runs whenever it contains nested emphasis -- e.g.
 * `<em>rappresentante della Camera di commercio italo-germanica (</em>AHK
 * Italien<em>)</em>` -- so element-based detection captures a fragment and
 * leaves the rest stranded at the head of the speech. It also cannot be fooled
 * by the first ordinary `<em>` inside the speech (`la <em>web-tv</em> della
 * Camera`), which element adjacency reads as a role because only text sits
 * between it and the name.
 */
export function splitAttribution(raw: string): { ruolo: string | null; body: string } {
  const text = raw.replace(/^\s+/, '')
  if (text.startsWith('.')) {
    return { ruolo: null, body: text.replace(/^\.\s*/, '') }
  }
  if (text.startsWith(',')) {
    const rest = text.slice(1).replace(/^\s+/, '')
    const m = rest.match(/^(.*?)\.(\s|$)/s)
    if (m && m[1].length > 0 && m[1].length <= MAX_ROLE_LEN) {
      return { ruolo: m[1].trim(), body: rest.slice(m[0].length).replace(/^\s+/, '') }
    }
    return { ruolo: null, body: rest }
  }
  return { ruolo: null, body: text }
}

/**
 * Turn one `<p class="intervento">` into ordered plain-text paragraphs,
 * splitting on `<br>` and dropping the speaker's own name and inline page
 * markers.
 *
 * Walks child nodes rather than reading textContent because the `<br>`
 * boundaries -- the only paragraph structure the source gives us -- exist
 * solely in the node tree. The attribution that follows the name is left in
 * place for splitAttribution() to handle.
 */
function extractParagraphs(p: Element, speakerAnchor: Element | null): string[] {
  const paragraphs: string[] = []
  let buf = ''

  const flush = () => {
    const t = cleanString(buf)
    if (t) paragraphs.push(t)
    buf = ''
  }

  const walk = (node: Node) => {
    if (node.nodeType === 1) {
      const el = node as Element
      if (el.nodeName.toLowerCase() === 'br') {
        flush()
        return
      }
      if (el === speakerAnchor) return
      // Page markers ("Pag. 4") are printing artefacts, not speech, and they
      // sit INSIDE the sentence they interrupt.
      if (el.classList?.contains?.('numeroPagina')) return
      for (const child of Array.from(el.childNodes)) walk(child)
      return
    }
    if (node.nodeType === 3) buf += node.nodeValue ?? ''
  }

  for (const child of Array.from(p.childNodes)) walk(child)
  flush()
  return paragraphs
}

/**
 * Read the speaker off an intervento paragraph.
 *
 * `idPersona` is present only for parliamentarians. Committee transcripts are
 * full of speakers who have none -- auditees, consultants, agency officials --
 * and they appear as a bare `<a>NAME</a>` with no href at all. Selecting the
 * first anchor regardless of href is what keeps them.
 *
 * The display name prefers the `title="Vai alla scheda personale: SURNAME
 * Given"` attribute, because the visible link text is frequently just the role
 * ("PRESIDENTE") and the title is the only place the human is named.
 */
function readSpeaker(p: Element): {
  anchor: Element | null
  nome: string | null
  idPersona: string | null
} {
  const anchor = p.querySelector('a')
  const linkText = cleanString(anchor?.textContent ?? '') || null
  const href = anchor?.getAttribute('href') ?? ''
  const title = anchor?.getAttribute('title') ?? ''

  const idMatch = href.match(/[?&]idPersona=(\d+)/i)
  const titleMatch = title.match(/scheda\s+personale:\s*(.+)$/i)
  const surnameFirst = titleMatch ? cleanString(titleMatch[1]) : null

  return {
    anchor,
    nome: surnameFirst ?? linkText,
    idPersona: idMatch ? idMatch[1] : null,
  }
}

export function parseCameraCommissioneTranscript(html: string): ParsedBody {
  const { document } = parseHTML(html)
  const container =
    document.querySelector('#stenograficoCommissione') ??
    document.querySelector('#wrapper') ??
    document.body
  if (!container) return { odg: [], interventi: [] }

  const odg: ParsedOdg[] = []
  const interventi: ParsedIntervento[] = []
  let currentOdg = 0

  for (const p of Array.from(container.querySelectorAll('p'))) {
    const cl = p.classList

    if (cl.contains('titolo') || cl.contains('titolo_allegato')) {
      currentOdg += 1
      const raw =
        cleanString(p.querySelector('strong')?.textContent ?? p.textContent ?? '') ??
        `Argomento ${currentOdg}`
      const titolo = shortenTitle(raw)
      odg.push({
        posizione: currentOdg,
        titolo,
        anchor: `odg-${currentOdg}-${slugify(titolo).slice(0, 32)}`,
      })
      continue
    }

    if (cl.contains('intervento')) {
      const { anchor, nome, idPersona } = readSpeaker(p)
      const paragraphs = extractParagraphs(p, anchor)
      if (paragraphs.length === 0) continue
      // The attribution lives at the head of the first paragraph only.
      const { ruolo, body } = splitAttribution(paragraphs[0])
      if (body) paragraphs[0] = body
      else paragraphs.shift()
      if (paragraphs.length === 0) continue
      interventi.push({
        posizione: interventi.length + 1,
        odgPosition: currentOdg,
        oratoreNome: nome,
        idPersona,
        gruppo: null,
        // Fall back to the paragraph's own title attribute, which carries the
        // qualification for some sittings even when the inline text does not.
        ruolo: ruolo ?? (cleanString(p.getAttribute('title') ?? '') || null),
        paragraphs,
      })
      continue
    }

    // `presidenza` (who chaired) and `avviso` ("La seduta comincia alle 12")
    // are context rather than speech. They attach to the preceding turn when
    // there is one so the reader keeps them in place, and are dropped when
    // they precede the first turn (the reader shows that from metadata).
    if (cl.contains('presidenza') || cl.contains('avviso') || cl.contains('sottotitolo')) {
      const t = cleanString(p.textContent ?? '')
      const last = interventi.at(-1)
      if (t && last) last.paragraphs.push(t)
      continue
    }
  }

  return { odg, interventi }
}

async function loadSeduta(scope: string): Promise<SedutaRow | null> {
  const rows = await runQuery<SedutaRow[]>(
    `SELECT id, chamber, legislatura, numero, data, html_url, organo_nome
     FROM $id LIMIT 1;`,
    { id: new RecordId('parlamento_sedute', scope) },
  )
  return rows?.[0] ?? null
}

export async function ingestCameraCommissioneSession(
  scope: string,
): Promise<IngestCommissioneSessionResult> {
  const started = Date.now()
  const seduta = await loadSeduta(scope)
  if (!seduta) {
    return {
      chamber: 'camera',
      scope,
      odg_n: 0,
      interventi_n: 0,
      durationMs: Date.now() - started,
      status: 'error',
      error: `sitting ${scope} not in parlamento_sedute -- run the committee index pass first`,
    }
  }

  const res = await fetchWithRetry(seduta.html_url, {
    timeoutMs: 45_000,
    attempts: 3,
    passthroughStatuses: [404],
  })
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    // The monthly listing advertises documents the document service itself
    // cannot serve: the parameterised URL 302s to exactly the static path we
    // compose, and that path 404s. So this is an upstream inconsistency, not a
    // URL-construction bug on our side (verified against leg-19 05c05/audiz1).
    //
    // Recorded as "missing" rather than "error" so the daily body pass stops
    // re-requesting a document that upstream does not publish -- otherwise
    // every run would burn requests on the same permanent gaps and keep a
    // non-zero error count that hides real regressions. `--refresh` ignores
    // status entirely, so a document that later appears is still recoverable.
    await runQuery(
      `UPDATE $id SET body_status = "missing", body_error = $err,
         interventi_n = 0, odg_n = 0;`,
      {
        id: seduta.id,
        err: `not published upstream: HTTP 404 on ${seduta.html_url}`.slice(0, 1000),
      },
    )
    return {
      chamber: 'camera',
      scope,
      odg_n: 0,
      interventi_n: 0,
      durationMs: Date.now() - started,
      status: 'missing',
    }
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(
      `Camera committee transcript fetch failed: HTTP ${res.status} on ${seduta.html_url}`,
    )
  }
  const html = await res.text()

  const parsed = parseCameraCommissioneTranscript(html)
  const label = `camera-commissione/${seduta.legislatura}/${scope}`
  const result = await persistCommissioneBody(
    {
      id: seduta.id,
      chamber: 'camera',
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
    `[ingest:parlamento:camera-commissioni] ${label} -> ${result.odg_n} odg, ` +
      `${result.interventi_n} interventi, ${result.refs_n} refs (${result.status}) in ${durationMs} ms`,
  )

  return {
    chamber: 'camera',
    scope,
    odg_n: result.odg_n,
    interventi_n: result.interventi_n,
    durationMs,
    status: result.status,
  }
}
