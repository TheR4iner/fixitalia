import { fetchCameraDeputatoViaSparql } from '../lib/ingest/parlamento/cameraHistoricalDeputatoSparql.ts'

async function main() {
  // Emma Bonino, leg 15 (well-tested resource)
  console.log('=== Bonino leg 15 ===')
  const r1 = await fetchCameraDeputatoViaSparql(14710, 15)
  console.log(JSON.stringify(r1, null, 2))

  console.log('\n=== Bonino leg 17 (she served leg 17 too) ===')
  const r2 = await fetchCameraDeputatoViaSparql(14710, 17)
  console.log(JSON.stringify(r2, null, 2)?.slice(0, 1500))

  console.log('\n=== unknown deputy (expect null) ===')
  const r3 = await fetchCameraDeputatoViaSparql(99999999, 15)
  console.log(r3)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
