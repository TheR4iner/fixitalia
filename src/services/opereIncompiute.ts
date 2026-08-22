// Typed fetchers for the /api/opere-incompiute endpoints.

import { getJson } from './_http'

const BASE = '/api/opere-incompiute'

export interface OpereIncompiuteKpis {
  totalCount: number
  totalIntervento: number
  totalOneri: number
  avgAvanzamento: number
  regioniCoperte: number
  annoRiferimento: number | null
}

export interface KpisResponse {
  data: OpereIncompiuteKpis
  source: string
}

export function fetchOpereIncompiuteKpis(): Promise<KpisResponse> {
  return getJson<KpisResponse>(`${BASE}/kpis`)
}

export interface OpereIncompiuteRegionAgg {
  regione: string
  count: number
  totalIntervento: number
  avgAvanzamento: number
}

export interface RegionAggResponse {
  data: OpereIncompiuteRegionAgg[]
  /**
   * Works with no region resolved from the source file. Absent from `data`, so
   * the bars sum to less than the "opere censite" KPI; the chart discloses it.
   */
  senzaRegione: number
  source: string
}

export function fetchOpereIncompiuteByRegion(): Promise<RegionAggResponse> {
  return getJson<RegionAggResponse>(`${BASE}/by-region`)
}

export interface OperaIncompiuta {
  id: string
  titolo: string | null
  stazioneAppaltante: string | null
  provincia: string | null
  regione: string | null
  cup: string | null
  stato: string | null
  importoIntervento: number | null
  importoOneri: number | null
  percAvanzamento: number | null
  annoRiferimento: number | null
}

export interface OpereListResponse {
  data: OperaIncompiuta[]
  pagination: { total: number; limit: number; offset: number }
  source: string
}

export interface OpereListParams {
  limit?: number
  offset?: number
  regione?: string
}

export function fetchOpereIncompiute(params: OpereListParams = {}): Promise<OpereListResponse> {
  const qs = new URLSearchParams()
  if (params.limit != null) qs.set('limit', String(params.limit))
  if (params.offset != null) qs.set('offset', String(params.offset))
  if (params.regione) qs.set('regione', params.regione)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return getJson<OpereListResponse>(`${BASE}${suffix}`)
}
