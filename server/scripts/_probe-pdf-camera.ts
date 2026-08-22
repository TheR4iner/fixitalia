#!/usr/bin/env tsx
// Phase 0b probe: Camera PDF-era transcript URLs (legs 1-12).
//
// The HTML/XML era begins at leg 15 (documenti.camera.it XML); legs 13-14 are
// on the leg{N}.camera.it subdomains. Legs 1-12 were flagged "PDF-only via
// biblioteca.camera.it / archivio.camera.it" but never actually probed. This
// script HEADs/GETs a spread of candidate URL patterns so we can map the real
// one before committing to an index-pass design.
//
// Plain HTTP only (no Playwright) -- camera.it has historically had no WAF on
// the document hosts. If everything 403s we'll know we need the browser.
//
// Usage (read-only network, safe during an active ingest):
//   dev exec backend npx tsx scripts/_probe-pdf-camera.ts

// Standalone probe: no project imports, so TypeScript would treat this file
// as a global script and collide with the other probes' top-level UA/helpers.
// This empty export makes it a module. No runtime effect.
export {}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Candidate URL templates to probe. {leg}/{n} get substituted. These are
// educated guesses spanning the hosts named in the KB; the probe tells us
// which (if any) resolve. Extend this list as we learn.
const CANDIDATES: Array<{ label: string; url: (leg: number, n: number) => string }> = [
  {
    label: 'documenti-pdf',
    url: (leg, n) =>
      `https://documenti.camera.it/leg${leg}/resoconti/assemblea/pdf/sed${String(n).padStart(4, '0')}.pdf`,
  },
  {
    label: 'storia-portal-leg',
    url: (leg) => `https://storia.camera.it/lavori/seduta/assemblea/leg-regno-${leg}`,
  },
  {
    label: 'archivio-root',
    url: () => `https://archivio.camera.it/`,
  },
  {
    label: 'biblioteca-root',
    url: () => `https://biblioteca.camera.it/`,
  },
  {
    label: 'legN-subdomain-pdf',
    url: (leg, n) =>
      `https://leg${leg}.camera.it/_dati/leg${leg}/lavori/stenografici/sed${String(n).padStart(4, '0')}/pdfel.pdf`,
  },
]

// (leg, representative seduta numero) pairs to test. Leg 1 = 1948, leg 12 = 1994.
const TARGETS: Array<[number, number]> = [
  [12, 100],
  [10, 100],
  [5, 50],
  [1, 10],
]

async function probe(url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    // GET with a Range header so we don't pull a whole PDF just to learn it exists.
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': UA, Range: 'bytes=0-1023', Accept: '*/*' },
      redirect: 'follow',
      signal: ctrl.signal,
    })
    const ct = res.headers.get('content-type') ?? '?'
    const cl = res.headers.get('content-length') ?? '?'
    const finalUrl = res.url !== url ? ` -> ${res.url}` : ''
    return `HTTP ${res.status} [${ct}, len=${cl}]${finalUrl}`
  } catch (err) {
    return `ERR ${err instanceof Error ? err.message : String(err)}`
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  for (const c of CANDIDATES) {
    console.log(`\n=== ${c.label} ===`)
    // Root-style candidates don't vary by target; probe once.
    const isStatic = c.url(0, 0) === c.url(99, 99)
    const seen = new Set<string>()
    for (const [leg, n] of TARGETS) {
      const url = c.url(leg, n)
      if (isStatic && seen.has(url)) continue
      seen.add(url)
      const result = await probe(url)
      console.log(`  leg ${leg} sed ${n}: ${url}`)
      console.log(`    ${result}`)
      if (isStatic) break
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[probe-pdf-camera] failed:', err)
    process.exit(1)
  })
