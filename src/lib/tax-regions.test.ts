import { describe, expect, it } from 'vitest'

import {
  addizionaleRegionale,
  findRegione,
  MEDIA_NAZIONALE,
  REGIONI,
  type Regione,
} from './tax-regions'

function regione(code: string): Regione {
  const r = REGIONI.find((x) => x.code === code)
  if (!r) throw new Error(`missing region ${code}`)
  return r
}

describe('regional data integrity', () => {
  it('covers all 20 regions plus the two autonomous provinces', () => {
    expect(REGIONI).toHaveLength(21)
    const istatCodes = new Set(REGIONI.map((r) => r.istat))
    expect(istatCodes.size).toBe(20)
  })

  it('gives every region a unique code and a source URL', () => {
    const codes = new Set(REGIONI.map((r) => r.code))
    expect(codes.size).toBe(REGIONI.length)
    for (const r of REGIONI) {
      expect(r.fonte).toMatch(/^https:\/\//)
      expect(r.nome.length).toBeGreaterThan(0)
    }
  })

  it('gives every region strictly ascending brackets ending at Infinity', () => {
    for (const r of REGIONI) {
      expect(r.brackets.length).toBeGreaterThan(0)
      expect(r.brackets[r.brackets.length - 1]!.upTo).toBe(Infinity)
      let prev = 0
      for (const b of r.brackets) {
        expect(b.upTo).toBeGreaterThan(prev)
        prev = b.upTo
        // No region may exceed the statutory ceiling by a wide margin;
        // Molise at 3,63% is the highest genuine figure on record.
        expect(b.rate).toBeGreaterThan(0)
        expect(b.rate).toBeLessThanOrEqual(0.04)
      }
    }
  })

  it('never charges anything on zero or negative income', () => {
    for (const r of REGIONI) {
      expect(addizionaleRegionale(0, r)).toBe(0)
      expect(addizionaleRegionale(-1_000, r)).toBe(0)
    }
  })
})

describe('progressive regions', () => {
  // Marche publishes its own worked table: "383,4 + 1,70% sulla parte
  // eccedente 28.000". Reproducing it exactly is an independent check
  // that the marginal path is right, not just self-consistent.
  it('matches the official Marche formula table', () => {
    const marche = regione('11')
    expect(addizionaleRegionale(15_000, marche)).toBeCloseTo(184.5, 2)
    expect(addizionaleRegionale(28_000, marche)).toBeCloseTo(383.4, 2)
    expect(addizionaleRegionale(30_000, marche)).toBeCloseTo(417.4, 2)
    expect(addizionaleRegionale(50_000, marche)).toBeCloseTo(757.4, 2)
  })

  // Piemonte likewise publishes "591,40 + 3,31% sulla parte eccedente 28.000".
  it('matches the official Piemonte formula table', () => {
    const piemonte = regione('01')
    expect(addizionaleRegionale(15_000, piemonte)).toBeCloseTo(243, 2)
    expect(addizionaleRegionale(28_000, piemonte)).toBeCloseTo(591.4, 2)
    expect(addizionaleRegionale(50_000, piemonte)).toBeCloseTo(1_319.6, 2)
    expect(addizionaleRegionale(30_000, piemonte)).toBeCloseTo(657.6, 2)
  })

  it('computes Lombardia slice by slice', () => {
    // 15.000 * 1,23% + 13.000 * 1,58% + 2.000 * 1,72%
    expect(addizionaleRegionale(30_000, regione('03'))).toBeCloseTo(424.3, 2)
  })

  it('rises smoothly across a progressive region threshold', () => {
    const er = regione('08')
    const before = addizionaleRegionale(27_999, er)
    const after = addizionaleRegionale(28_001, er)
    // A marginal system moves by cents across the boundary, not by euros.
    expect(after - before).toBeLessThan(1)
  })
})

describe('cliff regions', () => {
  it('applies one rate to the whole imponibile in Friuli-Venezia Giulia', () => {
    const fvg = regione('06')
    // At 15.000 the low rate still applies to everything.
    expect(addizionaleRegionale(15_000, fvg)).toBeCloseTo(105, 2)
    // Just above, 1,23% hits the ENTIRE amount, not only the excess.
    expect(addizionaleRegionale(15_001, fvg)).toBeCloseTo(15_001 * 0.0123, 2)
    // A marginal reading would have given roughly 105, not ~184.
    expect(addizionaleRegionale(15_001, fvg)).toBeGreaterThan(180)
  })

  it('produces a genuine jump at the Lazio threshold', () => {
    const lazio = regione('12')
    expect(addizionaleRegionale(28_000, lazio)).toBeCloseTo(484.4, 2)
    // Above 28.000: 3,33% on everything, less the 60 € detrazione.
    expect(addizionaleRegionale(28_001, lazio)).toBeCloseTo(28_001 * 0.0333 - 60, 2)
    const jump =
      addizionaleRegionale(28_001, lazio) - addizionaleRegionale(28_000, lazio)
    expect(jump).toBeGreaterThan(300)
  })

  it('drops the Lazio detrazione above 30.000', () => {
    const lazio = regione('12')
    expect(addizionaleRegionale(30_000, lazio)).toBeCloseTo(30_000 * 0.0333 - 60, 2)
    expect(addizionaleRegionale(30_001, lazio)).toBeCloseTo(30_001 * 0.0333, 2)
  })
})

describe('esenzioni and detrazioni', () => {
  it("exempts incomes up to 15.000 in Valle d'Aosta", () => {
    const vda = regione('02')
    expect(addizionaleRegionale(15_000, vda)).toBe(0)
    expect(addizionaleRegionale(20_000, vda)).toBeCloseTo(246, 2)
  })

  it('effectively exempts incomes up to 30.000 in Trento', () => {
    const tn = regione('04-TN')
    expect(addizionaleRegionale(30_000, tn)).toBe(0)
    expect(addizionaleRegionale(40_000, tn)).toBeCloseTo(492, 2)
  })

  it('wipes out the Bolzano addizionale for mid incomes via its detrazione', () => {
    const bz = regione('04-BZ')
    // 30.000 * 1,23% = 369, less a 430,50 detrazione -> nothing due.
    expect(addizionaleRegionale(30_000, bz)).toBe(0)
    // 50.000 * 1,23% + 10.000 * 1,73% = 788, less 430,50 = 357,50
    expect(addizionaleRegionale(60_000, bz)).toBeCloseTo(357.5, 2)
  })

  it('never turns a detrazione into a negative charge', () => {
    for (const r of REGIONI) {
      for (const reddito of [5_000, 12_000, 25_000, 29_000, 45_000, 90_000]) {
        expect(addizionaleRegionale(reddito, r)).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('applies the reduced Umbria rate below 28.000 and the ladder above', () => {
    const umbria = regione('10')
    // Below the threshold the maggiorazioni are waived: base 1,23%.
    expect(addizionaleRegionale(25_000, umbria)).toBeCloseTo(307.5, 2)
    // Above it the full ladder applies, less the 150 € detrazione.
    // 259,50 + 392,60 + 374,40 = 1.026,50 - 150 = 876,50
    expect(addizionaleRegionale(40_000, umbria)).toBeCloseTo(876.5, 2)
  })
})

describe('findRegione', () => {
  it('falls back to the national average for null or unknown codes', () => {
    expect(findRegione(null)).toBe(MEDIA_NAZIONALE)
    expect(findRegione('non-esiste')).toBe(MEDIA_NAZIONALE)
  })

  it('resolves a real code', () => {
    expect(findRegione('12').nome).toBe('Lazio')
  })

  it('charges the flat national average when no region is chosen', () => {
    expect(addizionaleRegionale(30_000, MEDIA_NAZIONALE)).toBeCloseTo(519, 2)
  })
})
