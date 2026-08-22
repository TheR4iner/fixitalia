// Typed fetchers for the /api/appalti endpoints.

import { getJson } from './_http'

const BASE = '/api/appalti'

// ---- /kpis ------------------------------------------------------------------

export interface AppaltiKpis {
  attive: number
  regioniCoperte: number
  categorieGiuridiche: number
  abitantiPerStazione: number
}

export interface KpisResponse {
  data: AppaltiKpis
  source: string
}

export function fetchAppaltiKpis(): Promise<KpisResponse> {
  return getJson<KpisResponse>(`${BASE}/kpis`)
}

// ---- /by-natura -------------------------------------------------------------

export interface AppaltiNatura {
  nome: string | null
  count: number
}

export interface NaturaResponse {
  data: AppaltiNatura[]
  /**
   * Active stations with no legal form recorded by ANAC. Excluded from `data`
   * entirely -- not even folded into the "Altre categorie" tail -- so the bars
   * sum to less than the "stazioni attive" KPI. Disclosed on the chart.
   */
  senzaNatura: number
  source: string
}

export function fetchAppaltiByNatura(): Promise<NaturaResponse> {
  return getJson<NaturaResponse>(`${BASE}/by-natura`)
}

// ---- /by-regione ------------------------------------------------------------

export interface AppaltiRegione {
  regione: string | null
  count: number
}

export interface RegioneResponse {
  data: AppaltiRegione[]
  /**
   * Active stations whose province code ANAC does not map to a region. They
   * are absent from `data`, so the bars sum to less than the "stazioni attive"
   * KPI; the chart discloses this rather than letting the two disagree.
   */
  senzaRegione: number
  source: string
}

export function fetchAppaltiByRegione(): Promise<RegioneResponse> {
  return getJson<RegioneResponse>(`${BASE}/by-regione`)
}

// ---- /top-citta -------------------------------------------------------------

export interface AppaltiCitta {
  citta: string | null
  provincia: string | null
  regione: string | null
  count: number
}

export interface CittaResponse {
  data: AppaltiCitta[]
  source: string
}

export function fetchAppaltiTopCitta(limit = 20): Promise<CittaResponse> {
  return getJson<CittaResponse>(`${BASE}/top-citta?limit=${limit}`)
}
