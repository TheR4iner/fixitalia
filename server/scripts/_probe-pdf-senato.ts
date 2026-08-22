#!/usr/bin/env tsx
// Phase 0a probe: Senato PDF-era listing (legs 1-12).
//
// The HTML-era listing scraper (senatoListingScraper.ts) filters anchors to
// `show-doc` + `Resaula` + `id=\d+`. For pre-1996 legs the chronological
// listing still renders, but the resoconti are PDF-only -- so the existing
// filter returns 0 rows. This probe dumps EVERY anchor on an old-leg listing
// page so we can learn:
//   - what the PDF anchor href pattern looks like (/service/PDF/... ? /japp/...?)
//   - whether numero + date are still parseable from the row text
//   - whether the page is behind the same AWS WAF (it should resolve via the
//     same Playwright path the HTML era already uses)
//
// Usage (does NOT touch the DB -- safe to run during an active ingest):
//   dev exec backend npx tsx scripts/_probe-pdf-senato.ts [leg] [year]
// Defaults to leg 12, year 1994.

import { openSenatoBrowser } from '../lib/ingest/parlamento/senatoBrowser.ts'

const LEG = Number(process.argv[2] ?? '12')
const YEAR = Number(process.argv[3] ?? '1994')

function listingUrl(leg: number, year: number): string {
  // Past legislatures always use the /legislature/{N}/ prefix.
  return `https://www.senato.it/legislature/${leg}/lavori/assemblea/resoconti-elenco-cronologico?year=${year}`
}

async function main(): Promise<void> {
  const url = listingUrl(LEG, YEAR)
  console.log(`[probe-pdf-senato] leg ${LEG} year ${YEAR}`)
  console.log(`[probe-pdf-senato] navigating to ${url}`)
  const { context, close } = await openSenatoBrowser()
  try {
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    try {
      await page.waitForLoadState('networkidle', { timeout: 15_000 })
    } catch {
      console.log('[probe-pdf-senato] networkidle timeout (page kept fetching)')
    }
    console.log(`[probe-pdf-senato] final url: ${page.url()}`)
    console.log(`[probe-pdf-senato] title:     ${await page.title()}`)

    const data = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'))
      // Bucket anchors by what their href hints at, so we can see the PDF
      // pattern without knowing it in advance.
      const classify = (h: string): string => {
        if (/\.pdf(\?|$)/i.test(h)) return 'pdf-ext'
        if (/\/service\/PDF/i.test(h)) return 'service-pdf'
        if (/show-doc/i.test(h)) return 'show-doc'
        if (/PDFServer|bgt|japp/i.test(h)) return 'japp/bgt'
        return 'other'
      }
      const buckets: Record<string, number> = {}
      const samples: Record<string, Array<{ href: string; text: string; row: string }>> = {}
      for (const a of anchors) {
        const href = a.getAttribute('href') ?? ''
        if (!href) continue
        const kind = classify(href)
        buckets[kind] = (buckets[kind] ?? 0) + 1
        if (kind === 'other') continue
        // Walk up to the nearest TR to capture the row text (date + numero live there).
        let row: Element | null = a
        for (let i = 0; i < 6 && row; i++) {
          if (row.tagName === 'TR') break
          row = row.parentElement
        }
        const rowText = (row?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
        ;(samples[kind] ??= []).push({
          href,
          text: (a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
          row: rowText,
        })
      }
      // Cap samples so the dump stays readable.
      for (const k of Object.keys(samples)) samples[k] = samples[k].slice(0, 8)
      const bodyText = (document.body?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500)
      return { total: anchors.length, buckets, samples, bodyText }
    })

    console.log(`[probe-pdf-senato] total anchors: ${data.total}`)
    console.log(`[probe-pdf-senato] href buckets:`, JSON.stringify(data.buckets))
    for (const [kind, rows] of Object.entries(data.samples)) {
      console.log(`\n[probe-pdf-senato] --- ${kind} (${rows.length} samples) ---`)
      for (const r of rows) {
        console.log(`  href: ${r.href}`)
        console.log(`  text: ${r.text}`)
        console.log(`  row:  ${r.row}`)
      }
    }
    console.log(`\n[probe-pdf-senato] body text (first 1.5KB -- check for WAF interstitial):`)
    console.log(data.bodyText)

    await page.close()
  } finally {
    await close()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[probe-pdf-senato] failed:', err)
    process.exit(1)
  })
