// Helpers shared between Camera and Senato ingest -- speaker-name
// normalisation, slug generation, OdG title cleanup. Kept apart from the
// chamber-specific parsers because both chambers share the same notion of
// "an intervention" and a "speaker": only the source markup differs.

import { cleanString } from '../../parse.ts'

/**
 * Normalise a speaker label that may include parenthetical group / role
 * qualifiers, e.g. "ROSSI Mario (Presidente)" or "MELONI Giorgia, Ministra".
 * Returns the structured triple. The caller passes through `chamber` so
 * the speaker slug stays disjoint between the two chambers (same surname
 * appears in both).
 */
export interface ParsedSpeaker {
  nome: string
  ruolo: string | null
  gruppo: string | null
  slug: string
}

const ROLE_HINTS = [
  'Presidente',
  'Vice Presidente',
  'Vicepresidente',
  'Vice presidente',
  'Ministro',
  'Ministra',
  'Sottosegretario',
  'Sottosegretaria',
  'Vice Ministro',
  'Vice Ministra',
  'Viceministro',
  'Viceministra',
  'Relatore',
  'Relatrice',
  'Segretario',
  'Segretaria',
] as const

function detectRole(raw: string): { role: string | null; rest: string } {
  for (const hint of ROLE_HINTS) {
    const re = new RegExp(`(^|[\\s,])${hint}\\b`, 'i')
    if (re.test(raw)) {
      // Strip the role label from the displayed name; keep the remainder.
      const rest = raw.replace(re, ' ').replace(/\s+/g, ' ').trim()
      return { role: hint, rest }
    }
  }
  return { role: null, rest: raw }
}

export function parseSpeakerLabel(rawLabel: string, chamber: 'camera' | 'senato'): ParsedSpeaker {
  const cleaned = cleanString(rawLabel) ?? ''
  // Pull out parenthetical qualifier as the group, if present.
  let label = cleaned
  let gruppo: string | null = null
  const paren = label.match(/\(([^)]+)\)\s*\.?$/)
  if (paren) {
    gruppo = cleanString(paren[1])
    label = label.replace(paren[0], '').trim()
  }
  const { role, rest } = detectRole(label)
  const nome = cleanString(rest) ?? cleaned
  return {
    nome,
    ruolo: role,
    gruppo,
    slug: speakerSlug(nome, chamber, role),
  }
}

/**
 * Generate a stable slug for a speaker. Same surname appears across the
 * two chambers so we prefix with chamber. Role is included so the same
 * person in different roles ("Mario Rossi, deputato" vs "Mario Rossi,
 * Ministro") stays distinguishable. This is intentionally pessimistic:
 * a future pass can merge by linking to OpenParlamento person IDs.
 */
export function speakerSlug(
  nome: string,
  chamber: 'camera' | 'senato',
  ruolo: string | null,
): string {
  const base = slugify(nome)
  const role = ruolo ? `-${slugify(ruolo)}` : ''
  return `${chamber}-${base}${role}`
}

/** URL-safe slug for any Italian title or label. */
export function slugify(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/**
 * Strip HTML tags into plain text suitable for full-text indexing. Keeps
 * inter-block whitespace as a single space, collapses runs.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\/?(p|div|li|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Trim a long OdG title for display while keeping the head readable.
 * The returned string is guaranteed to be at most `max` characters
 * including the trailing ellipsis.
 */
export function shortenTitle(raw: string, max = 140): string {
  if (raw.length <= max) return raw
  return raw.slice(0, max - 3).trimEnd() + '...'
}

/**
 * Browser-like User-Agent for fetches. The Italian gov sites are mostly
 * public but some (notably ANAC, but it does not hurt elsewhere) refuse
 * generic curl/node default headers.
 */
export const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'it-IT,it;q=0.9,en;q=0.5',
} as const

export interface FetchOptions {
  /** Per-attempt timeout in ms. Default 30s. */
  timeoutMs?: number
  /** Total attempts including the first. Default 3. */
  attempts?: number
  /** Initial backoff in ms; doubles each retry. Default 800. */
  backoffMs?: number
  /** HTTP statuses that should NOT trigger a retry (returned to caller). */
  passthroughStatuses?: number[]
  /** Extra request headers merged with BROWSER_HEADERS. */
  headers?: Record<string, string>
}

/**
 * Production-grade fetch wrapper.
 *
 *  - Adds an AbortController-backed timeout so a stalled gov site cannot
 *    hang the ingest indefinitely (default 30s).
 *  - Retries with exponential backoff on network errors (DNS, ECONNRESET,
 *    timeout) and on transient HTTP statuses (5xx, 408, 429). Other
 *    statuses including 404 are returned to the caller without retry --
 *    they represent real upstream answers, not flakiness.
 *  - Caller can pass `passthroughStatuses` to add more never-retry codes
 *    (e.g. 200 always passthrough; we use this for the 404 probe path).
 *
 * Retries are silent on attempts 1..N-1 and surfaced on the final
 * failure. This keeps logs readable for a 700-session crawl while still
 * surfacing the real failure when something is genuinely broken.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const attempts = Math.max(1, options.attempts ?? 3)
  const baseBackoff = options.backoffMs ?? 800
  const passthrough = new Set(options.passthroughStatuses ?? [])
  const headers = { ...BROWSER_HEADERS, ...(options.headers ?? {}) }

  let lastErr: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal })
      clearTimeout(timer)
      // Retry on transient HTTP statuses unless caller marked them passthrough.
      const transient = res.status >= 500 || res.status === 408 || res.status === 429
      if (transient && !passthrough.has(res.status) && attempt < attempts) {
        // Drain & discard body so the connection can be reused.
        await res.body?.cancel().catch(() => {})
        await sleep(baseBackoff * 2 ** (attempt - 1))
        continue
      }
      return res
    } catch (err) {
      clearTimeout(timer)
      lastErr = err
      if (attempt < attempts) {
        await sleep(baseBackoff * 2 ** (attempt - 1))
        continue
      }
    }
  }
  throw new Error(
    `fetchWithRetry failed for ${url} after ${attempts} attempts: ${formatErr(lastErr)}`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}
