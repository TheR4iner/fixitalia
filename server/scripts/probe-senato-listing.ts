#!/usr/bin/env tsx
// Diagnostic: hit a Senato chronological listing page via Playwright and dump
// what the rendered DOM actually contains. Useful when scrapeSenatoListing
// returns 0 rows and we need to find out whether:
//   - the WAF challenge isn't resolving (page is the AWS WAF interstitial),
//   - the URL pattern is wrong (page redirects to a default view),
//   - the anchor selector has drifted (page renders but our query misses it),
//   - the listing renders client-side and domcontentloaded is too early.
//
// Usage:
//   dev exec backend npx tsx scripts/probe-senato-listing.ts
//
// Prints:
//   - the final URL after any redirects
//   - the page title
//   - a count of all <a> elements
//   - a sample of show-doc anchors (href + text)
//   - the first ~2KB of body text (to spot WAF interstitial wording)

import { openSenatoBrowser } from '../lib/ingest/parlamento/senatoBrowser.ts'

const URL =
  process.argv[2] ??
  'https://www.senato.it/lavori/assemblea/resoconti-elenco-cronologico?year=2024'

async function main(): Promise<void> {
  console.log(`[probe] navigating to ${URL}`)
  const { context, close } = await openSenatoBrowser()
  try {
    const page = await context.newPage()
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    // Give the page a chance to settle and the WAF JS to finish.
    try {
      await page.waitForLoadState('networkidle', { timeout: 15_000 })
    } catch {
      console.log('[probe] networkidle timeout (page kept fetching)')
    }
    const finalUrl = page.url()
    const title = await page.title()
    console.log(`[probe] final url: ${finalUrl}`)
    console.log(`[probe] title:     ${title}`)

    const data = await page.evaluate(() => {
      const allAnchors = Array.from(document.querySelectorAll('a'))
      const showDoc = allAnchors
        .filter((a) => (a.getAttribute('href') ?? '').includes('show-doc'))
        .slice(0, 20)
        .map((a) => ({
          href: a.getAttribute('href') ?? '',
          text: (a.textContent ?? '').trim().slice(0, 60),
        }))
      const tables = document.querySelectorAll('table').length
      const trs = document.querySelectorAll('tr').length
      const bodyText = (document.body?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000)
      return { totalAnchors: allAnchors.length, showDoc, tables, trs, bodyText }
    })

    console.log(`[probe] anchor count: ${data.totalAnchors}`)
    console.log(`[probe] tables: ${data.tables}, table rows: ${data.trs}`)
    console.log(`[probe] show-doc anchors found: ${data.showDoc.length}`)
    for (const a of data.showDoc) {
      console.log(`[probe]   href=${a.href}`)
      console.log(`[probe]   text=${a.text}`)
    }
    console.log(`[probe] body text (first 2KB):`)
    console.log(data.bodyText)

    await page.close()
  } finally {
    await close()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[probe] failed:', err)
    process.exit(1)
  })
