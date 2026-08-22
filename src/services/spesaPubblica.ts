// Typed fetchers for the /api/spesa-pubblica endpoints.

import { getJson } from './_http'

const BASE = '/api/spesa-pubblica'

/**
 * Coverage of a spesa snapshot. `annuale` is a full calendar year,
 * `progressivo` is January-through-<meseNumero> of the year in progress.
 * The backend keeps both; the UI must label them differently.
 */
export type SpesaPeriodo = 'annuale' | 'progressivo'

export interface SpesaProgressivo {
  anno: number | null
  meseContabile: string | null
  meseNumero: number | null
  totalePagato: number
  totalCount: number
}

export interface SpesaPubblicaKpis {
  totalCount: number
  totalePagato: number
  maxPagato: number
  anno: number | null
  meseContabile: string | null
  pacchetto: string | null
  topMissione: {
    codice: string | null
    nome: string | null
    totale: number
  } | null
  progressivo: SpesaProgressivo | null
}

export interface KpisResponse {
  data: SpesaPubblicaKpis
  source: string
}

export function fetchSpesaPubblicaKpis(): Promise<KpisResponse> {
  return getJson<KpisResponse>(`${BASE}/kpis`)
}

export interface SpesaPubblicaMissioneAgg {
  codice: string | null
  missione: string | null
  totalePagato: number
  quota: number
}

export interface ByMissioneResponse {
  data: SpesaPubblicaMissioneAgg[]
  periodo: SpesaPeriodo
  anno: number | null
  source: string
}

export function fetchSpesaPubblicaByMissione(): Promise<ByMissioneResponse> {
  return getJson<ByMissioneResponse>(`${BASE}/by-missione`)
}

export interface SpesaPubblicaRow {
  id: string
  codice: string | null
  missione: string | null
  anno: number | null
  meseContabile: string | null
  opErario: number | null
  opTesoreria: number | null
  opEsterno: number | null
  oaTesoreria: number | null
  oaSpesaDeleg: number | null
  rsfStipendi: number | null
  rsfAltro: number | null
  totalePagato: number | null
}

export interface SpesaPubblicaListResponse {
  data: SpesaPubblicaRow[]
  pagination: { total: number; limit: number; offset: number }
  periodo: SpesaPeriodo
  anno: number | null
  source: string
}

export interface SpesaPubblicaListParams {
  limit?: number
  offset?: number
}

export function fetchSpesaPubblica(
  params: SpesaPubblicaListParams = {},
): Promise<SpesaPubblicaListResponse> {
  const qs = new URLSearchParams()
  if (params.limit != null) qs.set('limit', String(params.limit))
  if (params.offset != null) qs.set('offset', String(params.offset))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return getJson<SpesaPubblicaListResponse>(`${BASE}${suffix}`)
}
