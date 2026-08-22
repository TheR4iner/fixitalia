import { parseHistoricalTranscript } from '../lib/ingest/parlamento/cameraHistoricalSession.ts'

async function fetchTxt(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'fixitalia-probe' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`)
  return await res.text()
}

async function main() {
  console.log('=== leg 14 sintero (sed 757) ===')
  const leg14 = await fetchTxt(
    'https://leg14.camera.it/_dati/leg14/lavori/stenografici/sed757/sintero.htm',
  )
  const r14 = parseHistoricalTranscript(leg14)
  console.log(`  odg=${r14.odg.length}  interventi=${r14.interventi.length}`)
  for (const o of r14.odg.slice(0, 5)) console.log(`    odg[${o.posizione}]: ${o.titolo}`)
  for (const it of r14.interventi.slice(0, 5)) {
    console.log(
      `    int[${it.posizione}] odg=${it.odgPosition} speaker="${it.rawSpeaker}" body="${it.paragraphs[0]?.slice(0, 80)}..."`,
    )
  }

  console.log('\n=== leg 13 chunked (sed 100) ===')
  // Fetch index + chunks ourselves to feed parser
  const baseUrl = 'https://leg13.camera.it/_dati/leg13/lavori/stenografici/sed100/'
  const indexHtml = await fetchTxt(`${baseUrl}s000.htm`)
  const chunkSet = new Set<string>()
  for (const m of indexHtml.matchAll(/href\s*=\s*["']?(s\d{3}\.htm)/gi)) chunkSet.add(m[1])
  const chunks = Array.from(chunkSet).sort()
  console.log(`  chunks discovered: ${chunks.join(', ')}`)
  const bodies: string[] = []
  for (const c of chunks) {
    try {
      bodies.push(await fetchTxt(`${baseUrl}${c}`))
    } catch (err) {
      console.warn(`  chunk ${c} failed:`, err instanceof Error ? err.message : err)
    }
  }
  const leg13Combined = bodies.join('\n')
  const r13 = parseHistoricalTranscript(leg13Combined)
  console.log(`  odg=${r13.odg.length}  interventi=${r13.interventi.length}`)
  for (const o of r13.odg.slice(0, 5)) console.log(`    odg[${o.posizione}]: ${o.titolo}`)
  for (const it of r13.interventi.slice(0, 5)) {
    console.log(
      `    int[${it.posizione}] odg=${it.odgPosition} speaker="${it.rawSpeaker}" body="${it.paragraphs[0]?.slice(0, 80)}..."`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
