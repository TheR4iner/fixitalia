#!/usr/bin/env tsx
// Phase 0b probe: map the Camera resoconti catalog (legs 1-12, PDF era).
//
// Earlier probe (_probe-pdf-camera.ts) showed the per-seduta URL scheme is not
// guessable, but archivio.camera.it and biblioteca.camera.it both return 200
// with no WAF. This probe crawls those catalog landing pages and follows the
// links that look like they lead toward assembly stenographic resoconti, so we
// can learn the real navigation path down to a per-seduta document.
//
// Strategy: fetch a seed page, extract every <a>, classify hrefs by keyword
// relevance (resoconto / stenografic / assemblea / seduta / legislatura / pdf),
// and print the promising ones. Then do ONE level of follow-on into the top
// resoconti-ish links. Plain HTTP, polite (250ms gap), no DB, no Playwright.
// Targets camera.it only -- a different host from senato.it, so it cannot
// interfere with a concurrent Senato ingest browser session.
//
// Usage:
//   dev exec backend npx tsx scripts/_probe-camera-catalog.ts

// Standalone probe: no project imports, so TypeScript would treat this file
// as a global script and collide with the other probes' top-level UA/helpers.
// This empty export makes it a module. No runtime effect.
export {}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const SEEDS = [
  'https://biblioteca.camera.it/',
  'https://archivio.camera.it/',
  // Educated guesses at a resoconti index inside the portal -- if they 404 we
  // learn that too, cheaply.
  'https://biblioteca.camera.it/16',
  'https://archivio.camera.it/resoconti',
]

// Keywords that hint a link leads toward assembly transcripts. Ordered roughly
// by how strong a signal each is.
const RELEVANT = [
  'stenografic',
  'resoconto',
  'resoconti',
  'assemblea',
  'seduta',
  'sedute',
  'legislatura',
  'discussioni',
  'portale',
  'storic',
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Link {
  href: string
  text: string
  score: number
}

async function fetchHtml(url: string): Promise<{ status: number; html: string; finalUrl: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: ctrl.signal,
    })
    const html = await res.text()
    return { status: res.status, html, finalUrl: res.url }
  } finally {
    clearTimeout(timer)
  }
}

// Minimal anchor extraction without a DOM lib (we're in plain Node, no jsdom).
function extractLinks(html: string, base: string): Link[] {
  const out: Link[] = []
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  const seen = new Set<string>()
  while ((m = re.exec(html))) {
    const href = m[1].trim()
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:'))
      continue
    let abs: string
    try {
      abs = new URL(href, base).toString()
    } catch {
      continue
    }
    if (seen.has(abs)) continue
    seen.add(abs)
    const text = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
    const hay = `${abs} ${text}`.toLowerCase()
    let score = 0
    for (let i = 0; i < RELEVANT.length; i++) {
      if (hay.includes(RELEVANT[i])) score += RELEVANT.length - i
    }
    if (/\.pdf(\?|$)/i.test(abs)) score += 20 // a PDF link is the prize
    out.push({ href: abs, text, score })
  }
  return out.sort((a, b) => b.score - a.score)
}

async function probeOne(url: string, depth: number): Promise<string[]> {
  console.log(`\n${'  '.repeat(depth)}=== ${url} (depth ${depth}) ===`)
  let r: Awaited<ReturnType<typeof fetchHtml>>
  try {
    r = await fetchHtml(url)
  } catch (err) {
    console.log(`${'  '.repeat(depth)}  ERR ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  console.log(`${'  '.repeat(depth)}  HTTP ${r.status}${r.finalUrl !== url ? ' -> ' + r.finalUrl : ''} (${r.html.length} bytes)`)
  if (r.status >= 400) return []
  const links = extractLinks(r.html, r.finalUrl)
  const relevant = links.filter((l) => l.score > 0).slice(0, 15)
  console.log(`${'  '.repeat(depth)}  ${links.length} links, top ${relevant.length} relevant:`)
  for (const l of relevant) {
    console.log(`${'  '.repeat(depth)}    [${l.score}] ${l.href}`)
    if (l.text) console.log(`${'  '.repeat(depth)}        "${l.text}"`)
  }
  // Return the top few promising same-site links for one level of follow-on.
  return relevant
    .filter((l) => l.score >= 8 && !/\.pdf(\?|$)/i.test(l.href))
    .slice(0, 4)
    .map((l) => l.href)
}

async function main(): Promise<void> {
  const visited = new Set<string>()
  for (const seed of SEEDS) {
    if (visited.has(seed)) continue
    visited.add(seed)
    const followOns = await probeOne(seed, 0)
    await sleep(250)
    for (const f of followOns) {
      if (visited.has(f)) continue
      visited.add(f)
      await probeOne(f, 1)
      await sleep(250)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[probe-camera-catalog] failed:', err)
    process.exit(1)
  })
