import { parseHTML } from 'linkedom'
import type { BrowserContext } from 'playwright'
import { Table, RecordId, DateTime } from 'surrealdb'

import { runQuery, withDbRetry } from '../../query.ts'
import { cleanString } from '../../parse.ts'
import { parseSpeakerLabel, shortenTitle, slugify } from './parseHelpers.ts'
import {
  bumpMandatoInterventi,
  mandatoRecordId,
  upsertMandato,
  upsertPersona,
  type MandatoId,
} from './persona.ts'
import { fetchSenatoBodyHtml } from './senatoBrowser.ts'
import { syncSedutaToMeili } from './meiliSync.ts'

// -----------------------------------------------------------------------------
// Senato per-session ingest. The Senato does not publish stenografici as
// XML for floor sessions, only HTML (and PDF). We fetch the show-doc HTML
// and walk it to extract OdG headings + speaker turns.
//
// HTML shape: the show-doc page renders a single document with anchored
// section markers like:
//   <a name="..."> for OdG headings (rendered with a heading-class style)
//   speaker names appear inline, conventionally in bold, before each
//   intervention paragraph block. The exact selectors may shift across
//   years, so this parser uses several fallbacks.
// -----------------------------------------------------------------------------

interface IngestSessionResult {
  chamber: 'senato'
  numero: number
  odg_n: number
  interventi_n: number
  durationMs: number
  status: 'ok' | 'partial' | 'empty' | 'error'
  error?: string
}

interface SedutaRow {
  id: RecordId<'parlamento_sedute'>
  chamber: 'senato'
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
     WHERE chamber = "senato" AND legislatura = $leg AND numero = $num
     LIMIT 1;`,
    { leg: legislatura, num: numero },
  )
  return rows?.[0] ?? null
}

// HTTP-based fetch removed in 2026-05-14: every Senato transcript URL sits
// behind AWS WAF in challenge mode and returns HTTP 202 + an inline JS PoW to
// any client that doesn't execute JavaScript. Body content is now fetched via
// Playwright (see senatoBrowser.ts).

/**
 * Persist a Senato speaker as (persona, mandato) for the seduta's legislature.
 *
 * `idPersona` comes from the speaker anchor's `tipodoc=sanasen&id=NNNN`.
 * Speakers without an anchor (some "PRESIDENTE." lines) get no mandato; the
 * intervento still carries `oratore_nome` for display.
 *
 * `gruppo` is extracted from the inline `(GROUP)` in the speaker label
 * by parseSpeakerLabel and pre-populates the mandato so the seduta read
 * path doesn't need a second query. A later run of the deputati profile
 * scraper would enrich the row with circoscrizione, organi, etc.
 */
async function resolveMandato(
  legislatura: number,
  idPersona: number | null,
  nome: string,
  gruppo: string | null,
  ruolo: string | null,
): Promise<MandatoId | null> {
  if (idPersona == null) return null
  // The parser may not isolate a clean nome for every speaker label (some
  // anchors only carry role text). Fall back to a stable placeholder so the
  // persona row is never created with an empty string, which would render as
  // a blank link target on the UI.
  const displayName = nome.trim() || `id-${idPersona}`
  await upsertPersona({ chamber: 'senato', idPersona, nome: displayName })
  return await upsertMandato({
    chamber: 'senato',
    legislatura,
    idPersona,
    nome: displayName,
    gruppo,
    ruolo,
  })
}

interface ExtractedBlock {
  kind: 'odg' | 'intervento'
  titolo?: string
  speakerRaw?: string
  /** Senator's official numeric ID, parsed from the speaker anchor's
   *  `?...tipodoc=sanasen&id=NNNN`. Null when the speaker is a role-only
   *  label ("PRESIDENTE.") with no profile link. */
  idPersona?: number | null
  paragraphs: string[]
}

// Minimal duck-types: we don't pull in the full DOM lib (`lib: ["ES2022"]`
// in tsconfig keeps the server free of browser globals). linkedom's API is
// DOM-compatible for the methods we touch.
interface DomElement {
  tagName?: string
  textContent: string | null
  innerHTML?: string
  getAttribute(name: string): string | null
  classList: { contains(name: string): boolean }
  querySelector(sel: string): DomElement | null
  querySelectorAll(sel: string): DomElement[]
}
interface DomDocument {
  querySelector(sel: string): DomElement | null
  body: DomElement | null
}

// Speaker turns on Senato show-doc look like:
//   "PRESIDENTE. La seduta è aperta..."
//   "GARAVAGLIA (LSP-PSd'Az). Signora Presidente..."
//   "TESTOR, relatrice. Signor Presidente..."
// LASTNAME is all-caps (≥3 chars). Optional (GROUP) parens and optional
// ", lowercase-role" follow. Then a period terminator + space + body.
const SENATO_SPEAKER_RE =
  /^([A-ZÀÁÉÈÌÒÓÙ][A-ZÀÁÉÈÌÒÓÙ' -]{2,}(?:\s*\([^)]+\))?(?:,\s*[a-zà-ù][a-zà-ù]+)?)\.\s+(\S.+)$/

function isCenteredBold(el: DomElement): boolean {
  const style = el.getAttribute('style') ?? ''
  if (!/text-align:\s*center/i.test(style)) return false
  return /<b[\s>]/i.test(el.innerHTML ?? '')
}

/**
 * Extract the senator's persona id from a speaker-leading paragraph.
 *
 * The Senato wraps speaker names in:
 *   <a href="/loc/link.asp?leg=19&tipodoc=sanasen&id=32707">PRESIDENTE</a>
 *
 * We pluck `id` from the first such anchor inside the paragraph. Returns
 * null when the speaker is a role-only label without a profile link
 * (which happens for the Presidente in some sessions).
 */
function extractSenatoPersonaId(el: DomElement): number | null {
  const anchor = el.querySelector('a[href*="sanasen" i]')
  if (!anchor) return null
  const href = anchor.getAttribute('href') ?? ''
  const m = href.match(/[?&]id=(\d+)/)
  if (!m) return null
  const id = Number(m[1])
  return Number.isFinite(id) && id > 0 ? id : null
}

function extractBlocks(html: string): ExtractedBlock[] {
  const { document } = parseHTML(html) as unknown as { document: DomDocument }

  // Modern Senato show-doc puts the entire transcript inside <div class="bgt">.
  // Older selectors are kept as fallbacks in case the markup shifts.
  const container =
    document.querySelector('div.bgt') ||
    document.querySelector('#contenuto') ||
    document.querySelector('.testo') ||
    document.querySelector('main') ||
    document.body

  if (!container) return []

  const out: ExtractedBlock[] = []
  let current: ExtractedBlock | null = null
  // The transcript page opens with chrome (SENATO DELLA REPUBBLICA, XIX
  // LEGISLATURA, 419a SEDUTA, RESOCONTO STENOGRAFICO, group-abbreviations
  // legend, Presidenza...). These are centered+bold, all-uppercase. Real OdG
  // titles are mixed-case ("Sui lavori del Senato"). We start treating
  // centered+bold paragraphs as OdG headings only once we've seen the first
  // speaker turn — by then the chrome is behind us.
  let seenFirstSpeaker = false

  const nodes = Array.from(
    container.querySelectorAll(
      'h1, h2, h3, h4, p, div.titolo, div.titoletto, div.intervento, div.discorso',
    ),
  )

  for (const el of nodes) {
    const tag = el.tagName?.toLowerCase()
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue

    const isExplicitHeading =
      tag === 'h1' ||
      tag === 'h2' ||
      tag === 'h3' ||
      tag === 'h4' ||
      el.classList.contains('titolo') ||
      el.classList.contains('titoletto')

    const isCenteredBoldHeading =
      tag === 'p' && isCenteredBold(el) && text.length < 220 && seenFirstSpeaker

    if ((isExplicitHeading || isCenteredBoldHeading) && text.length < 220) {
      if (current) out.push(current)
      current = { kind: 'odg', titolo: text, paragraphs: [] }
      continue
    }

    const m = text.match(SENATO_SPEAKER_RE)
    if (m) {
      if (current) out.push(current)
      const speakerRaw = m[1].trim()
      const body = m[2].trim()
      current = {
        kind: 'intervento',
        speakerRaw,
        idPersona: extractSenatoPersonaId(el),
        paragraphs: body ? [body] : [],
      }
      seenFirstSpeaker = true
      continue
    }

    // Continuation paragraph for the current intervento (or the OdG body).
    if (current) {
      current.paragraphs.push(text)
    }
  }
  if (current) out.push(current)
  return out
}

export async function ingestSenatoSession(
  browserContext: BrowserContext,
  legislatura: number,
  numero: number,
): Promise<IngestSessionResult> {
  const started = Date.now()
  const seduta = await loadSeduta(legislatura, numero)
  if (!seduta) {
    return {
      chamber: 'senato',
      numero,
      odg_n: 0,
      interventi_n: 0,
      durationMs: Date.now() - started,
      status: 'error',
      error: `seduta senato/${legislatura}/${numero} not in parlamento_sedute -- run senato-index first`,
    }
  }

  let html: string
  try {
    html = await fetchSenatoBodyHtml(browserContext, seduta.html_url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await runQuery(
      `UPDATE $id SET body_status = "error", body_error = $err;`,
      { id: seduta.id, err: msg.slice(0, 500) },
    )
    return {
      chamber: 'senato',
      numero,
      odg_n: 0,
      interventi_n: 0,
      durationMs: Date.now() - started,
      status: 'error',
      error: msg,
    }
  }

  const blocks = extractBlocks(html)
  if (blocks.length === 0) {
    await runQuery(
      `UPDATE $id SET body_status = "empty", body_error = "no blocks extracted from HTML";`,
      { id: seduta.id },
    )
    return {
      chamber: 'senato',
      numero,
      odg_n: 0,
      interventi_n: 0,
      durationMs: Date.now() - started,
      status: 'empty',
    }
  }

  // Mark in-progress before any destructive write -- see the equivalent
  // comment in cameraSession.ts and project-kb/Parlamento body-pass
  // atomicity.md. A crash between this UPDATE and the final UPDATE leaves
  // `body_status = "ingesting"`, which listPending() recovers on the next
  // tick instead of leaving the seduta silently empty.
  await runQuery(
    `UPDATE $id SET body_status = "ingesting", body_error = NONE;`,
    { id: seduta.id },
  )

  await withDbRetry((d) =>
    d.query(
      `DELETE parlamento_odg WHERE seduta_id = $id;
       DELETE parlamento_interventi WHERE seduta_id = $id;`,
      { id: seduta.id },
    ),
  )

  const odgRows: Array<{
    id: RecordId<'parlamento_odg'>
    seduta_id: RecordId<'parlamento_sedute'>
    posizione: number
    titolo: string
    // Pre-lowercased title: what /odg/search actually matches against, so the
    // scan does not recompute string::lowercase() per row. See schema.ts.
    titolo_lower: string
    anchor: string
    // Denormalised from the seduta so /odg/search can filter and sort
    // without dereferencing the record link per row. See schema.ts.
    chamber: string
    legislatura: number
    data: Date
  }> = []
  const interventiRows: Array<{
    seduta_id: RecordId<'parlamento_sedute'>
    odg_id: RecordId<'parlamento_odg'> | null
    posizione: number
    mandato_id: MandatoId | null
    oratore_nome: string | null
    gruppo: string | null
    ruolo: string | null
    testo: string
    anchor: string
  }> = []
  const interventiPerPersona = new Map<number, number>()

  let odgPos = 0
  let intPos = 0
  let currentOdg: RecordId<'parlamento_odg'> | null = null

  for (const b of blocks) {
    if (b.kind === 'odg') {
      odgPos += 1
      const titolo = shortenTitle(cleanString(b.titolo) ?? `Argomento ${odgPos}`)
      const anchor = `odg-${odgPos}-${slugify(titolo).slice(0, 32)}`
      // ID namespace includes legislatura so leg-N seduta 1 and leg-M seduta 1
      // don't collide (the same agenda positions exist in every leg).
      const id = new RecordId(
        'parlamento_odg',
        `s-${legislatura}-${seduta.numero}-${odgPos}`,
      )
      odgRows.push({
        id,
        seduta_id: seduta.id,
        posizione: odgPos,
        titolo,
        titolo_lower: titolo.toLowerCase(),
        anchor,
        chamber: seduta.chamber,
        legislatura: seduta.legislatura,
        data: seduta.data.toDate(),
      })
      currentOdg = id
      continue
    }

    intPos += 1
    const text = b.paragraphs
      .map((p) => cleanString(p))
      .filter((p): p is string => Boolean(p))
      .join('\n\n')
    if (!text) {
      intPos -= 1
      continue
    }
    const parsedSpeaker = b.speakerRaw ? parseSpeakerLabel(b.speakerRaw, 'senato') : null
    const mandatoId = await resolveMandato(
      legislatura,
      b.idPersona ?? null,
      parsedSpeaker?.nome ?? '',
      parsedSpeaker?.gruppo ?? null,
      parsedSpeaker?.ruolo ?? null,
    )
    if (mandatoId && b.idPersona != null) {
      interventiPerPersona.set(
        b.idPersona,
        (interventiPerPersona.get(b.idPersona) ?? 0) + 1,
      )
    }
    interventiRows.push({
      seduta_id: seduta.id,
      odg_id: currentOdg,
      posizione: intPos,
      mandato_id: mandatoId,
      oratore_nome: parsedSpeaker?.nome ?? null,
      gruppo: parsedSpeaker?.gruppo ?? null,
      ruolo: parsedSpeaker?.ruolo ?? null,
      testo: text,
      anchor: `int-${intPos}`,
    })
  }

  if (odgRows.length > 0) {
    // Pin the generic to a single-row shape so SurrealDB's overload picks
    // the "T or T[]" form instead of inferring T = the whole array.
    await withDbRetry((d) => d.insert<Record<string, unknown>>(new Table('parlamento_odg'), odgRows))
  }

  let actuallyInserted = 0
  if (interventiRows.length > 0) {
    const cleaned: Record<string, unknown>[] = interventiRows.map((r) =>
      Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined)),
    )
    const BATCH_SIZE = 200
    const interventiTable = new Table('parlamento_interventi')
    for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
      const slice = cleaned.slice(i, i + BATCH_SIZE)
      try {
        await withDbRetry((d) => d.insert<Record<string, unknown>>(interventiTable, slice))
        actuallyInserted += slice.length
      } catch (err) {
        // Per-row fallback: one bad row shouldn't lose the whole batch. The
        // Senato parser doesn't get the same defensive coverage Camera does
        // (PDF/HTML quirks vary), so the survival path matters more here.
        console.warn(
          `[ingest:parlamento:senato-session] senato/${legislatura}/${numero} batch insert failed; per-row fallback:`,
          err instanceof Error ? err.message : err,
        )
        for (const row of slice) {
          try {
            await withDbRetry((d) => d.insert<Record<string, unknown>>(interventiTable, row))
            actuallyInserted += 1
          } catch (perRowErr) {
            console.warn(
              `[ingest:parlamento:senato-session] senato/${legislatura}/${numero} row pos=${(row as { posizione?: number }).posizione} skipped:`,
              perRowErr instanceof Error ? perRowErr.message : perRowErr,
            )
          }
        }
      }
    }
  }

  // Per-mandato speech counters. Best-effort: a drifted counter is benign
  // (we can re-aggregate from interventi if a UI ever needs exact values).
  for (const [idPersona, n] of interventiPerPersona) {
    await bumpMandatoInterventi(
      mandatoRecordId('senato', legislatura, idPersona),
      n,
    ).catch(() => {})
  }

  const isPartial = actuallyInserted < interventiRows.length
  const sedStatus = isPartial ? 'partial' : 'ok'
  const errorNote = isPartial
    ? `partial: inserted ${actuallyInserted}/${interventiRows.length} interventi`
    : null
  try {
    if (errorNote) {
      await runQuery(
        `UPDATE $id SET
           odg_n = $odgN, interventi_n = $intN,
           body_status = $st, body_error = $err;`,
        { id: seduta.id, odgN: odgRows.length, intN: actuallyInserted, st: sedStatus, err: errorNote },
      )
    } else {
      await runQuery(
        `UPDATE $id SET
           odg_n = $odgN, interventi_n = $intN,
           body_status = "ok", body_error = NONE;`,
        { id: seduta.id, odgN: odgRows.length, intN: actuallyInserted },
      )
    }
  } catch (err) {
    console.warn(
      `[ingest:parlamento:senato-session] senato/${legislatura}/${numero} status update failed:`,
      err instanceof Error ? err.message : err,
    )
  }

  // Mirror the freshly (re)inserted interventi into the Meilisearch index.
  // Best-effort; logs and continues on failure (see meiliSync.ts).
  await syncSedutaToMeili(seduta.id, `senato/${legislatura}/${numero}`)

  const durationMs = Date.now() - started
  console.log(
    `[ingest:parlamento:senato-session] senato/${legislatura}/${numero} -> ${odgRows.length} odg, ${actuallyInserted}/${interventiRows.length} interventi (status=${sedStatus}) in ${durationMs} ms`,
  )

  let outStatus: 'ok' | 'partial' | 'empty'
  if (odgRows.length === 0 && actuallyInserted === 0) outStatus = 'empty'
  else if (isPartial) outStatus = 'partial'
  else outStatus = 'ok'
  return {
    chamber: 'senato',
    numero,
    odg_n: odgRows.length,
    interventi_n: actuallyInserted,
    durationMs,
    status: outStatus,
  }
}
