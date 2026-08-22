/// <reference lib="dom" />
import type { BrowserContext } from 'playwright'

import { CURRENT_LEGISLATURE } from './constants.ts'
import { navigateWithWaf, SenatoBlockError } from './senatoBrowser.ts'

// -----------------------------------------------------------------------------
// Scrape the Senato chronological listing pages to recover the real show-doc
// URLs for every assembly session.
//
// Critical detail: the SPARQL LOD endpoint exposes 5-digit `sedutaassemblea/<ID>`
// identifiers, but the live show-doc backend on www.senato.it uses a completely
// different 7-digit ID space. Every show-doc URL we built from SPARQL returns
// HTTP 500 ("ErrorPage_ShowDOC"). The 7-digit IDs only exist in the listing
// page's anchor tags, so we have to scrape them.
//
// Listing URL: /lavori/assemblea/resoconti-elenco-cronologico?leg=N&anno=Y
// One page per year. The page renders ~one row per seduta with columns:
//   weekday, date (DD MMMM YYYY in Italian), numero, "html" link, "pdf" link.
// We pluck the "html" anchor's href and pair it with the numero+date from the
// surrounding row text.
// -----------------------------------------------------------------------------

const MONTHS_IT: Record<string, number> = {
  gennaio: 1,
  febbraio: 2,
  marzo: 3,
  aprile: 4,
  maggio: 5,
  giugno: 6,
  luglio: 7,
  agosto: 8,
  settembre: 9,
  ottobre: 10,
  novembre: 11,
  dicembre: 12,
}

export interface ListedSeduta {
  numero: number
  /** ISO date string YYYY-MM-DD */
  data: string
  /** Full show-doc URL with `&part=doc_dc` so the body pass gets the complete document. */
  htmlUrl: string
  /** The 7-digit show-doc id, useful for diagnostics / re-construction. */
  docId: string
}

function parseItalianDate(s: string): string | null {
  // Examples: "Mercoledì 13 Maggio 2026", "Martedì 12 Maggio 2026"
  const m = s.toLowerCase().match(/(\d{1,2})\s+(\p{L}+)\s+(\d{4})/u)
  if (!m) return null
  const day = Number(m[1])
  const month = MONTHS_IT[m[2]]
  const year = Number(m[3])
  if (!month || !day || !year) return null
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

interface RawRow {
  href: string
  linkText: string
  rowText: string
}

// The currently-active legislature uses the bare path. Past legislatures use
// the /legislature/{N}/ prefix. The active-leg constant lives in
// constants.ts so a single edit covers every importer.

function listingUrl(leg: number, year: number): string {
  const base =
    leg === CURRENT_LEGISLATURE
      ? 'https://www.senato.it/lavori/assemblea/resoconti-elenco-cronologico'
      : `https://www.senato.it/legislature/${leg}/lavori/assemblea/resoconti-elenco-cronologico`
  // Senato's listing accepts ?year=YYYY -- and that is the only param needed.
  // The legislature is implied by the base path (current uses the bare path;
  // past legislatures use /legislature/{N}/). Verified via the year-selector
  // anchors on the page itself: they all link with ?year=YYYY only.
  // `?anno=YYYY` is silently ignored by the server and falls back to the
  // current year's listing — that bug was masked between 2026-05-16 and
  // 2026-05-16 by an unrelated WAF firewall block that returned zero rows.
  return `${base}?year=${year}`
}

async function scrapeYear(
  context: BrowserContext,
  leg: number,
  year: number,
): Promise<ListedSeduta[]> {
  const url = listingUrl(leg, year)
  const page = await navigateWithWaf(context, url)
  try {
    const rows = await page.evaluate(() => {
      const out: RawRow[] = []
      // The current legislature lists one seduta per row with separate "html"
      // and "pdf" links; historical legs list the resoconto as a single
      // "Seduta n. NNN" link (id is only 4-6 digits there). Capture every
      // Resaula show-doc anchor and disambiguate in Node where regexes are
      // easier to maintain.
      const anchors = Array.from(document.querySelectorAll('a')).filter((a) => {
        const h = a.getAttribute('href') ?? ''
        return h.includes('/show-doc') && h.includes('Resaula') && /id=\d+/.test(h)
      })
      for (const a of anchors) {
        const linkText = (a.textContent ?? '').replace(/\s+/g, ' ').trim()
        // Walk up at most 6 ancestors to find the row container (carries the date).
        let row: Element | null = a
        for (let i = 0; i < 6 && row; i++) {
          if (row.tagName === 'TR') break
          row = row.parentElement
        }
        if (!row) row = a.parentElement
        const rowText = (row?.textContent ?? '').replace(/\s+/g, ' ').trim()
        out.push({ href: a.getAttribute('href') ?? '', linkText, rowText })
      }
      return out
    })

    const parsed: ListedSeduta[] = []
    const seen = new Set<number>()
    for (const r of rows) {
      const date = parseItalianDate(r.rowText)
      if (!date) continue
      // Seduta number: historical layout carries it in the link text
      // ("Seduta n. 296"); the current layout puts it in the row between the
      // year and the "html" link ("... 1997 296 html"). Try both.
      const sedMatch = r.linkText.match(/seduta\s*n\.?\s*(\d+)/i)
      let numero: number
      if (sedMatch) {
        numero = Number(sedMatch[1])
      } else {
        // Current-leg layout: skip the "pdf" twin, keep only the "html" link.
        if (r.linkText.toLowerCase() !== 'html') continue
        const numMatch = r.rowText.match(/\d{4}\s+(\d{1,4})\s+html/i)
        if (!numMatch) continue
        numero = Number(numMatch[1])
      }
      if (!Number.isFinite(numero) || seen.has(numero)) continue
      const fullUrl = new URL(r.href, 'https://www.senato.it').toString()
      const idMatch = fullUrl.match(/[?&]id=(\d+)/)
      if (!idMatch) continue
      const docId = idMatch[1]
      // Append &part=doc_dc so the body pass gets the full document, not the TOC.
      const url = fullUrl.includes('part=') ? fullUrl : `${fullUrl}&part=doc_dc`
      seen.add(numero)
      parsed.push({ numero, data: date, htmlUrl: url, docId })
    }
    return parsed
  } finally {
    await page.close()
  }
}

interface LegYearRange {
  startYear: number
  endYear: number
}

// Approximate calendar ranges of Italian Republic legislatures. These bound the
// year-by-year scrape; we tolerate empty years (a leg that ended in Q1 will
// have no rows for the previous year).
const LEG_RANGES: Record<number, LegYearRange> = {
  19: { startYear: 2022, endYear: new Date().getFullYear() },
  18: { startYear: 2018, endYear: 2022 },
  17: { startYear: 2013, endYear: 2018 },
  16: { startYear: 2008, endYear: 2013 },
  15: { startYear: 2006, endYear: 2008 },
  14: { startYear: 2001, endYear: 2006 },
  13: { startYear: 1996, endYear: 2001 },
  12: { startYear: 1994, endYear: 1996 },
  11: { startYear: 1992, endYear: 1994 },
  10: { startYear: 1987, endYear: 1992 },
  9: { startYear: 1983, endYear: 1987 },
  8: { startYear: 1979, endYear: 1983 },
  7: { startYear: 1976, endYear: 1979 },
  6: { startYear: 1972, endYear: 1976 },
  5: { startYear: 1968, endYear: 1972 },
  4: { startYear: 1963, endYear: 1968 },
  3: { startYear: 1958, endYear: 1963 },
  2: { startYear: 1953, endYear: 1958 },
  1: { startYear: 1948, endYear: 1953 },
}

export async function scrapeSenatoListing(
  context: BrowserContext,
  legislatura: number,
): Promise<ListedSeduta[]> {
  const range = LEG_RANGES[legislatura]
  if (!range) {
    throw new Error(`Unknown legislature range: leg ${legislatura}`)
  }
  const all: ListedSeduta[] = []
  const seenNumero = new Set<number>()
  for (let year = range.startYear; year <= range.endYear; year++) {
    console.log(`[senato-listing] scraping leg ${legislatura} year ${year}`)
    let rows: ListedSeduta[] = []
    try {
      rows = await scrapeYear(context, legislatura, year)
    } catch (err) {
      // A WAF block is NOT an "empty year" -- continuing would hammer the ban
      // year after year. Propagate it so the orchestrator aborts the run.
      if (err instanceof SenatoBlockError) throw err
      console.warn(`[senato-listing] year ${year} scrape failed:`, err)
      continue
    }
    console.log(`[senato-listing] leg ${legislatura} year ${year}: ${rows.length} rows`)
    for (const r of rows) {
      if (seenNumero.has(r.numero)) continue
      seenNumero.add(r.numero)
      all.push(r)
    }
  }
  return all.sort((a, b) => a.numero - b.numero)
}
