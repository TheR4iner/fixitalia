#!/usr/bin/env tsx
// Proof-of-concept: verify that headless Chromium can bypass the AWS WAF
// challenge on www.senato.it and retrieve transcript body content.
//
// Usage (from inside the workspace):
//   dev exec backend npx tsx scripts/senato-playwright-poc.ts [--url <url>] [--leg N]
//
// If no --url is given, the script queries the DB for a Senato session with a
// known html_url and uses that. Run the Senato index pass first if the DB is empty.
//
// Requires system Chromium: docker exec -u root fixitalia-workspace apt-get install -y chromium

import { chromium } from 'playwright'
import { runQuery } from '../lib/query.ts'
import { closeDb } from '../lib/db.ts'

const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium'
const TIMEOUT_MS = 45_000

interface SedutaRow {
  html_url: string
  numero: number
}

async function resolveTargetUrl(argUrl: string | undefined, leg: number): Promise<string> {
  if (argUrl) return argUrl

  const rows = await runQuery<SedutaRow[]>(
    `SELECT html_url, numero FROM parlamento_sedute
     WHERE chamber = "senato" AND legislatura = $leg AND html_url != NONE
     ORDER BY numero DESC LIMIT 1;`,
    { leg },
  )
  if (!rows?.length) {
    throw new Error(
      `No Senato seduta with html_url found in DB for leg ${leg}. ` +
        `Run: dev exec backend npx tsx scripts/ingest.ts parlamento --chamber senato --legislatura ${leg}`,
    )
  }
  console.log(`[poc] Using seduta n.${rows[0].numero} from DB: ${rows[0].html_url}`)
  return rows[0].html_url
}

async function main() {
  const argv = process.argv.slice(2)
  let argUrl: string | undefined
  let leg = 19

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') argUrl = argv[++i]
    else if (argv[i] === '--leg') leg = Number(argv[++i])
  }

  const targetUrl = await resolveTargetUrl(argUrl, leg)
  await closeDb()

  console.log(`[poc] Launching headless Chromium from: ${CHROMIUM_PATH}`)
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'it-IT',
      extraHTTPHeaders: { 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8' },
    })
    const page = await context.newPage()

    // Mask navigator.webdriver so the AWS WAF JS challenge doesn't detect headless Chrome.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    // Log all network requests/responses and JS console output so we can see
    // exactly what the WAF challenge page is doing.
    page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`))
    page.on('pageerror', (err) => console.log(`[browser:error] ${err.message}`))
    page.on('request', (r) => {
      const url = r.url()
      if (!url.startsWith('data:')) console.log(`[req] ${r.method()} ${url.slice(0, 100)}`)
    })
    page.on('requestfailed', (r) =>
      console.log(`[req:FAIL] ${r.url().slice(0, 100)} — ${r.failure()?.errorText}`),
    )
    page.on('response', (r) => {
      const wafHeader = r.headers()['x-amzn-waf-action']
      const flag = wafHeader ? ` [waf:${wafHeader}]` : ''
      console.log(`[res] ${r.status()}${flag} ${r.url().slice(0, 100)}`)
    })

    console.log(`\n[poc] Step 1: visit chronological listing to solve WAF + discover real seduta links`)
    const listingUrl = 'https://www.senato.it/lavori/assemblea/resoconti-elenco-cronologico?leg=19&anno=2022'
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15_000 })
    } catch {
      // no second navigation needed
    }
    console.log(`[poc] Listing page URL: ${page.url()}`)
    console.log(`[poc] Cookies:`, (await context.cookies()).map((c) => c.name).join(', '))

    // Inspect what we actually got on the listing page
    const listingTitle = await page.title()
    const listingBodyText = (await page.innerText('body')).slice(0, 500)
    const allLinkCount = await page.evaluate(() => document.querySelectorAll('a').length)
    // Hunt for anchors that look like seduta links — they likely live inside
    // tables/lists in the page main content.
    const docLinks = await page.evaluate(() => {
      const out: { href: string; text: string }[] = []
      document.querySelectorAll('a').forEach((a) => {
        const h = a.getAttribute('href') ?? ''
        const t = (a.textContent ?? '').trim().slice(0, 80)
        // Heuristic: links with query strings (likely document IDs), or to /loc/, or
        // anchor text containing "Resoconto" / "seduta" / a date.
        const looksLikeDoc =
          h.includes('?') ||
          h.includes('/loc/') ||
          h.includes('/japp/') ||
          /resoconto|seduta|stenograf/i.test(t) ||
          /\d{1,2}\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/i.test(t)
        if (h && t && looksLikeDoc) out.push({ href: h, text: t })
      })
      return out
    })
    console.log(`[poc] Listing page title: "${listingTitle}"`)
    console.log(`[poc] Body text (first 500 chars):\n─────\n${listingBodyText}\n─────`)
    console.log(`[poc] Total anchors on page: ${allLinkCount}`)
    console.log(`[poc] Doc-shaped anchors: ${docLinks.length}`)
    docLinks.slice(0, 30).forEach((l) => console.log(`   ${l.href.slice(0, 120)}  |  ${l.text}`))

    // Use the first real "html" link from the listing instead of the stale DB URL
    const realDocLink = docLinks.find(
      (l) => l.href.includes('/show-doc') && /id=\d{6,}/.test(l.href) && /Resaula/i.test(l.href),
    )
    const finalTarget = realDocLink ? new URL(realDocLink.href, 'https://www.senato.it').toString() : targetUrl
    console.log(`\n[poc] Step 2: Navigate to ${realDocLink ? 'DISCOVERED' : 'DB'} target: ${finalTarget}`)
    const t0 = Date.now()

    await page.goto(finalTarget, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })

    console.log('[poc] Initial load done, waiting up to 15s for any second WAF challenge...')
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15_000 })
    } catch {
      // no second navigation
    }
    // Give the page a beat to settle
    await page.waitForTimeout(2000)

    const elapsed = Date.now() - t0
    // We can't read the original 202 response status reliably (the WAF
    // navigation already finished), so report what we can actually observe:
    // did the final URL diverge from the navigated one (i.e. did the WAF
    // redirect us into a challenge page)?
    const redirected = page.url() !== finalTarget

    const title = await page.title()
    const htmlContent = await page.content()
    const bodyText = await page.innerText('body')

    console.log(`\n[poc] ── Result ──────────────────────────────────`)
    console.log(`  Redirected:   ${redirected} (final url: ${page.url()})`)
    console.log(`  Page title:   ${title}`)
    console.log(`  HTML length:  ${htmlContent.length} chars`)
    console.log(`  Text length:  ${bodyText.length} chars`)
    console.log(`  Load time:    ${elapsed}ms`)

    if (htmlContent.length < 1000 || bodyText.length < 200) {
      console.log(`\n[poc] FAIL — page too short; WAF challenge likely NOT resolved.`)
      console.log(`  Full HTML (${htmlContent.length} chars):\n${htmlContent}`)
    } else {
      const hasStenografico = /presidente|resoconto|stenografico|seduta/i.test(bodyText)
      console.log(`\n[poc] ${hasStenografico ? 'SUCCESS' : 'PARTIAL'} — body content present.`)
      console.log(`  stenografico markers found: ${hasStenografico}`)
      console.log(`  First 1500 chars of body text:\n─────\n${bodyText.slice(0, 1500)}\n─────`)
      // also look for an iframe or a "leggi il resoconto" link that might contain the real transcript
      const innerFrames = await page.evaluate(() =>
        Array.from(document.querySelectorAll('iframe, frame')).map((f) => f.getAttribute('src')),
      )
      const fullTextLink = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a')).find((a) =>
          /resoconto|stenografico|testo integrale|scarica/i.test(a.textContent ?? ''),
        )
        return a ? { href: a.getAttribute('href'), text: a.textContent?.trim() } : null
      })
      console.log(`  Iframes/frames on page:`, innerFrames.filter(Boolean))
      console.log(`  Possible transcript link:`, fullTextLink)
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('[poc] Error:', err)
  process.exit(1)
})
