// Scrape biographical / institutional data from the official Camera deputy
// page (https://www.camera.it/deputati/elenco/{leg}-{id}/). Used to populate
// the ID-card section on the OratorePage.
//
// Lazy + cached: the API endpoint only invokes this when nobody has fetched
// a given deputy's profile in the last 7 days. The page format is stable
// enough that a parser this defensive is unlikely to break, but if it does
// we fall back to scrape_status="parse_error" + whatever fields we managed
// to pull, and the UI degrades to showing what's there plus the official
// link for the rest.

import { fetchWithRetry } from './parseHelpers.ts'

export interface DeputatoSnapshot {
  slug: string
  // Snapshot-level tag for the chamber. cameraDeputatiBulk destructures
  // this out before MERGE, so a senate-side scraper can reuse the shape
  // with `chamber: 'senato'` without leaking the wrong value onto the
  // mandato row.
  chamber: 'camera' | 'senato'
  id_ufficiale: string
  nome: string | null
  gruppo_attuale: string | null
  gruppo_storico: Array<{ gruppo: string; dal: string | null; al: string | null }>
  data_nascita: string | null
  comune_nascita: string | null
  circoscrizione: string | null
  collegio: string | null
  lista_elezione: string | null
  data_proclamazione: string | null
  formazione: string | null
  uffici: Array<{ ruolo: string | null; organo: string; dal: string | null; al: string | null }>
  organi: Array<{ organo: string; dal: string | null; al: string | null }>
  legislature: string[]
  source_url: string
  scrape_status: 'ok' | 'parse_error'
}

// Slug pattern is `camera-id-{numeric_id}` -- enforced by cameraSession.ts
// when the speaker carries an `idPersona` attribute on its scheda link.
const CAMERA_ID_RE = /^camera-id-(\d+)$/

export function deputyIdFromSlug(slug: string): string | null {
  const m = slug.match(CAMERA_ID_RE)
  return m ? m[1] : null
}

export function deputyOfficialUrl(legislatura: number, id: string): string {
  return `https://www.camera.it/deputati/elenco/${legislatura}-${id}/`
}

/**
 * Strip script/style tags, then collapse the body to a single space-separated
 * string while preserving meaningful line breaks at block boundaries. This
 * gives us a clean substrate for the label-then-value regex extractors that
 * follow, without needing a real DOM walker.
 */
function htmlToCleanText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    // Normalise block boundaries to newlines so "label\nvalue" pairs survive.
    .replace(/<\/(div|p|li|tr|td|h[1-6]|dt|dd|span|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    // Numeric entities cover both &#39; and &#039; (zero-padded). Camera
    // pages use the padded form for apostrophes inside group names like
    // "Fratelli d&#039;Italia"; without this, the literal ends up in the DB.
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * Find the value following a label. The Camera page uses the pattern:
 *   LABEL_IN_UPPERCASE\nvalue text\n...
 * We grab the next 1-2 lines after the label, joined.
 */
function extractAfterLabel(text: string, label: string, maxLines = 1): string | null {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].toUpperCase() === label) {
      const tail = lines
        .slice(i + 1, i + 1 + maxLines)
        .map((l) => l.trim())
        .filter((l) => l && l.toUpperCase() !== l) // stop at next ALL-CAPS label
      if (tail.length === 0) {
        // Fallback: take exactly the next non-empty line, even if uppercase
        const next = lines[i + 1]?.trim()
        return next || null
      }
      return tail.join(' ')
    }
  }
  return null
}

/**
 * Parse a "section" of the page that lists time-bounded memberships.
 * Returns rows like { item: "IV COMMISSIONE (DIFESA)", dal: "11 Ottobre 2024", al: null }.
 *
 * The page renders these as repeated [name]\n"dal DATE [al DATE]" pairs after
 * a section heading. We capture every pair after the heading until the next
 * uppercase heading.
 */
function extractTimedSection(text: string, heading: string): Array<{ item: string; dal: string | null; al: string | null }> {
  const lines = text.split('\n')
  const out: Array<{ item: string; dal: string | null; al: string | null }> = []
  let inSection = false
  let pendingItem: string | null = null
  for (const line of lines) {
    const upper = line.toUpperCase()
    if (upper === heading) {
      inSection = true
      continue
    }
    if (!inSection) continue
    // End of section: we hit another section heading (all-caps section name)
    if (
      line === upper &&
      line.length > 4 &&
      !line.startsWith('DAL ') &&
      !line.startsWith('AL ') &&
      heading !== upper &&
      // Common Camera section headings
      /^(GRUPPO|UFFICI|COMPONENTE|DICHIARAZIONI|DOCUMENTAZIONE|FINE|NAVIGAZIONE)/i.test(line)
    ) {
      if (pendingItem) {
        out.push({ item: pendingItem, dal: null, al: null })
        pendingItem = null
      }
      inSection = false
      continue
    }
    const dalMatch = line.match(/^dal\s+(.+?)(?:\s+al\s+(.+))?$/i)
    if (dalMatch) {
      if (pendingItem) {
        out.push({
          item: pendingItem,
          dal: dalMatch[1]?.trim() || null,
          al: dalMatch[2]?.trim() || null,
        })
        pendingItem = null
      }
      continue
    }
    // Otherwise this line is a new item name
    if (pendingItem) {
      // Two consecutive non-"dal" lines: flush the previous one with no dates
      out.push({ item: pendingItem, dal: null, al: null })
    }
    pendingItem = line
  }
  if (pendingItem && inSection) {
    out.push({ item: pendingItem, dal: null, al: null })
  }
  return out
}

const MONTHS_IT: Record<string, string> = {
  gennaio: '01', febbraio: '02', marzo: '03', aprile: '04',
  maggio: '05', giugno: '06', luglio: '07', agosto: '08',
  settembre: '09', ottobre: '10', novembre: '11', dicembre: '12',
}

/**
 * Convert "28 Luglio 1968" -> "1968-07-28". Returns the original on failure
 * so the UI can still display a sensible string even if parsing fails.
 */
function italianDateToISO(value: string | null): string | null {
  if (!value) return null
  const m = value.toLowerCase().match(/(\d{1,2})\s+([a-zà-ù]+)\s+(\d{4})/)
  if (!m) return value
  const day = m[1].padStart(2, '0')
  const month = MONTHS_IT[m[2]]
  const year = m[3]
  if (!month) return value
  return `${year}-${month}-${day}`
}

export async function scrapeCameraDeputato(
  slug: string,
  legislatura: number = 19,
): Promise<DeputatoSnapshot | null> {
  const id = deputyIdFromSlug(slug)
  if (!id) return null
  const url = deputyOfficialUrl(legislatura, id)
  let html: string
  try {
    const res = await fetchWithRetry(url, { timeoutMs: 30_000, attempts: 3 })
    if (!res.ok) {
      // 404 means the deputy ID doesn't correspond to a real page (could be
      // a senator misclassified or the legislature is wrong). Bubble up so
      // the API surfaces a "no profile" rather than crashing.
      throw new Error(`Camera deputato fetch failed: HTTP ${res.status} for ${url}`)
    }
    html = await res.text()
  } catch (err) {
    console.warn(
      `[scraper:camera-deputato] fetch failed for ${slug}:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }

  const text = htmlToCleanText(html)

  // Name: first ALL-CAPS line after the page header, often "ETTORE ROSATO".
  // The inner separator MUST be ` +` (literal space), not `\s+` -- whitespace
  // metaclasses include newlines, which let the capture group span across line
  // breaks and pick up the next ALL-CAPS line (e.g. the role label "DEPUTATO"
  // that sits one line below the name). Manifested as nome="VITTORIO SGARBI\nDEPUTATO"
  // for a handful of leg-19 rows before this fix.
  const nameMatch = text.match(/\n([A-ZÀ-Ù]{2,}(?: +[A-ZÀ-Ù'-]{2,})+)\n/)
  const nome = nameMatch ? nameMatch[1].trim() : null

  // Group history: the section under "GRUPPO PARLAMENTARE" lists current
  // group at top, then prior groups with their dal/al spans.
  const gruppoSection = extractTimedSection(text, 'GRUPPO PARLAMENTARE')
  const gruppoAttuale = gruppoSection[0]?.item ?? null
  const gruppoStorico = gruppoSection.map((g) => ({
    gruppo: g.item,
    dal: italianDateToISO(g.dal),
    al: italianDateToISO(g.al),
  }))

  const ufficiSection = extractTimedSection(text, 'UFFICI PARLAMENTARI')
  const uffici = ufficiSection.map((u) => {
    // Format is typically "<RUOLO> - <ORGANO>" all uppercase
    const split = u.item.split(/\s+-\s+/, 2)
    const ruolo = split.length === 2 ? split[0] : null
    const organo = split.length === 2 ? split[1] : u.item
    return { ruolo, organo, dal: italianDateToISO(u.dal), al: italianDateToISO(u.al) }
  })

  const organiSection = extractTimedSection(text, 'COMPONENTE DEGLI ORGANI PARLAMENTARI')
  const organi = organiSection.map((o) => ({
    organo: o.item,
    dal: italianDateToISO(o.dal),
    al: italianDateToISO(o.al),
  }))

  // Legislature row (after "DEPUTATO NELLE LEGISLATURE:") is a sequence of
  // Roman numerals separated by spaces.
  const legislatureLine = extractAfterLabel(text, 'DEPUTATO NELLE LEGISLATURE:', 1)
  const legislature = legislatureLine
    ? legislatureLine.split(/\s+/).filter((tok) => /^[IVXLC]+$/.test(tok))
    : []

  const snapshot: DeputatoSnapshot = {
    slug,
    chamber: 'camera',
    id_ufficiale: id,
    nome,
    gruppo_attuale: gruppoAttuale,
    gruppo_storico: gruppoStorico,
    data_nascita: italianDateToISO(extractAfterLabel(text, 'DATA DI NASCITA')),
    comune_nascita: extractAfterLabel(text, 'COMUNE DI NASCITA'),
    circoscrizione: extractAfterLabel(text, 'CIRCOSCRIZIONE DI ELEZIONE'),
    collegio: extractAfterLabel(text, 'COLLEGIO DI ELEZIONE'),
    lista_elezione: extractAfterLabel(text, 'LISTA DI ELEZIONE'),
    data_proclamazione: italianDateToISO(extractAfterLabel(text, 'PROCLAMAZIONE')),
    formazione: extractAfterLabel(text, 'FORMAZIONE O NOTE PROFESSIONALI', 3),
    uffici,
    organi,
    legislature,
    source_url: url,
    scrape_status: nome ? 'ok' : 'parse_error',
  }
  return snapshot
}
