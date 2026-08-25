import { existsSync } from 'node:fs'

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

import { senatoThrottle } from './senatoThrottle.ts'

/**
 * Thrown when senato.it serves its AWS WAF block page ("Pagina non
 * accessibile"), i.e. we have been rate-limited / IP-banned. Distinct from a
 * normal per-document error so the orchestrator can ABORT the whole run
 * immediately instead of grinding every remaining seduta against the wall
 * (which only prolongs the ban).
 */
export class SenatoBlockError extends Error {
  constructor(url: string) {
    super(`senato.it WAF block page ("Pagina non accessibile") for ${url} -- rate-limited/banned`)
    this.name = 'SenatoBlockError'
  }
}

// -----------------------------------------------------------------------------
// Senato Playwright browser helper.
//
// www.senato.it sits behind AWS WAF in challenge mode: every transcript URL
// returns HTTP 202 + an inline JS bootstrap that loads a remote challenge.js
// from `*.token.awswaf.com`, computes a PoW, sets an `aws-waf-token` cookie,
// and reloads the page. A plain server-side HTTP client can't solve this; a
// headless Chromium driven by Playwright can.
//
// Design:
//   - One Browser + Context per ingest run. The WAF cookie persists in the
//     context so subsequent navigations reuse it without re-solving.
//   - One Page per seduta (cheap to open; ensures clean event listeners).
//   - Warm-up: visit a known senato.it URL once at the start so the rest of
//     the run finds `aws-waf-token` already in the jar.
//   - `navigator.webdriver = false` is the only stealth knob needed: the WAF
//     is "challenge" mode (JS PoW), not "captcha".
// -----------------------------------------------------------------------------

export interface SenatoBrowser {
  browser: Browser
  context: BrowserContext
  close: () => Promise<void>
}

// Chromium resolution, in priority order:
//   1. CHROMIUM_PATH -- an explicit operator override.
//   2. /usr/bin/chromium -- the distro package, which is what the deploy
//      image ships and what this used to hardcode.
//   3. Playwright's own bundled build -- reached by leaving executablePath
//      undefined so Playwright resolves it from its browser cache.
//
// Step 3 is the fix for a real outage mode: hardcoding the distro path made
// every Senato ingest die at launch on any machine without that package, even
// though `npx playwright install chromium` had already put a perfectly good
// binary in ~/.cache/ms-playwright. The failure surfaced as "failed to launch
// Playwright browser", which reads like a WAF problem and is not.
const SYSTEM_CHROMIUM = '/usr/bin/chromium'

function resolveChromiumPath(): string | undefined {
  const override = process.env.CHROMIUM_PATH
  if (override) return override
  if (existsSync(SYSTEM_CHROMIUM)) return SYSTEM_CHROMIUM
  return undefined
}
const WARMUP_URL =
  'https://www.senato.it/lavori/assemblea/resoconti-elenco-cronologico?year=2024'

export async function openSenatoBrowser(): Promise<SenatoBrowser> {
  const executablePath = resolveChromiumPath()
  const browser = await chromium.launch({
    // undefined => Playwright falls back to its bundled Chromium.
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
    extraHTTPHeaders: { 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8' },
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })

  // Warm up the WAF cookie once for the whole run.
  const page = await context.newPage()
  try {
    await page.goto(WARMUP_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15_000 })
    } catch {
      // already resolved or no challenge
    }
    const cookies = await context.cookies()
    const hasWafToken = cookies.some((c) => c.name === 'aws-waf-token')
    if (!hasWafToken) {
      console.warn('[senato-browser] warm-up did not capture aws-waf-token cookie')
    }
  } finally {
    await page.close()
  }

  return {
    browser,
    context,
    close: async () => {
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
    },
  }
}

/**
 * Navigate to a senato.it URL and wait for the WAF challenge to resolve if one
 * fires. Returns the page (caller is responsible for closing it).
 */
export async function navigateWithWaf(
  context: BrowserContext,
  url: string,
  timeoutMs = 45_000,
): Promise<Page> {
  // Throttle BEFORE the navigation so every senato.it request is paced.
  await senatoThrottle()
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  // If the response was a WAF challenge, the inline JS will trigger a second
  // navigation. Catch both that and the case where the cookie was already in
  // the jar (no challenge fires).
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 12_000 })
  } catch {
    // no challenge or already settled
  }
  // Detect the WAF block wall and fail loudly so the run aborts instead of
  // hammering the ban. The block page title is "Pagina non accessibile"
  // (distinct from a missing document's "Pagina non disponibile").
  const title = await page.title().catch(() => '')
  if (/pagina non accessibile/i.test(title)) {
    await page.close().catch(() => {})
    throw new SenatoBlockError(url)
  }
  return page
}

/**
 * Fetch the full HTML of a Senato show-doc page via Playwright.
 *
 * Auto-appends `&part=doc_dc` if missing — the bare show-doc URL is just a
 * TOC; `&part=doc_dc` is "Documento completo" and contains the full
 * stenografico body. Throws if the response is the ErrorPage_ShowDOC fallback
 * (HTTP 500 from the upstream show-doc backend, typically meaning the id is
 * not a valid document — e.g. a stale SPARQL-derived 5-digit id).
 */
export async function fetchSenatoBodyHtml(
  context: BrowserContext,
  htmlUrl: string,
): Promise<string> {
  const url = htmlUrl.includes('part=') ? htmlUrl : `${htmlUrl}&part=doc_dc`
  const page = await navigateWithWaf(context, url)
  try {
    const title = await page.title()
    if (title.includes('Pagina non disponibile')) {
      throw new Error(`Senato show-doc returned ErrorPage for ${url} (likely invalid id)`)
    }
    return await page.content()
  } finally {
    await page.close()
  }
}
