import { parseHTML } from 'linkedom'
import { Table, RecordId, DateTime } from 'surrealdb'

import { runQuery, withDbRetry } from '../../query.ts'
import { cleanString } from '../../parse.ts'
import { fetchWithRetry, shortenTitle, slugify } from './parseHelpers.ts'
import {
  bumpMandatoInterventi,
  mandatoRecordId,
  upsertMandato,
  upsertPersona,
  type MandatoId,
} from './persona.ts'
import { buildRifRows, stripNulls } from '../../parlamento/refs/builder.ts'
import { PARSER_VERSION } from '../../parlamento/refs/index.ts'
import { syncSedutaToMeili } from './meiliSync.ts'

// -----------------------------------------------------------------------------
// Camera per-session ingest. Reads the full stenografico.htm for a single
// seduta and lands one parlamento_odg row per agenda item plus one
// parlamento_interventi row per speaker turn.
//
// Despite the name `stenografico.xml`, Camera leg19 publishes XHTML (HTML
// inside an XML doctype). The body shape, simplified:
//
//   <p id="...tit00010" class="titolo"><strong>Title of OdG</strong></p>
//   <p id="...tit00010.int00010" class="intervento">
//      <a title="Vai alla scheda personale: ROSSI Mario"
//         href="...idPersona=12345...">MARIO ROSSI</a>
//      <em>, Ministro</em>. body text...
//   </p>
//   <p id="iv.N" class="interventoVirtuale">continuation paragraph...</p>
//
// Walk all <p> in document order. `titolo` opens a new OdG. `intervento`
// opens a new speaker turn (close any prior). `interventoVirtuale` is a
// continuation paragraph appended to the current speaker turn (also covers
// stage directions like "(È approvato)"). `numeroPagina`, `presidenza`,
// `sottotitolo`, `avviso` are skipped from the speaker stream.
//
// Speaker IDs are derived from the `idPersona` query param of the speaker's
// scheda link -- a stable Camera-internal person ID, much better than
// reconciling by name.
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

// Minimal duck-types so we don't have to pull in the whole DOM lib in the
// server tsconfig.
interface DomElement {
  tagName?: string
  textContent: string | null
  classList: { contains(name: string): boolean }
  getAttribute(name: string): string | null
  querySelector(sel: string): DomElement | null
  querySelectorAll(sel: string): DomElement[]
}
interface DomDocument {
  querySelector(sel: string): DomElement | null
  querySelectorAll(sel: string): DomElement[]
  body: DomElement | null
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

async function fetchHtml(url: string): Promise<string> {
  // Camera transcripts are ~300KB; allow a generous timeout for slower
  // upstream responses. Retry on 5xx/timeout, surface 4xx to caller.
  const res = await fetchWithRetry(url, { timeoutMs: 45_000, attempts: 3 })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`Camera transcript fetch failed: HTTP ${res.status} on ${url}`)
  }
  return await res.text()
}

function parseSpeakerAnchor(a: DomElement | null): {
  rawName: string
  idPersona: string | null
  surnameFirst: string | null
} {
  if (!a) return { rawName: '', idPersona: null, surnameFirst: null }
  const rawName = cleanString(a.textContent) ?? ''
  const href = a.getAttribute('href') ?? ''
  const title = a.getAttribute('title') ?? ''
  let idPersona: string | null = null
  const m = href.match(/[?&]idPersona=(\d+)/i)
  if (m) idPersona = m[1]
  // Title: "Vai alla scheda personale: ROSSI Mario" -- gives us surname-first.
  let surnameFirst: string | null = null
  const t = title.match(/scheda\s+personale:\s*(.+)$/i)
  if (t) surnameFirst = cleanString(t[1])
  return { rawName, idPersona, surnameFirst }
}

interface InterventoBuilder {
  posizione: number
  odgPosition: number
  rawSpeaker: string
  idPersona: string | null
  surnameFirst: string | null
  ruolo: string | null
  paragraphs: string[]
}

interface OdgBuilder {
  posizione: number
  titolo: string
  anchor: string
}

/**
 * Extract the role hint that follows the speaker link, e.g. ", Ministro" or
 * ", Segretario". The HTML pattern is `<a>NAME</a><em>, ROLE</em>`. We pull
 * the first <em> that immediately follows the speaker link.
 */
function extractRole(p: DomElement, speakerLink: DomElement | null): string | null {
  if (!speakerLink) return null
  // The first <em> child that follows the speaker link visually contains the role.
  const ems = p.querySelectorAll('em')
  for (const em of ems) {
    const txt = cleanString(em.textContent) ?? ''
    // Match patterns like ", Ministro" / ", Segretario" / "Ministra"
    const m = txt.match(/^[,\s]*(Presidente|Vice\s+Presidente|Vicepresidente|Ministro|Ministra|Sottosegretario|Sottosegretaria|Segretario|Segretaria|Relatore|Relatrice)\b.*/i)
    if (m) return m[1]
  }
  return null
}

/**
 * Strip the speaker link, the role <em>, and leading punctuation, returning
 * the body text of an `intervento` paragraph.
 */
function extractInterventoBody(p: DomElement, speakerLink: DomElement | null): string {
  // Easiest: take the full textContent, then strip the speaker name from
  // the start. Camera transcripts are gentle: speaker name is always at
  // the very start of the paragraph. We also drop any leading role tag in
  // italics if it immediately follows the name.
  const full = (p.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (!speakerLink) return full
  const speaker = (speakerLink.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (!speaker) return full
  // Find the position right after the speaker name in the full text.
  const idx = full.indexOf(speaker)
  if (idx < 0) return full
  let rest = full.slice(idx + speaker.length)
  // Drop a leading comma+role like ", Ministro" up to the next period/comma+space.
  rest = rest.replace(
    /^\s*,\s*(?:Presidente|Vice\s+Presidente|Vicepresidente|Ministro|Ministra|Sottosegretario|Sottosegretaria|Segretario|Segretaria|Relatore|Relatrice)\b[^.]*\./i,
    '',
  )
  // Drop a leading "." or ", " (the punctuation right after the speaker).
  rest = rest.replace(/^\s*[.,;:]\s*/, '').trim()
  return rest
}

interface ParseResult {
  odg: OdgBuilder[]
  interventi: InterventoBuilder[]
  speakerCache: Map<string, { nome: string; surnameFirst: string | null; ruolo: string | null }>
}

function parseTranscript(html: string): ParseResult {
  const { document } = parseHTML(html) as unknown as { document: DomDocument }
  const container = document.querySelector('#wrapper') ?? document.body
  if (!container) {
    return { odg: [], interventi: [], speakerCache: new Map() }
  }

  const paragraphs = container.querySelectorAll('p')
  const odg: OdgBuilder[] = []
  const interventi: InterventoBuilder[] = []
  // (slug or idPersona) -> last-seen display info, for the upsert pass.
  const speakerCache = new Map<
    string,
    { nome: string; surnameFirst: string | null; ruolo: string | null }
  >()

  let currentOdgPos = 0
  let current: InterventoBuilder | null = null

  function flushCurrent() {
    if (current && current.paragraphs.length > 0) {
      interventi.push(current)
    }
    current = null
  }

  for (const p of paragraphs) {
    const cl = p.classList
    if (cl.contains('numeroPagina')) continue
    if (cl.contains('titolo')) {
      flushCurrent()
      currentOdgPos += 1
      const titoloRaw =
        cleanString(p.querySelector('strong')?.textContent ?? p.textContent) ??
        `Argomento ${currentOdgPos}`
      const titolo = shortenTitle(titoloRaw)
      odg.push({
        posizione: currentOdgPos,
        titolo,
        anchor: `odg-${currentOdgPos}-${slugify(titolo).slice(0, 32)}`,
      })
      continue
    }
    if (cl.contains('sottotitolo') || cl.contains('avviso') || cl.contains('presidenza')) {
      // These are auxiliary lines: typically not a speaker turn but useful
      // context. Attach them to the current intervento as a continuation
      // paragraph if one is open; otherwise drop.
      if (current) {
        const t = cleanString(p.textContent)
        if (t) current.paragraphs.push(t)
      }
      continue
    }
    if (cl.contains('intervento')) {
      flushCurrent()
      const speakerLink = p.querySelector('a[href*="schedaDeputato" i], a[href*="idPersona" i]')
      const { rawName, idPersona, surnameFirst } = parseSpeakerAnchor(speakerLink)
      const ruolo = extractRole(p, speakerLink)
      const body = extractInterventoBody(p, speakerLink)
      const cacheKey = idPersona ? `id:${idPersona}` : `name:${rawName}`
      if (rawName) {
        speakerCache.set(cacheKey, { nome: rawName, surnameFirst, ruolo })
      }
      current = {
        posizione: interventi.length + 1,
        odgPosition: currentOdgPos,
        rawSpeaker: rawName,
        idPersona,
        surnameFirst,
        ruolo,
        paragraphs: body ? [body] : [],
      }
      continue
    }
    if (cl.contains('interventoVirtuale')) {
      const t = cleanString(p.textContent)
      if (!t) continue
      if (current) {
        current.paragraphs.push(t)
      }
      // If no current intervento, this is preamble/closing material; skip.
      continue
    }
    // Any other class we have not catalogued: ignore.
  }
  flushCurrent()
  return { odg, interventi, speakerCache }
}

/**
 * Persist a Camera speaker as (persona, mandato) for the seduta's legislature.
 *
 * Returns the mandato record id for the intervento row to point at, or null
 * when:
 *   - the transcript provides no `idPersona` (role-only labels like
 *     "PRESIDENTE." — they survive in `oratore_nome` for display);
 *   - the parsed id is not a valid integer.
 *
 * Idempotent: the persona+mandato composite ids let us call this repeatedly
 * for the same person across many speeches with no extra DB roundtrip cost
 * beyond a noop UPSERT.
 */
async function resolveMandato(
  legislatura: number,
  idPersonaRaw: string | null,
  displayName: string,
): Promise<MandatoId | null> {
  if (!idPersonaRaw) return null
  const idPersona = Number(idPersonaRaw)
  if (!Number.isFinite(idPersona) || idPersona <= 0) return null
  const nome = displayName.trim() || `id-${idPersona}`
  await upsertPersona({ chamber: 'camera', idPersona, nome })
  return await upsertMandato({
    chamber: 'camera',
    legislatura,
    idPersona,
    nome,
    gruppo: null,
    ruolo: null,
  })
}

export async function ingestCameraSession(
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

  const html = await fetchHtml(seduta.html_url)
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

  const { odg: odgList, interventi: interventiList } = parseTranscript(html)

  // Mark the seduta as in-progress before any destructive write. The
  // status-machine guarantee: any process that crashes between this
  // UPDATE and the final UPDATE at the bottom of the function leaves
  // `body_status = "ingesting"`, which the orchestrator's listPending()
  // filter treats as recoverable. Without this, a crash mid-body-pass
  // would leave the seduta empty but with a stale `body_status = "ok"`,
  // hiding the broken state from the next ingest tick.
  // See project-kb/Parlamento body-pass atomicity.md.
  await runQuery(
    `UPDATE $id SET body_status = "ingesting", body_error = NONE;`,
    { id: seduta.id },
  )

  // Idempotent: wipe prior children so a re-run produces consistent state.
  // parlamento_riferimenti rows are also wiped here because their
  // intervento link would point at deleted rows otherwise; the new
  // refs are rebuilt at the end of this function from the freshly
  // inserted interventi.
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
    // ID namespace includes legislatura: leg-1 seduta 1 and leg-19 seduta 1
    // both have OdG positions starting at 1, and would otherwise collide
    // when --all-legislatures runs across the corpus.
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
      // OdG insert is non-fatal: the reader still works without OdG
      // anchors (just no jump-to-topic). Log and continue so we don't
      // lose the interventi too.
      console.warn(
        `[ingest:parlamento:camera-session] camera/${legislatura}/${numero} OdG insert failed (continuing without OdG):`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // Resolve speakers to (persona, mandato) rows. Speakers without an
  // idPersona (typically the bare "PRESIDENTE." label) get no mandato; their
  // display name still survives on the intervento.
  //
  // We cache per-idPersona within this seduta to avoid 100+ identical
  // UPSERTs when the same speaker takes the floor repeatedly. Failures are
  // non-fatal: we leave mandato_id null and keep ingesting -- a network
  // hiccup during one speaker shouldn't lose the entire seduta.
  const mandatoCache = new Map<string, MandatoId | null>()
  const interventiPerMandato = new Map<string, number>()
  let mandatoFailures = 0
  async function getMandatoForSpeaker(
    idPersona: string | null,
    displayName: string,
  ): Promise<MandatoId | null> {
    if (!idPersona) return null
    if (mandatoCache.has(idPersona)) return mandatoCache.get(idPersona) ?? null
    try {
      const id = await resolveMandato(legislatura, idPersona, displayName)
      mandatoCache.set(idPersona, id)
      return id
    } catch (err) {
      mandatoFailures += 1
      mandatoCache.set(idPersona, null) // poison so we don't retry within this seduta
      console.warn(
        `[ingest:parlamento:camera-session] camera/${legislatura}/${numero} mandato upsert failed for idPersona=${idPersona}:`,
        err instanceof Error ? err.message : err,
      )
      return null
    }
  }

  const interventiRowsRaw: Array<Record<string, unknown>> = []
  let pos = 0
  for (const it of interventiList) {
    const text = it.paragraphs
      .map((p) => cleanString(p))
      .filter((p): p is string => Boolean(p))
      .join('\n\n')
    if (!text) continue
    pos += 1
    const displayName = it.surnameFirst ?? it.rawSpeaker ?? ''
    const mandatoId = await getMandatoForSpeaker(it.idPersona, displayName)
    if (mandatoId && it.idPersona) {
      interventiPerMandato.set(it.idPersona, (interventiPerMandato.get(it.idPersona) ?? 0) + 1)
    }
    interventiRowsRaw.push({
      seduta_id: seduta.id,
      odg_id: it.odgPosition > 0 ? odgIds.get(it.odgPosition) ?? null : null,
      posizione: pos,
      mandato_id: mandatoId,
      oratore_nome: displayName || null,
      gruppo: null,
      ruolo: it.ruolo,
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
    const interventiTable = new Table('parlamento_interventi')
    for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
      const slice = cleaned.slice(i, i + BATCH_SIZE)
      try {
        // Pin the generic so SurrealDB's overload sees T = single row,
        // not T = the whole array. Without it, inference picks the array
        // type and the Values<T> constraint mis-resolves.
        await withDbRetry((d) => d.insert<Record<string, unknown>>(interventiTable, slice))
        actuallyInserted += slice.length
      } catch (err) {
        // Try smaller-batch fallback so a single bad row does not lose
        // an entire 200-row batch. Insert one by one; whatever survives
        // makes it into the corpus.
        console.warn(
          `[ingest:parlamento:camera-session] camera/${legislatura}/${numero} batch insert failed; falling back to per-row:`,
          err instanceof Error ? err.message : err,
        )
        for (const row of slice) {
          try {
            await withDbRetry((d) => d.insert<Record<string, unknown>>(interventiTable, row))
            actuallyInserted += 1
          } catch (perRowErr) {
            console.warn(
              `[ingest:parlamento:camera-session] camera/${legislatura}/${numero} row pos=${(row as { posizione?: number }).posizione} skipped:`,
              perRowErr instanceof Error ? perRowErr.message : perRowErr,
            )
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------
  // Reference extraction. Runs over the freshly-inserted interventi
  // (we re-fetch them rather than capturing returned ids from each
  // batched insert -- one extra SELECT is much simpler than threading
  // ids through the per-row fallback path, and the cost is negligible
  // against the ingest's own network/parse latency).
  //
  // Each ref row's id is deterministic
  // (parlamento_riferimenti:c-<numero>-<pos>-<version>-<start>) so a
  // future re-run with the same testo and parser_version produces the
  // same rows by id, and the standalone refs subcommand can do a true
  // UPSERT instead of delete-then-insert.
  // -----------------------------------------------------------------
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
          // Same per-row fallback as interventi: don't lose a whole
          // batch to one bad row.
          console.warn(
            `[ingest:parlamento:camera-session] camera/${legislatura}/${numero} refs batch failed; per-row fallback:`,
            err instanceof Error ? err.message : err,
          )
          for (const row of slice) {
            try {
              await withDbRetry((d) => d.insert<Record<string, unknown>>(refsTable, row))
              refsInserted += 1
            } catch (perRowErr) {
              refsFailures += 1
              console.warn(
                `[ingest:parlamento:camera-session] camera/${legislatura}/${numero} ref row skipped (start=${(row as { start?: number }).start}):`,
                perRowErr instanceof Error ? perRowErr.message : perRowErr,
              )
            }
          }
        }
      }
    }
  } catch (err) {
    refsFailures = -1 // sentinel: extraction itself errored
    console.warn(
      `[ingest:parlamento:camera-session] camera/${legislatura}/${numero} ref extraction errored:`,
      err instanceof Error ? err.message : err,
    )
  }

  // Update per-mandato speech counters now that interventi rows are
  // committed. Best-effort: a counter that drifts by a few on a transient
  // failure is acceptable -- callers re-aggregate from the data when they
  // care about exact figures.
  for (const [idPersonaStr, n] of interventiPerMandato) {
    const idPersona = Number(idPersonaStr)
    if (!Number.isFinite(idPersona)) continue
    await bumpMandatoInterventi(
      mandatoRecordId('camera', legislatura, idPersona),
      n,
    ).catch(() => {})
  }

  // Mark the seduta status reflecting partial success: "ok" if everything
  // landed, "partial" if some rows skipped. Either way the next run will
  // skip this seduta unless --refresh is passed.
  const status = actuallyInserted < interventiRowsRaw.length || mandatoFailures > 0
    ? 'partial'
    : 'ok'
  const errorNote =
    status === 'partial'
      ? `partial: inserted ${actuallyInserted}/${interventiRowsRaw.length} interventi, ${mandatoFailures} mandato failures`
      : null
  // refs_status reflects only the refs pass: 'ok' on full success
  // (refsFailures === 0), 'failed' when extraction itself errored
  // (sentinel -1), 'partial' when some rows skipped. The standalone
  // refs subcommand re-attempts non-ok sedute.
  const refsStatus =
    refsFailures < 0 ? 'failed' : refsFailures > 0 ? 'partial' : 'ok'
  try {
    // SurrealDB's option<T> rejects bound null -- to *clear* the field
    // we must use the NONE literal directly. Branch on errorNote rather
    // than binding null, mirroring the option<T> gotcha already
    // documented in project-kb/Data ingestion pattern.md.
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
    // Failure to record bookkeeping shouldn't drop the data we just
    // landed; the orchestrator's own error path will mark this seduta
    // as failed and a re-run will recover it cleanly.
    console.warn(
      `[ingest:parlamento:camera-session] camera/${legislatura}/${numero} status update failed:`,
      err instanceof Error ? err.message : err,
    )
  }

  // Mirror the freshly (re)inserted interventi into the Meilisearch index.
  // Best-effort; logs and continues on failure (see meiliSync.ts).
  await syncSedutaToMeili(seduta.id, `camera/${legislatura}/${numero}`)

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:camera-session] camera/${legislatura}/${numero} -> ${odgList.length} odg, ${actuallyInserted}/${interventiRowsRaw.length} interventi, ${refsInserted} refs (status=${status}, refs=${refsStatus}) in ${durationMs} ms`,
  )

  // Mirror the body_status the inline UPDATE wrote: 'partial' if not every
  // intervento landed, 'empty' if nothing landed at all, 'ok' otherwise. The
  // orchestrator's per-status counters depend on this matching the row's
  // body_status so the summary line doesn't double-count partials as ok.
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
