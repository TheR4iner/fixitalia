/// <reference lib="dom" />
import type { BrowserContext } from 'playwright'
import { RecordId } from 'surrealdb'

import { runQuery } from '../../query.ts'
import { stripNulls } from '../../parse.ts'
import { querySparql, sparqlValue } from './senatoSparqlClient.ts'
import { navigateWithWaf } from './senatoBrowser.ts'

// -----------------------------------------------------------------------------
// Senato della Repubblica -- committee resoconti sommari, index pass.
//
// Enumeration is split deliberately across two hosts:
//
//   dati.senato.it (SPARQL, NO WAF)  -- which committees exist, which years
//                                       each of them sat, in which legislature.
//   www.senato.it  (HTML, AWS WAF)   -- the 7-digit document ids, which appear
//                                       nowhere in the linked-open-data graph.
//
// That split is the whole point. The LOD endpoint knows about 74k committee
// sittings and answers a plain HTTP request; the WAF-guarded site is then
// visited only for the (committee x year) pages SPARQL says are non-empty,
// which is a few hundred navigations per legislature instead of a blind crawl.
//
// Year archive URL shape, discovered from the "Archivio" box on any listing:
//   /static/bgt/listasommcomm/{tipo}/{cod}/s/{leg}/{year}/index.html
// The `/A/{leg}/` form that the site links to shows only the most recent year,
// so it is NOT sufficient for a backfill.
//
// COVERAGE LIMIT: this ingests resoconti SOMMARI, which are third-person
// summaries ("Pone domande all'audito il senatore GRASSO..."), not verbatim
// transcripts. Senato publishes committee resoconti STENOGRAFICI as PDF only,
// which is deferred -- see project-kb/Parlamento commissioni.md.
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

export interface SenatoCommissione {
  /** "{tipo}-{cod}", matching dati.senato.it/commissione/{tipo}-{cod}. */
  cod: string
  tipo: string
  codNum: string
  nome: string | null
  categoria: string | null
  /** Calendar years in which this committee sat during the legislature. */
  years: number[]
}

export interface SenatoCommissioneEntry {
  docId: string
  numero: number
  data: Date
  /** Akoma Ntoso XML -- the structured source the body pass actually parses. */
  aknUrl: string
  /** Human-facing show-doc page, kept for the reader's "source" link. */
  sourceUrl: string
}

interface IndexResult {
  chamber: 'senato'
  legislatura: number
  commissioni: number
  pagesScanned: number
  rowsSeen: number
  rowsInserted: number
  durationMs: number
}

/** Akoma Ntoso export path for one show-doc id. Ids are zero-padded to 8. */
export function senatoAknUrl(leg: number, docId: string): string {
  return `https://www.senato.it/leg/${leg}/BGT/Testi/SommComm/${docId.padStart(8, '0')}.akn`
}

export function senatoShowDocUrl(leg: number, docId: string): string {
  return `https://www.senato.it/japp/bgt/showdoc/frame.jsp?tipodoc=SommComm&leg=${leg}&id=${docId}&part=doc_dc`
}

function yearListingUrl(tipo: string, cod: string, leg: number, year: number): string {
  return `https://www.senato.it/static/bgt/listasommcomm/${tipo}/${cod}/s/${leg}/${year}/index.html`
}

/** Stable, collision-free token for one Senato committee sitting. */
export function senatoCommissioneScope(leg: number, docId: string): string {
  return `sc-${leg}-${docId}`
}

function parseItalianDate(raw: string): Date | null {
  const m = raw.toLowerCase().match(/(\d{1,2})\s+(\p{L}+)\s+(\d{4})/u)
  if (!m) return null
  const day = Number(m[1])
  const month = MONTHS_IT[m[2]]
  const year = Number(m[3])
  if (!month || !day || !year) return null
  return new Date(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00Z`,
  )
}

/**
 * Organi the LOD graph does not know about, discovered by probing.
 *
 * dati.senato.it models osr:SedutaCommissione for the Commissioni permanenti,
 * their sottocommissioni and the bicamerali -- 33 organi in legislature 18 --
 * but carries NO sittings for the Giunte, even though senato.it publishes
 * their resoconti sommari perfectly normally (the Giunta delle elezioni alone
 * has 205 in legislature 18). Enumerating from SPARQL alone therefore misses
 * them silently, which is the worst kind of gap: the ingest reports success
 * and the corpus is simply short.
 *
 * Rather than hardcode the organi we happen to know about, probe the code
 * space the site itself uses. A committee's landing listing is one request and
 * either renders or serves the "Pagina non disponibile" shell, so a code that
 * does not exist costs exactly one request and is skipped. That means a new
 * or renamed organo is picked up without a code change -- which matters,
 * because the failure mode of a hardcoded list is invisible missing data.
 *
 * The ranges are bounded by what the site's own code space uses: tipo 0 is
 * permanent committees and giunte, tipo 4 is bicamerali. Probing is skipped
 * entirely for codes SPARQL already knows about.
 */
const PROBE_TIPI = ['0', '4'] as const
const PROBE_COD_MAX = 32

/** Names for probed organi, when we can do better than the bare code. */
const KNOWN_ORGANO_NAMES: Record<string, string> = {
  '0-20': 'Giunta per il Regolamento',
  '0-21': "Giunta delle elezioni e delle immunita' parlamentari",
  '0-22': 'Giunta per gli affari delle Comunita europee',
}

/**
 * Probe for organi missing from the LOD roster.
 *
 * Uses the `A` (most-recent-year) listing, which is one request per candidate
 * and tells us both whether the organo exists in this legislature and what the
 * site calls it.
 */
async function discoverMissingOrgani(
  context: BrowserContext,
  legislatura: number,
  known: Set<string>,
  years: number[],
): Promise<SenatoCommissione[]> {
  const found: SenatoCommissione[] = []
  for (const tipo of PROBE_TIPI) {
    for (let cod = 1; cod <= PROBE_COD_MAX; cod += 1) {
      const key = `${tipo}-${cod}`
      if (known.has(key)) continue
      const url = `https://www.senato.it/static/bgt/listasommcomm/${tipo}/${cod}/A/${legislatura}/index.html`
      try {
        const page = await navigateWithWaf(context, url)
        try {
          const html = await page.content()
          if (/Pagina non disponibile/i.test(html)) continue
          const { nome, entries } = parseSenatoCommissioniListing(legislatura, html)
          // A landing page that renders but lists nothing is an organo with no
          // published sommari in this legislature -- not worth queueing years for.
          if (entries.length === 0 && !nome) continue
          found.push({
            cod: key,
            tipo,
            codNum: String(cod),
            nome: nome ?? KNOWN_ORGANO_NAMES[key] ?? null,
            categoria: null,
            years,
          })
          console.log(
            `[ingest:parlamento:senato-commissioni-index] discovered organo ${key} ` +
              `absent from the LOD roster: ${nome ?? '(unnamed)'}`,
          )
        } finally {
          await page.close().catch(() => {})
        }
      } catch (err) {
        console.warn(
          `[ingest:parlamento:senato-commissioni-index] probe ${key} failed (continuing):`,
          err instanceof Error ? err.message : err,
        )
      }
    }
  }
  return found
}

/**
 * Committee roster for one legislature, straight from the LOD graph.
 *
 * A committee can carry several historical `titoloBreve` values (the graph is
 * not legislature-scoped for names), so the longest is taken as the most
 * descriptive. The name is cosmetic here; the (tipo, cod) pair is what the
 * listing URLs are built from.
 */
export async function fetchSenatoCommissioniRoster(
  legislatura: number,
): Promise<SenatoCommissione[]> {
  const query = `PREFIX osr: <http://dati.senato.it/osr/>
SELECT ?c ?titolo ?cat ?data WHERE {
  ?s a osr:SedutaCommissione ;
     osr:legislatura ${legislatura} ;
     osr:commissione ?c ;
     osr:dataSeduta ?data .
  OPTIONAL { ?c osr:titoloBreve ?titolo }
  OPTIONAL { ?c osr:categoriaCommissione ?cat }
}`
  const res = await querySparql(query, 60_000)

  // Accumulate years in a Set (the graph yields one row per sitting, so a
  // committee repeats thousands of times) and flatten to a sorted array at
  // the end.
  interface Acc {
    cod: string
    tipo: string
    codNum: string
    nome: string | null
    categoria: string | null
    years: Set<number>
  }
  const byCod = new Map<string, Acc>()
  for (const row of res.results.bindings) {
    const uri = sparqlValue(row, 'c')
    if (!uri) continue
    const cod = uri.split('/').pop() ?? ''
    const dash = cod.indexOf('-')
    if (dash < 0) continue
    const data = sparqlValue(row, 'data')
    const year = data ? Number(data.slice(0, 4)) : NaN

    const existing = byCod.get(cod)
    const entry: Acc = existing ?? {
      cod,
      tipo: cod.slice(0, dash),
      codNum: cod.slice(dash + 1),
      nome: null,
      categoria: null,
      years: new Set<number>(),
    }
    if (!existing) byCod.set(cod, entry)
    const titolo = sparqlValue(row, 'titolo')
    if (titolo && (!entry.nome || titolo.length > entry.nome.length)) entry.nome = titolo
    const cat = sparqlValue(row, 'cat')
    if (cat && !entry.categoria) entry.categoria = cat
    if (Number.isFinite(year)) entry.years.add(year)
  }

  const roster: SenatoCommissione[] = [...byCod.values()].map((e) => ({
    ...e,
    years: [...e.years].sort((a, b) => a - b),
  }))

  return roster.sort((a, b) => a.cod.localeCompare(b.cod))
}

/** Calendar years the legislature was active, per the LOD sittings. */
export function rosterYears(roster: SenatoCommissione[]): number[] {
  return [...new Set(roster.flatMap((r) => r.years))].sort((a, b) => a - b)
}

/** Parse one year-archive listing page into document entries. */
export function parseSenatoCommissioniListing(
  leg: number,
  html: string,
): { nome: string | null; entries: SenatoCommissioneEntry[] } {
  const nomeMatch = html.match(
    /<div class="titolo_testata_label">([\s\S]*?)<\/div>/i,
  )
  const nome = nomeMatch
    ? nomeMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null
    : null

  const entries: SenatoCommissioneEntry[] = []
  const seen = new Set<string>()
  const re =
    /<a[^>]+href="([^"]*showdoc\/frame\.jsp\?tipodoc=SommComm[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  for (const m of html.matchAll(re)) {
    const href = m[1].replace(/&amp;/g, '&')
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    const idMatch = href.match(/[?&]id=(\d+)/)
    if (!idMatch) continue
    const docId = idMatch[1]
    if (seen.has(docId)) continue

    // Link text reads "Mercoledì 27 Luglio 2022 n. 129" -- both the date and
    // the resoconto number, which appear nowhere else on the row.
    const data = parseItalianDate(text)
    const numMatch = text.match(/n\.\s*(\d+)/i)
    if (!data || !numMatch) {
      console.warn(
        `[ingest:parlamento:senato-commissioni-index] leg=${leg} unparseable listing row, dropped: ${text || href}`,
      )
      continue
    }
    seen.add(docId)
    entries.push({
      docId,
      numero: Number(numMatch[1]),
      data,
      aknUrl: senatoAknUrl(leg, docId),
      sourceUrl: senatoShowDocUrl(leg, docId),
    })
  }
  return { nome, entries }
}

async function scrapeYear(
  context: BrowserContext,
  leg: number,
  c: SenatoCommissione,
  year: number,
): Promise<{ nome: string | null; entries: SenatoCommissioneEntry[] }> {
  const url = yearListingUrl(c.tipo, c.codNum, leg, year)
  const page = await navigateWithWaf(context, url)
  try {
    const html = await page.content()
    // A committee/year with no published sommari renders the site's
    // "Pagina non disponibile" shell rather than a 404, so detect it by
    // content instead of status.
    if (/Pagina non disponibile/i.test(html)) return { nome: null, entries: [] }
    return parseSenatoCommissioniListing(leg, html)
  } finally {
    await page.close().catch(() => {})
  }
}

export async function ingestSenatoCommissioniIndex(
  legislatura: number,
  context: BrowserContext,
  options: { onlyCod?: string[]; discoverMissing?: boolean } = {},
): Promise<IndexResult> {
  const started = Date.now()

  let roster = await fetchSenatoCommissioniRoster(legislatura)

  // Fill in organi the LOD graph omits (the Giunte). Skipped when the caller
  // has narrowed to specific codes, since that is a targeted re-run.
  if (!options.onlyCod?.length && options.discoverMissing !== false) {
    const known = new Set(roster.map((c) => c.cod))
    const extra = await discoverMissingOrgani(
      context,
      legislatura,
      known,
      rosterYears(roster),
    )
    roster = [...roster, ...extra].sort((a, b) => a.cod.localeCompare(b.cod))
  }

  if (options.onlyCod?.length) {
    const want = new Set(options.onlyCod)
    roster = roster.filter((c) => want.has(c.cod))
    // A targeted re-run must still work for an organo the LOD omits, so
    // synthesise anything the roster did not supply.
    for (const cod of options.onlyCod) {
      if (roster.some((c) => c.cod === cod)) continue
      const dash = cod.indexOf('-')
      if (dash < 0) continue
      roster.push({
        cod,
        tipo: cod.slice(0, dash),
        codNum: cod.slice(dash + 1),
        nome: KNOWN_ORGANO_NAMES[cod] ?? null,
        categoria: null,
        years: rosterYears(await fetchSenatoCommissioniRoster(legislatura)),
      })
    }
  }
  console.log(
    `[ingest:parlamento:senato-commissioni-index] leg=${legislatura} roster of ${roster.length} committees, ` +
      `${roster.reduce((a, c) => a + c.years.length, 0)} committee-years to scan`,
  )

  let pagesScanned = 0
  const docs: Array<{ id: RecordId<'parlamento_sedute'>; doc: Record<string, unknown> }> = []

  for (const c of roster) {
    for (const year of c.years) {
      try {
        const { nome, entries } = await scrapeYear(context, legislatura, c, year)
        pagesScanned += 1
        if (entries.length === 0) continue
        // The listing page names the committee as it was called in that
        // legislature, which is more accurate than the LOD title.
        const displayName = nome ?? c.nome
        for (const e of entries) {
          docs.push({
            id: new RecordId(
              'parlamento_sedute',
              senatoCommissioneScope(legislatura, e.docId),
            ),
            // stripNulls because SurrealDB's option<T> rejects a bound
            // null; see the same note in cameraCommissioniIndex.ts.
            doc: stripNulls({
              chamber: 'senato',
              legislatura,
              numero: e.numero,
              data: e.data,
              titolo: null,
              source_url: e.sourceUrl,
              html_url: e.aknUrl,
              organo: 'commissione',
              organo_cod: c.cod,
              organo_nome: displayName,
              organo_slug: `senato-${c.cod}`,
              tipo_resoconto: 'sommario',
              tipologia: c.categoria,
              sottotipologia: null,
            }),
          })
        }
        console.log(
          `[ingest:parlamento:senato-commissioni-index] ${c.cod} ${year}: ${entries.length} sittings`,
        )
      } catch (err) {
        // One unreachable page must not abort the legislature; the pass is
        // resumable and will revisit it.
        console.warn(
          `[ingest:parlamento:senato-commissioni-index] ${c.cod} ${year} failed (continuing):`,
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  // UPSERT ... MERGE, never CONTENT: CONTENT would replace the whole record
  // and wipe body_status, silently re-queueing every already-ingested sitting.
  let inserted = 0
  const BATCH = 200
  for (let i = 0; i < docs.length; i += BATCH) {
    const slice = docs.slice(i, i + BATCH)
    try {
      await runQuery(`FOR $r IN $rows { UPSERT $r.id MERGE $r.doc; };`, { rows: slice })
      inserted += slice.length
    } catch (err) {
      console.warn(
        `[ingest:parlamento:senato-commissioni-index] batch ${i / BATCH + 1} failed; per-row fallback:`,
        err instanceof Error ? err.message : err,
      )
      for (const r of slice) {
        try {
          await runQuery(`UPSERT $id MERGE $doc;`, { id: r.id, doc: r.doc })
          inserted += 1
        } catch (rowErr) {
          console.warn(
            `[ingest:parlamento:senato-commissioni-index] upsert failed for ${String(r.id)}:`,
            rowErr instanceof Error ? rowErr.message : rowErr,
          )
        }
      }
    }
  }

  try {
    await runQuery(
      `UPDATE parlamento_sedute SET body_status = "pending"
       WHERE organo = "commissione" AND chamber = "senato"
         AND legislatura = $leg AND body_status IS NONE;`,
      { leg: legislatura },
    )
    await runQuery(
      `UPSERT parlamento_ingest_state
       SET chamber = $chamber, legislatura = $leg,
           index_run_at = time::now(), updated_at = time::now()
       WHERE chamber = $chamber AND legislatura = $leg;`,
      { chamber: 'senato-commissioni', leg: legislatura },
    )
  } catch (err) {
    console.warn(
      '[ingest:parlamento:senato-commissioni-index] bookkeeping write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:senato-commissioni-index] leg=${legislatura} upserted ${inserted}/${docs.length} sittings ` +
      `from ${pagesScanned} listing pages in ${durationMs} ms`,
  )

  return {
    chamber: 'senato',
    legislatura,
    commissioni: roster.length,
    pagesScanned,
    rowsSeen: docs.length,
    rowsInserted: inserted,
    durationMs,
  }
}
