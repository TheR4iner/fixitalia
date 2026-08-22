// Typed fetchers for /api/parlamento.

import { getJson } from './_http'

const BASE = '/api/parlamento'

export type Chamber = 'camera' | 'senato'

// ---- /calendar -----------------------------------------------------------

export interface CalendarRow {
  ym: string // YYYY-MM
  chamber: Chamber
  count: number
}

export interface CalendarResponse {
  data: CalendarRow[]
  source: string
}

export function fetchParlamentoCalendar(
  params: { from?: string; to?: string; chamber?: Chamber; leg?: number } = {},
): Promise<CalendarResponse> {
  const qs = new URLSearchParams()
  if (params.from) qs.set('from', params.from)
  if (params.to) qs.set('to', params.to)
  if (params.chamber) qs.set('chamber', params.chamber)
  if (params.leg != null) qs.set('leg', String(params.leg))
  const tail = qs.toString() ? `?${qs.toString()}` : ''
  return getJson<CalendarResponse>(`${BASE}/calendar${tail}`)
}

// ---- /sedute -------------------------------------------------------------

export interface Seduta {
  id: string
  chamber: Chamber
  legislatura: number
  numero: number
  data: string
  titolo: string | null
  source_url: string | null
  html_url: string | null
  xml_url: string | null
  video_url: string | null
  interventi_n: number | null
  odg_n: number | null
  body_status: string | null
}

export interface SeduteResponse {
  data: Seduta[]
  page: number
  pageSize: number
  total: number
  source: string
}

export type SortOrder = 'newest' | 'oldest'

export function fetchSedute(
  params: {
    chamber?: Chamber
    page?: number
    pageSize?: number
    from?: string
    to?: string
    sort?: SortOrder
    leg?: number
  } = {},
): Promise<SeduteResponse> {
  const qs = new URLSearchParams()
  if (params.chamber) qs.set('chamber', params.chamber)
  if (params.page) qs.set('page', String(params.page))
  if (params.pageSize) qs.set('pageSize', String(params.pageSize))
  if (params.from) qs.set('from', params.from)
  if (params.to) qs.set('to', params.to)
  if (params.sort) qs.set('sort', params.sort)
  if (params.leg != null) qs.set('leg', String(params.leg))
  const tail = qs.toString() ? `?${qs.toString()}` : ''
  return getJson<SeduteResponse>(`${BASE}/sedute${tail}`)
}

// ---- /sedute/:chamber/:leg/:numero ---------------------------------------

export interface OdgEntry {
  posizione: number
  titolo: string
  anchor: string
}

export interface OratoreSummary {
  nome: string
  /** Persona id for building a link to the speaker page; null when the
   *  transcript provided a role-only label without a profile link. */
  id_persona: number | null
  gruppo: string | null
  ruolo: string | null
  interventi: number
}

export interface SedutaDetailResponse {
  seduta: Seduta
  odg: OdgEntry[]
  oratori: OratoreSummary[]
  source: string
}

export function fetchSedutaDetail(
  chamber: Chamber,
  legislatura: number,
  numero: number,
): Promise<SedutaDetailResponse> {
  return getJson<SedutaDetailResponse>(
    `${BASE}/sedute/${chamber}/${legislatura}/${numero}`,
  )
}

// ---- /interventi (paginated) ---------------------------------------------

export type RefTipo =
  | 'legge'
  | 'decreto.legge'
  | 'decreto.legislativo'
  | 'dpr'
  | 'costituzione'
  | 'ac'
  | 'as'

export interface Riferimento {
  tipo: RefTipo
  anno: number | null
  numero: string | null
  articolo: number | null
  urn: string | null
  url: string | null
  // 'ok' | 'pending' | 'failed' -- when not 'ok', url is null.
  resolve_status: string
  // Char offsets into the intervento's testo. start inclusive,
  // end_offset exclusive: testo.slice(start, end_offset) === raw.
  start: number
  end_offset: number
  raw: string
}

export interface Intervento {
  posizione: number
  oratore_nome: string | null
  /** Official persona id (camera/senato website's numeric ID). Null when
   *  the transcript used a role-only label ("PRESIDENTE.") with no link. */
  oratore_id_persona: number | null
  oratore_chamber: Chamber | null
  /** Authoritative current-leg group from the mandato; used when the
   *  transcript-derived `gruppo` is null (typical for Camera). */
  oratore_mandato_gruppo: string | null
  gruppo: string | null
  ruolo: string | null
  testo: string
  anchor: string
  odg_pos: number | null
  // Refs detected and persisted by the parlamento-refs ingest pass.
  // Empty array when the seduta has not been processed yet.
  riferimenti: Riferimento[]
}

export interface InterventiResponse {
  data: Intervento[]
  page: number
  pageSize: number
  total: number
}

export function fetchInterventi(
  chamber: Chamber,
  legislatura: number,
  numero: number,
  page = 1,
  pageSize = 200,
): Promise<InterventiResponse> {
  return getJson<InterventiResponse>(
    `${BASE}/sedute/${chamber}/${legislatura}/${numero}/interventi?page=${page}&pageSize=${pageSize}`,
  )
}

// ---- /search -------------------------------------------------------------

export interface SearchHit {
  posizione: number
  oratore_nome: string | null
  oratore_id_persona: number | null
  oratore_chamber: Chamber | null
  gruppo: string | null
  testo: string
  snippet: string
  anchor: string
  chamber: Chamber
  legislatura: number
  numero: number
  data: string
  odg_titolo: string | null
  score: number
}

export interface SearchResponse {
  data: SearchHit[]
  page: number
  pageSize: number
  /** Lower bound (page-aware): exact count on the last page, "+1" otherwise. */
  total: number
  /** True when the corpus contains additional matching results past this page. */
  has_more?: boolean
  q: string
}

export function searchParlamento(
  q: string,
  params: { chamber?: Chamber; page?: number } = {},
): Promise<SearchResponse> {
  const qs = new URLSearchParams({ q })
  if (params.chamber) qs.set('chamber', params.chamber)
  if (params.page) qs.set('page', String(params.page))
  return getJson<SearchResponse>(`${BASE}/search?${qs.toString()}`)
}

// ---- /persona/:chamber/:idPersona --------------------------------------------

export interface Persona {
  chamber: Chamber
  id_persona: number
  nome: string
  data_nascita?: string | null
  comune_nascita?: string | null
}

/**
 * One legislature in which the person served. Holds the per-leg gruppo,
 * circoscrizione, collegio, role, uffici/organi, etc. -- the data formerly
 * spread across `parlamento_oratori` + `parlamento_deputati`.
 */
export interface Mandato {
  legislatura: number
  nome: string | null
  gruppo_attuale: string | null
  gruppo_storico: Array<{ gruppo: string; dal: string | null; al: string | null }>
  circoscrizione: string | null
  collegio: string | null
  lista_elezione: string | null
  data_proclamazione: string | null
  formazione: string | null
  uffici: Array<{ ruolo: string | null; organo: string; dal: string | null; al: string | null }>
  organi: Array<{ organo: string; dal: string | null; al: string | null }>
  ruolo: string | null
  interventi_n: number | null
  source_url: string | null
  scrape_status: 'ok' | 'parse_error' | null
  fetched_at: string | null
}

export interface PersonaIntervento {
  chamber: Chamber
  legislatura: number
  numero: number
  data: string
  anchor: string
  testo: string
  /** Present only when q was set -- safely-bracketed <mark> highlights. */
  snippet?: string
  score?: number
  odg_titolo: string | null
}

export interface PersonaResponse {
  persona: Persona
  mandati: Mandato[]
  interventi: PersonaIntervento[]
  page: number
  pageSize: number
  /** When `q` is set, this is a page-aware lower bound, not an exact count
   *  (counting BM25 hits walks the full posting list). Use `has_more` to
   *  decide whether to show pagination past the last fetched page. */
  total: number
  has_more: boolean
  q: string
  /** Optional leg filter applied to the interventi list. */
  leg: number | null
  /** Set if the interventi query failed (persona + mandati still valid). */
  search_error: string | null
  source: string
}

export interface PersonaQueryParams {
  q?: string
  from?: string
  to?: string
  /** Restrict the interventi list to a single legislature. */
  leg?: number
  page?: number
  pageSize?: number
}

export function fetchPersona(
  chamber: Chamber,
  idPersona: number,
  params: PersonaQueryParams = {},
): Promise<PersonaResponse> {
  const qs = new URLSearchParams()
  if (params.q) qs.set('q', params.q)
  if (params.from) qs.set('from', params.from)
  if (params.to) qs.set('to', params.to)
  if (params.leg != null) qs.set('leg', String(params.leg))
  if (params.page) qs.set('page', String(params.page))
  if (params.pageSize) qs.set('pageSize', String(params.pageSize))
  const tail = qs.toString() ? `?${qs.toString()}` : ''
  return getJson<PersonaResponse>(`${BASE}/persona/${chamber}/${idPersona}${tail}`)
}

// ---- /refs/leggi-piu-citate --------------------------------------------------

export interface RefAggregate {
  tipo: string
  anno: number | null
  numero: string | null
  n: number
}

export interface LeggiCitateResponse {
  data: RefAggregate[]
  source: string
}

export function fetchLeggiPiuCitate(
  params: { leg?: number; chamber?: Chamber } = {},
): Promise<LeggiCitateResponse> {
  const qs = new URLSearchParams()
  if (params.leg != null) qs.set('leg', String(params.leg))
  if (params.chamber) qs.set('chamber', params.chamber)
  const tail = qs.toString() ? `?${qs.toString()}` : ''
  return getJson<LeggiCitateResponse>(`${BASE}/refs/leggi-piu-citate${tail}`)
}

// ---- /refs/legge/:tipo/:anno/:numero -----------------------------------------

export interface LawCitation {
  chamber: Chamber
  legislatura: number
  numero_seduta: number
  data: string
  oratore_nome: string | null
  oratore_id_persona: number | null
  oratore_chamber: Chamber | null
  gruppo: string | null
  ruolo: string | null
  anchor: string | null
}

export interface LeggeResponse {
  tipo: string
  anno: number | null
  numero: string
  total: number
  page: number
  pageSize: number
  has_more: boolean
  data: LawCitation[]
}

export function fetchLegge(
  tipo: string,
  anno: number | null,
  numero: string,
  params: { page?: number; pageSize?: number; chamber?: Chamber; leg?: number } = {},
): Promise<LeggeResponse> {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.pageSize) qs.set('pageSize', String(params.pageSize))
  if (params.chamber) qs.set('chamber', params.chamber)
  if (params.leg != null) qs.set('leg', String(params.leg))
  const tail = qs.toString() ? `?${qs.toString()}` : ''
  return getJson<LeggeResponse>(`${BASE}/refs/legge/${tipo}/${anno ?? 0}/${numero}${tail}`)
}

// ---- /legislature/:n ---------------------------------------------------------

export interface LegislatureStats {
  data_inizio: string | null
  data_fine: string | null
  n: number
}

export interface LegislatureTopSpeaker {
  id_persona: number
  chamber: Chamber
  nome: string | null
  gruppo_attuale: string | null
  interventi_n: number
}

export interface LegislatureTopLaw {
  tipo: string
  anno: number | null
  numero: string | null
  n: number
}

export interface LegislatureResponse {
  legislatura: number
  camera: LegislatureStats
  senato: LegislatureStats
  top_speakers: LegislatureTopSpeaker[]
  top_laws: LegislatureTopLaw[]
}

export function fetchLegislatura(n: number): Promise<LegislatureResponse> {
  return getJson<LegislatureResponse>(`${BASE}/legislature/${n}`)
}

// ---- /persona/search ---------------------------------------------------------

export interface PersonaSearchResult {
  nome: string
  chamber: Chamber
  id_persona: number
  legs: number[]
  ultimo_gruppo: string | null
  interventi_n: number
}

export interface PersonaSearchResponse {
  data: PersonaSearchResult[]
}

export function searchPersone(q: string, limit = 12): Promise<PersonaSearchResponse> {
  const qs = new URLSearchParams({ q, limit: String(limit) })
  return getJson<PersonaSearchResponse>(`${BASE}/persona/search?${qs.toString()}`)
}

// ---- Helpers -----------------------------------------------------------------

// ---- /transfughi -------------------------------------------------------------

export interface GruppoStorico {
  gruppo: string
  dal: string | null
  al: string | null
}

export interface Transfuga {
  id_persona: number
  chamber: Chamber
  legislatura: number
  nome: string | null
  gruppo_attuale: string | null
  gruppo_storico: GruppoStorico[]
  interventi_n: number | null
}

export interface TransfughiResponse {
  data: Transfuga[]
  legislatura: number
  chamber: Chamber
}

export function fetchTransfughi(params: { leg?: number; chamber?: Chamber } = {}): Promise<TransfughiResponse> {
  const qs = new URLSearchParams()
  if (params.leg != null) qs.set('leg', String(params.leg))
  if (params.chamber) qs.set('chamber', params.chamber)
  const tail = qs.toString() ? `?${qs.toString()}` : ''
  return getJson<TransfughiResponse>(`${BASE}/transfughi${tail}`)
}

// ---- /odg/search -------------------------------------------------------------

export interface OdgHit {
  titolo: string
  posizione: number
  anchor: string
  chamber: Chamber
  legislatura: number
  numero_seduta: number
  data: string
}

export interface OdgSearchResponse {
  data: OdgHit[]
  total: number
  page: number
  pageSize: number
  has_more: boolean
  q: string
}

export function searchOdg(
  q: string,
  params: { leg?: number; chamber?: Chamber; page?: number; pageSize?: number } = {},
): Promise<OdgSearchResponse> {
  const qs = new URLSearchParams({ q })
  if (params.leg != null) qs.set('leg', String(params.leg))
  if (params.chamber) qs.set('chamber', params.chamber)
  if (params.page) qs.set('page', String(params.page))
  if (params.pageSize) qs.set('pageSize', String(params.pageSize))
  return getJson<OdgSearchResponse>(`${BASE}/odg/search?${qs.toString()}`)
}

/** Build a canonical URL for the per-law detail page. */
export function leggeUrl(tipo: string, anno: number | null, numero: string): string {
  return `/parlamento/leggi/${tipo}/${anno ?? 0}/${encodeURIComponent(numero)}`
}

/** Render a human-readable law label (e.g. "Legge 328/1999"). */
export function leggeTipoLabel(tipo: string): string {
  const map: Record<string, string> = {
    legge: 'Legge',
    'decreto.legge': 'Decreto-legge',
    'decreto.legislativo': 'Decreto legislativo',
    dpr: 'DPR',
    ac: 'Atto Camera',
    as: 'Atto Senato',
    costituzione: 'Costituzione',
  }
  return map[tipo] ?? tipo
}

/**
 * Build the canonical URL for a speaker's persona page.
 *
 * Returns null when the speaker isn't resolvable to a persona (typically a
 * role-only label like "PRESIDENTE." that the transcript didn't link to a
 * profile). Callers render the speaker's name as plain text in that case.
 */
export function personaUrl(
  chamber: Chamber | null | undefined,
  idPersona: number | null | undefined,
): string | null {
  if (!chamber || idPersona == null) return null
  return `/parlamento/persona/${chamber}/${idPersona}`
}

/**
 * Build the canonical URL for a single seduta's reader page.
 *
 * The seduta is keyed by (chamber, legislatura, numero) end-to-end -- numero
 * alone is ambiguous across legislatures, so leg is part of the URL rather
 * than implicit. An optional `anchor` (e.g. "int-86") is appended as a hash
 * for jump-to-position navigation from search hits or persona pages.
 */
export function sedutaUrl(
  chamber: Chamber,
  legislatura: number,
  numero: number,
  anchor?: string | null,
): string {
  const base = `/parlamento/sedute/${chamber}/${legislatura}/${numero}`
  return anchor ? `${base}#${anchor}` : base
}
