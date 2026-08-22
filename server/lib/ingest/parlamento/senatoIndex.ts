import type { BrowserContext } from 'playwright'
import { Table, RecordId } from 'surrealdb'

import { getDb } from '../../db.ts'
import { runQuery } from '../../query.ts'
import { scrapeSenatoListing } from './senatoListingScraper.ts'

// -----------------------------------------------------------------------------
// Senato della Repubblica -- session index pass.
//
// Primary path: SPARQL via https://dati.senato.it/sparql (LOD endpoint).
//   The LOD endpoint bypasses the Akamai JS-challenge that blocks the HTML
//   listing pages on www.senato.it. We introspect the schema first, then
//   query for all assembly-transcript documents.
//
// Fallback path: HTML scraping of the chronological listing page.
//   Still included because SPARQL may be unavailable or return 0 results
//   for some legislature/year combinations. The listing pages usually return
//   HTTP 202 empty bodies due to the JS challenge, so this path typically
//   yields 0 rows -- but it costs little to try.
// -----------------------------------------------------------------------------

interface IndexResult {
  chamber: 'senato'
  legislatura: number
  rowsSeen: number
  rowsInserted: number
  durationMs: number
}

// ---------------------------------------------------------------------------
// Orchestrator
//
// 2026-05-14: switched from SPARQL + HTTP listing to a Playwright listing
// scraper. SPARQL exposes 5-digit `sedutaassemblea/<ID>` identifiers that are
// in a completely different ID space from what `show-doc` actually uses
// today (7-digit). The legacy helpers above (`runSparql`, `fetchViaSparql`,
// `fetchListing`, `parseListing`) are kept in case we need to re-introspect
// the LOD ontology, but are no longer wired in.
// ---------------------------------------------------------------------------

export async function ingestSenatoIndex(
  legislatura: number,
  browserContext: BrowserContext,
): Promise<IndexResult> {
  const started = Date.now()

  const scraped = await scrapeSenatoListing(browserContext, legislatura)
  console.log(
    `[ingest:parlamento:senato-index] scraped ${scraped.length} sedute from listing for leg ${legislatura}`,
  )

  // Load existing rows keyed by numero so we can compute new-vs-update.
  type ExistingRow = { id: RecordId<'parlamento_sedute'>; numero: number; html_url?: string }
  const existing = (await runQuery<ExistingRow[]>(
    `SELECT id, numero, html_url FROM parlamento_sedute
     WHERE chamber = "senato" AND legislatura = $leg;`,
    { leg: legislatura },
  )) ?? []
  const byNumero = new Map(existing.map((r) => [r.numero, r]))

  const newRows: Record<string, unknown>[] = []
  const urlUpdates: Array<{ id: RecordId<'parlamento_sedute'>; html_url: string; data: Date }> = []

  for (const s of scraped) {
    // The schema's `data` field is datetime, not string. Wrap the YYYY-MM-DD
    // ISO date in a JS Date so the SurrealDB SDK encodes it as a datetime.
    const dataDt = new Date(`${s.data}T00:00:00Z`)
    const ex = byNumero.get(s.numero)
    if (!ex) {
      newRows.push({
        chamber: 'senato' as const,
        legislatura,
        numero: s.numero,
        data: dataDt,
        html_url: s.htmlUrl,
        body_status: 'pending',
      })
    } else if (ex.html_url !== s.htmlUrl) {
      // Existing row but stored URL is stale (typically the broken SPARQL URL):
      // overwrite the URL, refresh the date, and reset body_status so the body
      // pass will re-attempt with the correct URL.
      urlUpdates.push({ id: ex.id, html_url: s.htmlUrl, data: dataDt })
    }
  }

  const db = await getDb()
  let actuallyInserted = 0
  if (newRows.length > 0) {
    const BATCH_SIZE = 500
    for (let i = 0; i < newRows.length; i += BATCH_SIZE) {
      const batch = newRows.slice(i, i + BATCH_SIZE)
      try {
        await db.insert<Record<string, unknown>>(new Table('parlamento_sedute'), batch)
        actuallyInserted += batch.length
      } catch (err) {
        console.error(
          `[ingest:parlamento:senato-index] batch insert failed (${batch.length} rows):`,
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  let urlsUpdated = 0
  for (const u of urlUpdates) {
    try {
      await runQuery(
        `UPDATE $id SET html_url = $url, data = $date, body_status = "pending",
                       body_error = NONE;`,
        { id: u.id, url: u.html_url, date: u.data },
      )
      urlsUpdated += 1
    } catch (err) {
      console.warn(
        `[ingest:parlamento:senato-index] URL refresh failed for ${String(u.id)}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:senato-index] leg ${legislatura}: ` +
      `${actuallyInserted} new, ${urlsUpdated} URL-refreshed (of ${scraped.length} scraped) in ${durationMs} ms`,
  )
  return {
    chamber: 'senato',
    legislatura,
    rowsSeen: scraped.length,
    rowsInserted: actuallyInserted,
    durationMs,
  }
}
