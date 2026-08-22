import { describe, it, expect } from 'vitest'

import {
  parseSnapshot,
  selectSnapshots,
  type ResolvedBDAPSnapshot,
} from './spesaPubblica.ts'

// -----------------------------------------------------------------------------
// Regression tests for the two failures that put a wrong number in production:
//
//  1. Snapshot choice. The old code sorted BDAP's packages by
//     `metadata_modified` and took the first, which yielded the
//     January-February 2026 cumulative (195.477.227.576 EUR) rendered under
//     the caption "pagamenti del Bilancio dello Stato nel 2025". The real 2025
//     total is 1.154.165.459.884 EUR.
//
//  2. Silent zero. The `rnd` consuntivo packages spell the amount header
//     `Totale pagato` (lowercase p) and carry no `Mese contabile`. With the
//     old strict header map every row parsed with no amount at all, and the
//     three tolerance layers downstream turned that into "0 EUR" with no
//     error logged anywhere.
//
// The package names below are the real ones as published, including the
// modified timestamps that made the old ordering pick the wrong file.
// -----------------------------------------------------------------------------

const REAL_CATALOG = [
  { name: 'spd_giu_spe_pbs_mis_01_2026_01', metadata_modified: '2026-07-29T10:30:03' },
  { name: 'spd_mag_spe_pbs_mis_01_2026_01', metadata_modified: '2026-07-23T10:41:03' },
  { name: 'spd_rnd_spe_pbs_mis_01_2025', metadata_modified: '2026-07-13T10:23:42' },
  { name: 'spd_apr_spe_pbs_mis_01_2026_01', metadata_modified: '2026-06-17T11:27:09' },
  { name: 'spd_mar_spe_pbs_mis_01_2026_01', metadata_modified: '2026-05-18T15:28:02' },
  { name: 'spd_feb_spe_pbs_mis_01_2026_01', metadata_modified: '2026-04-01T10:25:13' },
  { name: 'spd_gen_spe_pbs_mis_01_2026_01', metadata_modified: '2026-03-30T10:20:00' },
  { name: 'spd_dic_spe_pbs_mis_01_2025_01', metadata_modified: '2026-01-15T10:11:44' },
  { name: 'spd_nov_spe_pbs_mis_01_2025_01', metadata_modified: '2025-12-30T11:45:39' },
  // Sibling series that share the prefix but are different rollups.
  { name: 'spd_ago_spe_pbs_misam_01_2025_01', metadata_modified: '2025-10-15T11:58:41' },
  { name: 'spd_set_spe_pbs_misce_01_2020_01', metadata_modified: '2020-10-20T10:28:20' },
  { name: 'spd_feb_spe_pbs_ammce_01_2026_01', metadata_modified: '2026-04-01T10:25:46' },
]

describe('selectSnapshots', () => {
  it('picks the December package for the annual total, not the newest one', () => {
    const { annuale } = selectSnapshots(REAL_CATALOG)
    expect(annuale.name).toBe('spd_dic_spe_pbs_mis_01_2025_01')
    expect(annuale.anno).toBe(2025)
    expect(annuale.mese).toBe(12)
  })

  it('exposes the newest monthly package separately as the year-to-date one', () => {
    const { progressivo } = selectSnapshots(REAL_CATALOG)
    expect(progressivo?.name).toBe('spd_giu_spe_pbs_mis_01_2026_01')
    expect(progressivo?.anno).toBe(2026)
    expect(progressivo?.mese).toBe(6)
  })

  it('ignores the rnd consuntivo and the sibling misam/misce/ammce series', () => {
    const { annuale, progressivo } = selectSnapshots(REAL_CATALOG)
    for (const picked of [annuale.name, progressivo?.name]) {
      expect(picked).not.toContain('_rnd_')
      expect(picked).not.toContain('misam')
      expect(picked).not.toContain('misce')
      expect(picked).not.toContain('ammce')
    }
  })

  it('reports no year-to-date snapshot when the newest package is a December', () => {
    const { annuale, progressivo } = selectSnapshots([
      { name: 'spd_dic_spe_pbs_mis_01_2025_01' },
      { name: 'spd_nov_spe_pbs_mis_01_2025_01' },
    ])
    expect(annuale.name).toBe('spd_dic_spe_pbs_mis_01_2025_01')
    expect(progressivo).toBeNull()
  })

  it('prefers the most recent year that has a December', () => {
    const { annuale } = selectSnapshots([
      { name: 'spd_dic_spe_pbs_mis_01_2024_01' },
      { name: 'spd_dic_spe_pbs_mis_01_2025_01' },
      { name: 'spd_mar_spe_pbs_mis_01_2026_01' },
    ])
    expect(annuale.anno).toBe(2025)
  })

  it('refuses to guess when no December package exists', () => {
    expect(() =>
      selectSnapshots([{ name: 'spd_mar_spe_pbs_mis_01_2026_01' }]),
    ).toThrow(/no December/i)
  })

  it('refuses to guess when the series has been renamed upstream', () => {
    expect(() => selectSnapshots([{ name: 'spd_dic_spe_pbs_newname_01_2025_01' }])).toThrow(
      /no spd_<month>/i,
    )
  })
})

const SNAPSHOT: ResolvedBDAPSnapshot = {
  periodo: 'annuale',
  anno: 2025,
  mese: 12,
  csvUrl: 'https://example.invalid/dump.csv',
  packageName: 'spd_dic_spe_pbs_mis_01_2025_01',
  packageUrl: 'https://example.invalid/catalog/spd_dic_spe_pbs_mis_01_2025_01',
  modified: '2026-01-15T10:11:44',
}

const HEADER =
  'Esercizio finanziario;Mese contabile;Codice Missione;Missione;OP Erario;' +
  'OP Tesoreria;OP Esterno;OA Tesoreria;OA Spesa Funz Deleg;RSF Stipendi;' +
  'RSF Altro;Totale Pagato'

const ROW_1 =
  '2025;DICEMBRE;034;Debito pubblico;0.00;359572434620.00;0.00;0.00;0.00;0.00;0.00;359572434620.00'
const ROW_2 =
  '2025;DICEMBRE;003;Relazioni finanziarie;0.00;148316246065.00;0.00;0.00;0.00;0.00;0.00;148316246065.00'

describe('parseSnapshot', () => {
  it('parses amounts and tags rows with the snapshot coverage', () => {
    const records = parseSnapshot([HEADER, ROW_1, ROW_2].join('\n'), SNAPSHOT)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      codice_missione: '034',
      missione: 'Debito pubblico',
      anno: 2025,
      mese_numero: 12,
      mese_contabile: 'dicembre',
      periodo: 'annuale',
      totale_pagato: 359_572_434_620,
      pacchetto: 'spd_dic_spe_pbs_mis_01_2025_01',
    })
  })

  it('accepts the lowercase "Totale pagato" spelling used by the consuntivo files', () => {
    const csv = [HEADER.replace('Totale Pagato', 'Totale pagato'), ROW_1].join('\n')
    expect(parseSnapshot(csv, SNAPSHOT)[0]?.totale_pagato).toBe(359_572_434_620)
  })

  it('throws instead of publishing zeros when the amount column is renamed', () => {
    const csv = [HEADER.replace('Totale Pagato', 'Importo Complessivo'), ROW_1].join('\n')
    expect(() => parseSnapshot(csv, SNAPSHOT)).toThrow(/not one resolved a "Totale Pagato"/i)
  })

  it('throws when every amount is zero rather than reporting a 0 EUR total', () => {
    const zeroed = ROW_1.replace(/359572434620\.00/g, '0.00')
    expect(() => parseSnapshot([HEADER, zeroed].join('\n'), SNAPSHOT)).toThrow(
      /cannot be a valid payments total/i,
    )
  })

  it('throws when the mission code column disappears', () => {
    const csv = [HEADER.replace('Codice Missione', 'Codice'), ROW_1].join('\n')
    expect(() => parseSnapshot(csv, SNAPSHOT)).toThrow(/without a "Codice Missione"/i)
  })

  it('throws on an empty file', () => {
    expect(() => parseSnapshot(HEADER, SNAPSHOT)).toThrow(/zero rows/i)
  })
})
