import { Table, RecordId, DateTime } from 'surrealdb'

import { runQuery, withDbRetry } from '../../query.ts'
import { cleanString } from '../../parse.ts'
import { fetchWithRetry, shortenTitle, slugify } from './parseHelpers.ts'
import { buildRifRows, stripNulls } from '../../parlamento/refs/builder.ts'
import { PARSER_VERSION } from '../../parlamento/refs/index.ts'
import { syncSedutaToMeili } from './meiliSync.ts'

// -----------------------------------------------------------------------------
// Camera per-session ingest for legs 13-14.
//
// These two legs predate the leg-19 XML stenografico format. Their
// transcripts live on per-legislature subdomains:
//
//   https://leg{N}.camera.it/_dati/leg{N}/lavori/stenografici/sed{N}/
//
// Leg 14 publishes a single-file aggregation at `sintero.htm`. Leg 13 only
// has chunked files: `s010.htm`, `s020.htm`, ... -- one chunk per OdG
// section, indexed by `s000.htm`.
//
// Speaker and OdG markup is anchor-based and consistent across both legs,
// modulo a leg-14-only `<!O>...<!/O>` SGML wrapper around speaker anchors.
//
// We cannot DOM-parse this: `<!O>` is SGML processing-instruction syntax
// that an HTML parser sees as a comment or drops entirely, and leg-13
// anchors are never explicitly closed (the `<A NAME>` opens but no `</A>`
// appears until the next anchor or end of section). Instead, we tokenize
// on `<A NAME="..."` boundaries and parse each segment with focused regex.
//
// Speakers in these legs do NOT carry an `idPersona`: the camera.it
// linking convention didn't exist yet in 1996-2006. Display name survives
// on `oratore_nome`, but `mandato_id` stays null. A follow-up pass using
// storia.camera.it deputy data can later resolve names to mandato rows.
// -----------------------------------------------------------------------------

interface IngestSessionResult {
  chamber: 'camera'
  numero: number
  odg_n: number
  interventi_n: number
  durationMs: number
  status: 'ok' | 'partial' | 'empty' | 'error'
  error?: string
}

interface SedutaRow {
  id: RecordId<'parlamento_sedute'>
  chamber: 'camera'
  legislatura: number
  numero: number
  html_url: string
  // Carried so the odg rows can denormalise it (see schema.ts). The SDK
  // hands back its own DateTime wrapper for a `datetime` column, not a JS
  // Date -- .toDate() converts it at the insert site.
  data: DateTime
}

async function loadSeduta(legislatura: number, numero: number): Promise<SedutaRow | null> {
  const rows = await runQuery<SedutaRow[]>(
    `SELECT id, chamber, legislatura, numero, html_url, data
     FROM parlamento_sedute
     WHERE chamber = "camera" AND legislatura = $leg AND numero = $num
     LIMIT 1;`,
    { leg: legislatura, num: numero },
  )
  return rows?.[0] ?? null
}

// linkedom strips out unknown HTML entities. We only need the Italian set
// plus the standard ASCII set, so a small targeted table is faster and
// safer than pulling in `he` or DOM-based decoding.
const ENTITY_TABLE: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  laquo: '«',
  raquo: '»',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  egrave: 'è',
  Egrave: 'È',
  eacute: 'é',
  Eacute: 'É',
  agrave: 'à',
  Agrave: 'À',
  igrave: 'ì',
  Igrave: 'Ì',
  ograve: 'ò',
  Ograve: 'Ò',
  ugrave: 'ù',
  Ugrave: 'Ù',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  aacute: 'á',
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITY_TABLE[name] ?? m)
}

// Page break markers like `<H5><HR WIDTH=33%><CENTER>Pag. 7643</CENTER>...`
// carry no content and would otherwise become noise paragraphs.
const PAGE_MARKER_RE = /<H5>[\s\S]*?Pag\.\s*\d+[\s\S]*?<\/H5>/gi

function stripChrome(raw: string): string {
  return raw
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(PAGE_MARKER_RE, ' ')
    .replace(/<!O>/g, ' ')
    .replace(/<!\/O>/g, ' ')
    .replace(/<!T>/g, ' ')
    .replace(/<!\/T>/g, ' ')
}

function htmlSegmentToText(segment: string): string {
  // Convert block boundaries to spaces, preserve `<BR>` as line breaks so
  // intra-speech paragraphs survive into the output.
  const text = stripChrome(segment)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// The display name appears between the closing `>` of the anchor tag and
// the first sentence-boundary marker. Leg 14 closes the anchor explicitly
// (`<A NAME="...">VITTORIO TARDITI</A>`), leg 13 does not (`<A NAME="...">PRESIDENTE. ...`).
// Handle both: take everything up to `</A>` OR the first `.` outside a tag.
function extractDisplayName(afterAnchor: string): { name: string; rest: string } {
  const trimmed = afterAnchor.replace(/^\s+/, '')
  const closeA = trimmed.match(/^([^<.]+?)<\/A>/i)
  if (closeA) {
    return { name: decodeEntities(closeA[1]).trim(), rest: trimmed.slice(closeA[0].length) }
  }
  const dot = trimmed.match(/^([^.<]+)\./)
  if (dot) {
    return { name: decodeEntities(dot[1]).trim(), rest: trimmed.slice(dot[0].length) }
  }
  return { name: '', rest: trimmed }
}

// Strip a leading role token only, NOT the rest of the sentence. The leg-19
// parser can use `[^.]*\.` greedy stripping because the role lives in its
// own <em>; here the role and the speech are concatenated in a single text
// run (e.g. ", Segretario, legge il processo verbale..."), so eating to
// the first period would swallow real content.
const ROLE_HINT_RE =
  /^\s*,?\s*(?:Presidente|Vice\s+Presidente|Vicepresidente|Ministro|Ministra|Sottosegretario|Sottosegretaria|Segretario|Segretaria|Relatore|Relatrice)\b[,.]?\s*/i

function trimBodyLead(body: string): string {
  let rest = body
  const roleMatch = rest.match(ROLE_HINT_RE)
  if (roleMatch) rest = rest.slice(roleMatch[0].length)
  rest = rest.replace(/^\s*[.,;:]\s*/, '').trim()
  return rest
}

interface OdgBuilder {
  posizione: number
  titolo: string
  anchor: string
}

interface InterventoBuilder {
  posizione: number
  odgPosition: number
  rawSpeaker: string
  paragraphs: string[]
}

interface ParseResult {
  odg: OdgBuilder[]
  interventi: InterventoBuilder[]
}

// Both leg formats share the same anchor scheme. The first space-delimited
// token of the NAME attribute is the section kind:
//   - "Titolo1", "Titolo2", ... -> OdG title
//   - any other label -> a speaker turn
const ANCHOR_RE = /<A\s+NAME=["']([^"']+)["'][^>]*>/gi
const TITLE_NAME_RE = /^Titolo\d+\b/

export function parseHistoricalTranscript(html: string): ParseResult {
  // Pre-clean to make subsequent slicing well-behaved. We keep `<BR>`,
  // `<A>`, `<I>` and similar inline tags; htmlSegmentToText drops them
  // per-segment. SGML PIs (`<!O>...<!/O>`) and page markers are removed
  // up-front so they don't confuse anchor positioning.
  const cleaned = html
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!O>/g, '')
    .replace(/<!\/O>/g, '')

  const boundaries: Array<{ name: string; afterTagStart: number }> = []
  ANCHOR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ANCHOR_RE.exec(cleaned)) !== null) {
    boundaries.push({ name: m[1], afterTagStart: m.index + m[0].length })
  }

  const odg: OdgBuilder[] = []
  const interventi: InterventoBuilder[] = []
  let currentOdgPos = 0
  let pos = 0

  for (let i = 0; i < boundaries.length; i += 1) {
    const tok = boundaries[i]
    const sliceEnd = boundaries[i + 1]?.afterTagStart ?? cleaned.length
    const segment = cleaned.slice(tok.afterTagStart, sliceEnd)

    if (TITLE_NAME_RE.test(tok.name)) {
      const titoloRaw = (segment.match(/<B>([\s\S]*?)<\/B>/i)?.[1] ?? segment).trim()
      const titolo = shortenTitle(
        decodeEntities(titoloRaw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
      )
      if (!titolo) continue
      currentOdgPos += 1
      odg.push({
        posizione: currentOdgPos,
        titolo,
        anchor: `odg-${currentOdgPos}-${slugify(titolo).slice(0, 32)}`,
      })
      continue
    }

    const { name: displayName, rest } = extractDisplayName(segment)
    const body = trimBodyLead(htmlSegmentToText(rest))
    if (!displayName && !body) continue
    pos += 1
    interventi.push({
      posizione: pos,
      odgPosition: currentOdgPos,
      rawSpeaker: displayName,
      paragraphs: body ? [body] : [],
    })
  }

  return { odg, interventi }
}

// Leg 14 sintero.htm is one file containing the whole transcript. Leg 13
// requires fetching the index (s000.htm) to discover chunk filenames,
// then concatenating each chunk in order.
async function fetchTranscriptHtml(seduta: SedutaRow): Promise<string> {
  const baseUrl = seduta.html_url.replace(/\/[^/]+$/, '/')
  // Leg 14 publishes a single-file aggregation at sintero.htm, but only for
  // some sedute. When it is absent (404) we fall back to the chunked s000.htm
  // path that leg 13 uses and that leg 14 also exposes via its frameset.
  if (seduta.legislatura === 14 && seduta.html_url.endsWith('sintero.htm')) {
    const res = await fetchWithRetry(seduta.html_url, {
      timeoutMs: 45_000,
      attempts: 3,
      passthroughStatuses: [404],
    })
    if (res.ok) {
      return await res.text()
    }
    // sintero.htm missing for this seduta -- fall through to the chunked path.
  }
  return await fetchChunkedTranscript(baseUrl, seduta.html_url)
}

// Fetch the s000.htm index for a seduta, discover its chunk files
// (s010.htm, s020.htm, ...) and concatenate them in order. Used directly for
// leg 13 and as the leg-14 fallback when sintero.htm is absent.
async function fetchChunkedTranscript(baseUrl: string, htmlUrl: string): Promise<string> {
  const indexUrl = htmlUrl.endsWith('s000.htm') ? htmlUrl : `${baseUrl}s000.htm`
  const indexRes = await fetchWithRetry(indexUrl, { timeoutMs: 30_000, attempts: 3 })
  if (!indexRes.ok) {
    throw new Error(`historical index fetch failed: HTTP ${indexRes.status} on ${indexUrl}`)
  }
  const indexHtml = await indexRes.text()
  const chunkSet = new Set<string>()
  for (const cm of indexHtml.matchAll(/href\s*=\s*["']?(s\d{3}\.htm)/gi)) {
    chunkSet.add(cm[1])
  }
  const chunks = Array.from(chunkSet).sort((a, b) => a.localeCompare(b))
  if (chunks.length === 0) {
    return indexHtml
  }
  const bodies: string[] = []
  for (const c of chunks) {
    const url = `${baseUrl}${c}`
    try {
      const r = await fetchWithRetry(url, {
        timeoutMs: 30_000,
        attempts: 3,
        passthroughStatuses: [404],
      })
      if (!r.ok) continue
      bodies.push(await r.text())
    } catch (err) {
      console.warn(
        `[ingest:parlamento:camera-historical] chunk fetch failed ${url}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return bodies.join('\n')
}

export async function ingestCameraHistoricalSession(
  legislatura: number,
  numero: number,
): Promise<IngestSessionResult> {
  const started = Date.now()
  const seduta = await loadSeduta(legislatura, numero)
  if (!seduta) {
    return {
      chamber: 'camera',
      numero,
      odg_n: 0,
      interventi_n: 0,
      durationMs: Date.now() - started,
      status: 'error',
      error: `seduta camera/${legislatura}/${numero} not in parlamento_sedute -- run camera-index first`,
    }
  }

  let html: string
  try {
    html = await fetchTranscriptHtml(seduta)
  } catch (err) {
    await runQuery(
      `UPDATE $id SET body_status = "error", body_error = $err;`,
      { id: seduta.id, err: err instanceof Error ? err.message : String(err) },
    )
    return {
      chamber: 'camera',
      numero,
      odg_n: 0,
      interventi_n: 0,
      durationMs: Date.now() - started,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (html.length < 1024) {
    await runQuery(
      `UPDATE $id SET body_status = "empty", body_error = "transcript shorter than 1KB";`,
      { id: seduta.id },
    )
    return {
      chamber: 'camera',
      numero,
      odg_n: 0,
      interventi_n: 0,
      durationMs: Date.now() - started,
      status: 'empty',
    }
  }

  const { odg: odgList, interventi: interventiList } = parseHistoricalTranscript(html)

  // Mark in-progress; mirror the leg-19 status-machine contract so a crash
  // during the DELETE/INSERT block leaves the seduta as "ingesting" and the
  // next orchestrator tick re-processes it.
  // See project-kb/Parlamento body-pass atomicity.md.
  await runQuery(
    `UPDATE $id SET body_status = "ingesting", body_error = NONE;`,
    { id: seduta.id },
  )

  await withDbRetry((d) =>
    d.query(
      `DELETE parlamento_odg WHERE seduta_id = $id;
       DELETE parlamento_interventi WHERE seduta_id = $id;
       DELETE parlamento_riferimenti WHERE seduta = $id;`,
      { id: seduta.id },
    ),
  )

  const odgIds: Map<number, RecordId<'parlamento_odg'>> = new Map()
  const odgRowsToInsert = odgList.map((o) => {
    const id = new RecordId(
      'parlamento_odg',
      `c-${seduta.legislatura}-${seduta.numero}-${o.posizione}`,
    )
    odgIds.set(o.posizione, id)
    return {
      id,
      seduta_id: seduta.id,
      posizione: o.posizione,
      titolo: o.titolo,
      titolo_lower: o.titolo.toLowerCase(),
      anchor: o.anchor,
      // Denormalised from the seduta so /odg/search can filter and sort
      // without dereferencing the record link per row. See schema.ts.
      chamber: seduta.chamber,
      legislatura: seduta.legislatura,
      data: seduta.data.toDate(),
    }
  })

  if (odgRowsToInsert.length > 0) {
    try {
      await withDbRetry((d) => d.insert(new Table('parlamento_odg'), odgRowsToInsert))
    } catch (err) {
      console.warn(
        `[ingest:parlamento:camera-historical] camera/${legislatura}/${numero} OdG insert failed (continuing without OdG):`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // Historical interventi have no idPersona, so mandato_id stays null.
  // Display name lives in oratore_nome; a post-pass against storia.camera.it
  // can later attach mandato_id by name resolution.
  const interventiRowsRaw: Array<Record<string, unknown>> = []
  let pos = 0
  for (const it of interventiList) {
    const text = it.paragraphs
      .map((p) => cleanString(p))
      .filter((p): p is string => Boolean(p))
      .join('\n\n')
    if (!text) continue
    pos += 1
    interventiRowsRaw.push({
      seduta_id: seduta.id,
      odg_id: it.odgPosition > 0 ? odgIds.get(it.odgPosition) ?? null : null,
      posizione: pos,
      mandato_id: null,
      oratore_nome: it.rawSpeaker || null,
      gruppo: null,
      ruolo: null,
      testo: text,
      anchor: `int-${pos}`,
    })
  }

  let actuallyInserted = 0
  if (interventiRowsRaw.length > 0) {
    const cleaned: Record<string, unknown>[] = interventiRowsRaw.map((r) =>
      Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined)),
    )
    const BATCH_SIZE = 200
    const table = new Table('parlamento_interventi')
    for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
      const slice = cleaned.slice(i, i + BATCH_SIZE)
      try {
        await withDbRetry((d) => d.insert<Record<string, unknown>>(table, slice))
        actuallyInserted += slice.length
      } catch (err) {
        console.warn(
          `[ingest:parlamento:camera-historical] camera/${legislatura}/${numero} batch insert failed; falling back to per-row:`,
          err instanceof Error ? err.message : err,
        )
        for (const row of slice) {
          try {
            await withDbRetry((d) => d.insert<Record<string, unknown>>(table, row))
            actuallyInserted += 1
          } catch (perRowErr) {
            console.warn(
              `[ingest:parlamento:camera-historical] camera/${legislatura}/${numero} row pos=${(row as { posizione?: number }).posizione} skipped:`,
              perRowErr instanceof Error ? perRowErr.message : perRowErr,
            )
          }
        }
      }
    }
  }

  let refsInserted = 0
  let refsFailures = 0
  try {
    const inserted = await runQuery<
      Array<{ id: RecordId<'parlamento_interventi'>; posizione: number; testo: string }>
    >(
      `SELECT id, posizione, testo
       FROM parlamento_interventi
       WHERE seduta_id = $id
       ORDER BY posizione;`,
      { id: seduta.id },
    )
    const refRows: Array<Record<string, unknown>> = []
    for (const it of inserted ?? []) {
      const rows = buildRifRows(
        it,
        { id: seduta.id, chamber: 'camera', numero: seduta.numero, legislatura },
        { chamber: 'camera', legislatura },
      )
      for (const r of rows) refRows.push(stripNulls(r))
    }
    if (refRows.length > 0) {
      const refsTable = new Table('parlamento_riferimenti')
      const BATCH = 500
      for (let i = 0; i < refRows.length; i += BATCH) {
        const slice = refRows.slice(i, i + BATCH)
        try {
          await withDbRetry((d) => d.insert<Record<string, unknown>>(refsTable, slice))
          refsInserted += slice.length
        } catch (err) {
          console.warn(
            `[ingest:parlamento:camera-historical] camera/${legislatura}/${numero} refs batch failed; per-row fallback:`,
            err instanceof Error ? err.message : err,
          )
          for (const row of slice) {
            try {
              await withDbRetry((d) => d.insert<Record<string, unknown>>(refsTable, row))
              refsInserted += 1
            } catch (perRowErr) {
              refsFailures += 1
              console.warn(
                `[ingest:parlamento:camera-historical] camera/${legislatura}/${numero} ref row skipped (start=${(row as { start?: number }).start}):`,
                perRowErr instanceof Error ? perRowErr.message : perRowErr,
              )
            }
          }
        }
      }
    }
  } catch (err) {
    refsFailures = -1
    console.warn(
      `[ingest:parlamento:camera-historical] camera/${legislatura}/${numero} ref extraction errored:`,
      err instanceof Error ? err.message : err,
    )
  }

  const status = actuallyInserted < interventiRowsRaw.length ? 'partial' : 'ok'
  const errorNote =
    status === 'partial'
      ? `partial: inserted ${actuallyInserted}/${interventiRowsRaw.length} interventi`
      : null
  const refsStatus =
    refsFailures < 0 ? 'failed' : refsFailures > 0 ? 'partial' : 'ok'
  try {
    if (errorNote) {
      await runQuery(
        `UPDATE $id SET
           odg_n = $odgN, interventi_n = $intN,
           body_status = $st, body_error = $err,
           refs_status = $rst, refs_parser_version = $rv;`,
        {
          id: seduta.id,
          odgN: odgList.length,
          intN: actuallyInserted,
          st: status,
          err: errorNote,
          rst: refsStatus,
          rv: PARSER_VERSION,
        },
      )
    } else {
      await runQuery(
        `UPDATE $id SET
           odg_n = $odgN, interventi_n = $intN,
           body_status = $st, body_error = NONE,
           refs_status = $rst, refs_parser_version = $rv;`,
        {
          id: seduta.id,
          odgN: odgList.length,
          intN: actuallyInserted,
          st: status,
          rst: refsStatus,
          rv: PARSER_VERSION,
        },
      )
    }
  } catch (err) {
    console.warn(
      `[ingest:parlamento:camera-historical] camera/${legislatura}/${numero} status update failed:`,
      err instanceof Error ? err.message : err,
    )
  }

  // Mirror the freshly (re)inserted interventi into the Meilisearch index.
  // Best-effort; logs and continues on failure (see meiliSync.ts).
  await syncSedutaToMeili(seduta.id, `camera-historical/${legislatura}/${numero}`)

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:camera-historical] camera/${legislatura}/${numero} -> ${odgList.length} odg, ${actuallyInserted}/${interventiRowsRaw.length} interventi, ${refsInserted} refs (status=${status}, refs=${refsStatus}) in ${durationMs} ms`,
  )

  let outStatus: 'ok' | 'partial' | 'empty'
  if (odgList.length === 0 && actuallyInserted === 0) outStatus = 'empty'
  else if (status === 'partial') outStatus = 'partial'
  else outStatus = 'ok'
  return {
    chamber: 'camera',
    numero,
    odg_n: odgList.length,
    interventi_n: actuallyInserted,
    durationMs,
    status: outStatus,
  }
}
