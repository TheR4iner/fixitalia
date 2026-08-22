#!/usr/bin/env tsx
// Diagnostic: drive scrapeSenatoListing for leg 19 and print the first few
// rows + counts so we can confirm year filtering works end-to-end after the
// URL-param fix.

import { openSenatoBrowser } from '../lib/ingest/parlamento/senatoBrowser.ts'
import { scrapeSenatoListing } from '../lib/ingest/parlamento/senatoListingScraper.ts'

async function main(): Promise<void> {
  const { context, close } = await openSenatoBrowser()
  try {
    const rows = await scrapeSenatoListing(context, 19)
    console.log(`[scraper] total rows: ${rows.length}`)
    console.log('[scraper] first 5:')
    for (const r of rows.slice(0, 5)) {
      console.log(`  numero=${r.numero} data=${r.data} docId=${r.docId}`)
    }
    console.log('[scraper] last 5:')
    for (const r of rows.slice(-5)) {
      console.log(`  numero=${r.numero} data=${r.data} docId=${r.docId}`)
    }
  } finally {
    await close()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[scraper] failed:', err)
    process.exit(1)
  })
