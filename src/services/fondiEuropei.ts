// Typed fetchers for the /api/fondi-europei endpoints.

import { getJson } from './_http'

const BASE = '/api/fondi-europei'

// ---- /kpis ------------------------------------------------------------------

export interface FondiEuropeiKpis {
  costoPubblico: number
  costoPubblicoCoesione: number
  pagamenti: number
  pagamentiCoesione: number
  progetti: number
  quotaPagata: number
  dataAggiornamento: string | null
}

export interface KpisResponse {
  data: FondiEuropeiKpis
  source: string
}

export function fetchFondiEuropeiKpis(): Promise<KpisResponse> {
  return getJson<KpisResponse>(`${BASE}/kpis`)
}

// ---- /by-regione ------------------------------------------------------------

export interface FondiEuropeiRegione {
  codice: string | null
  nome: string | null
  costoPubblico: number
  costoPubblicoCoesione: number
  pagamenti: number
  pagamentiCoesione: number
  progetti: number
  quotaPagata: number
}

export interface RegioniResponse {
  data: FondiEuropeiRegione[]
  source: string
}

export function fetchFondiEuropeiByRegione(): Promise<RegioniResponse> {
  return getJson<RegioniResponse>(`${BASE}/by-regione`)
}

// ---- /by-tema ---------------------------------------------------------------

export interface FondiEuropeiTema {
  codice: string | null
  nome: string | null
  costoPubblico: number
  pagamenti: number
  progetti: number
  quotaPagata: number
}

export interface TemiResponse {
  data: FondiEuropeiTema[]
  source: string
}

export function fetchFondiEuropeiByTema(): Promise<TemiResponse> {
  return getJson<TemiResponse>(`${BASE}/by-tema`)
}

// ---- /by-stato --------------------------------------------------------------

export interface FondiEuropeiStato {
  codice: string | null
  nome: string | null
  progetti: number
  costoPubblico: number
  pagamenti: number
  quotaProgetti: number
}

export interface StatiResponse {
  data: FondiEuropeiStato[]
  totals: { progetti: number }
  source: string
}

export function fetchFondiEuropeiByStato(): Promise<StatiResponse> {
  return getJson<StatiResponse>(`${BASE}/by-stato`)
}

// ---- /yearly ----------------------------------------------------------------

export interface FondiEuropeiYearly {
  anno: number | null
  impegni: number
  pagamenti: number
}

export interface YearlyResponse {
  data: FondiEuropeiYearly[]
  source: string
}

export function fetchFondiEuropeiYearly(): Promise<YearlyResponse> {
  return getJson<YearlyResponse>(`${BASE}/yearly`)
}
