import { describe, expect, it } from 'vitest'

import {
  bonusCuneoFiscale,
  computeTaxBreakdown,
  contributiInps,
  detrazioneConiuge,
  detrazioneFigli,
  detrazioneLavoroDipendente,
  detrazionePensione,
  irpefLorda,
  totalIncomeTax,
  trattamentoIntegrativo,
  ulterioreDetrazione,
  DEFAULT_TAX_INPUT,
  INPS_PRIMA_FASCIA,
  INPS_RATE,
  GESTIONE_SEPARATA_RATE,
  MASSIMALE_CONTRIBUTIVO,
  ARTIGIANI_MINIMALE,
  CASSE_AUTONOMI,
  type TaxInput,
} from './tax-calc'

// Every expected value below was worked through by hand from the statute,
// not produced by running the calculator -- otherwise the test would only
// prove that the calculator agrees with itself.

function input(overrides: Partial<TaxInput> = {}): TaxInput {
  return { ...DEFAULT_TAX_INPUT, ...overrides }
}

describe('irpefLorda (scaglioni 2026: 23 / 33 / 43)', () => {
  it('returns zero for zero or negative income', () => {
    expect(irpefLorda(0)).toBe(0)
    expect(irpefLorda(-5_000)).toBe(0)
  })

  it('applies a flat 23% up to 28.000', () => {
    expect(irpefLorda(15_000)).toBeCloseTo(3_450, 2)
    expect(irpefLorda(28_000)).toBeCloseTo(6_440, 2)
  })

  it('uses the 2026 rate of 33% between 28k and 50k, not the old 35%', () => {
    // 28.000 * 0,23 + 12.000 * 0,33 = 6.440 + 3.960 = 10.400
    expect(irpefLorda(40_000)).toBeCloseTo(10_400, 2)
    // At 50.000: 6.440 + 22.000 * 0,33 = 6.440 + 7.260 = 13.700
    expect(irpefLorda(50_000)).toBeCloseTo(13_700, 2)
    // The pre-2026 figure would have been 14.140. Guard against a revert.
    expect(irpefLorda(50_000)).not.toBeCloseTo(14_140, 2)
  })

  it('applies 43% above 50k', () => {
    expect(irpefLorda(60_000)).toBeCloseTo(18_000, 2)
    expect(irpefLorda(100_000)).toBeCloseTo(35_200, 2)
  })
})

describe('contributiInps', () => {
  it('is a flat 9,19% below the prima fascia', () => {
    expect(contributiInps(30_000)).toBeCloseTo(2_757, 2)
    expect(contributiInps(50_000)).toBeCloseTo(50_000 * INPS_RATE, 6)
  })

  it('adds the 1% aliquota aggiuntiva above the prima fascia', () => {
    // 60.000 * 0,0919 = 5.514, plus 1% of (60.000 - 56.224) = 37,76
    expect(contributiInps(60_000)).toBeCloseTo(5_551.76, 2)
  })

  it('does not apply the surcharge exactly at the threshold', () => {
    expect(contributiInps(INPS_PRIMA_FASCIA)).toBeCloseTo(
      INPS_PRIMA_FASCIA * INPS_RATE,
      6,
    )
  })
})

describe('detrazioneLavoroDipendente (art. 13 c. 1 e c. 1.1 TUIR)', () => {
  it('is 1.955 € up to 15k', () => {
    expect(detrazioneLavoroDipendente(10_000)).toBe(1_955)
    expect(detrazioneLavoroDipendente(15_000)).toBe(1_955)
  })

  it('tapers between 15k and 28k', () => {
    // 21.500: 1.910 + 1.190 * 6.500/13.000 = 2.505
    expect(detrazioneLavoroDipendente(21_500)).toBeCloseTo(2_505, 2)
    // At 28.000 the base figure is 1.910, but the income also sits inside
    // the 25.000-35.000 band, so the 65 € maggiorazione applies too.
    expect(detrazioneLavoroDipendente(28_000)).toBeCloseTo(1_975, 2)
  })

  it('tapers to zero between 28k and 50k', () => {
    // 40.000: 1.910 * 10.000/22.000 = 868,18 (no +65, income above 35k)
    expect(detrazioneLavoroDipendente(40_000)).toBeCloseTo(868.18, 2)
    expect(detrazioneLavoroDipendente(50_000)).toBeCloseTo(0, 6)
    expect(detrazioneLavoroDipendente(60_000)).toBe(0)
  })

  it('adds the 65 € maggiorazione only between 25k and 35k', () => {
    // Just below 25k: no bump.
    const below = detrazioneLavoroDipendente(25_000)
    expect(below).toBeCloseTo(1_910 + (1_190 * 3_000) / 13_000, 2)
    // 30.000: 1.910 * 20.000/22.000 = 1.736,36, plus 65 = 1.801,36
    expect(detrazioneLavoroDipendente(30_000)).toBeCloseTo(1_801.36, 2)
    // At 35.000 the bump still applies; just above it does not.
    expect(detrazioneLavoroDipendente(35_000)).toBeCloseTo(
      (1_910 * 15_000) / 22_000 + 65,
      2,
    )
    expect(detrazioneLavoroDipendente(35_001)).toBeCloseTo(
      (1_910 * 14_999) / 22_000,
      2,
    )
  })
})

describe('detrazionePensione (art. 13 c. 3 TUIR)', () => {
  it('is 1.955 € up to 8.500', () => {
    expect(detrazionePensione(8_500)).toBe(1_955)
  })

  it('tapers between 8.500 and 28.000', () => {
    // 20.000: 700 + 1.255 * 8.000/19.500 = 700 + 514,87 = 1.214,87
    expect(detrazionePensione(20_000)).toBeCloseTo(1_214.87, 2)
    expect(detrazionePensione(28_000)).toBeCloseTo(700, 2)
  })

  it('tapers to zero between 28.000 and 50.000', () => {
    // 39.000: 700 * 11.000/22.000 = 350
    expect(detrazionePensione(39_000)).toBeCloseTo(350, 2)
    expect(detrazionePensione(50_000)).toBeCloseTo(0, 6)
    expect(detrazionePensione(70_000)).toBe(0)
  })

  it('differs from the employee detrazione -- they are separate regimes', () => {
    expect(detrazionePensione(20_000)).not.toBeCloseTo(
      detrazioneLavoroDipendente(20_000),
      0,
    )
  })
})

describe('bonusCuneoFiscale', () => {
  // Signature is (redditoComplessivo, redditoLavoroDipendente): the first
  // gates eligibility, the second selects the band and is the base. These
  // tests pass a complessivo comfortably under the ceiling except where the
  // ceiling itself is what is being exercised.

  // The percentage applies FLAT to the whole income, not band by band.
  // This is the rule most third-party calculators get wrong.
  it('applies a single flat percentage, not a progressive sum', () => {
    // 18.000 * 4,8% = 864. A progressive reading would give ~1.092.
    expect(bonusCuneoFiscale(18_000, 18_000)).toBeCloseTo(864, 2)
    expect(bonusCuneoFiscale(18_000, 18_000)).not.toBeCloseTo(1_092, 0)
  })

  it('uses 7,1% up to 8.500', () => {
    expect(bonusCuneoFiscale(8_000, 8_000)).toBeCloseTo(568, 2)
    expect(bonusCuneoFiscale(8_500, 8_500)).toBeCloseTo(603.5, 2)
  })

  it('uses 5,3% between 8.500 and 15.000', () => {
    expect(bonusCuneoFiscale(12_000, 12_000)).toBeCloseTo(636, 2)
    expect(bonusCuneoFiscale(15_000, 15_000)).toBeCloseTo(795, 2)
  })

  it('uses 4,8% between 15.000 and 20.000 and stops above', () => {
    expect(bonusCuneoFiscale(20_000, 20_000)).toBeCloseTo(960, 2)
    expect(bonusCuneoFiscale(20_001, 20_001)).toBe(0)
    expect(bonusCuneoFiscale(30_000, 30_000)).toBe(0)
  })

  // Regression: the caller used to pass redditoComplessivo for BOTH roles.
  // The two diverge by the INPS contribution, so a gross just over the
  // ceiling slipped under it once contributions were deducted.
  it('gates on reddito complessivo but computes on the gross', () => {
    // RAL 21.500 -> contributi ~1.976 -> complessivo ~19.524. The old
    // single-argument form paid 19.524 * 4,8% = ~937 here.
    const complessivo = 21_500 - contributiInps(21_500)
    expect(complessivo).toBeLessThan(20_000)
    expect(bonusCuneoFiscale(complessivo, 21_500)).toBe(0)

    // And a case that IS eligible still pays on the gross, not the net of
    // contributions: 19.000 gross, complessivo ~17.254.
    const eligible = 19_000 - contributiInps(19_000)
    expect(bonusCuneoFiscale(eligible, 19_000)).toBeCloseTo(19_000 * 0.048, 2)
  })
})

describe('ulterioreDetrazione', () => {
  it('is zero at or below 20.000', () => {
    expect(ulterioreDetrazione(20_000)).toBe(0)
  })

  it('is a flat 1.000 € between 20.000 and 32.000', () => {
    expect(ulterioreDetrazione(25_000)).toBe(1_000)
    expect(ulterioreDetrazione(32_000)).toBe(1_000)
  })

  it('tapers linearly to zero between 32.000 and 40.000', () => {
    // 36.000: 1.000 * 4.000/8.000 = 500
    expect(ulterioreDetrazione(36_000)).toBeCloseTo(500, 2)
    expect(ulterioreDetrazione(40_000)).toBeCloseTo(0, 6)
    expect(ulterioreDetrazione(45_000)).toBe(0)
  })
})

describe('trattamentoIntegrativo', () => {
  it('pays the full 1.200 € below 15.000 when the capienza test passes', () => {
    // Imposta lorda comfortably above detrazione - 75.
    expect(trattamentoIntegrativo(14_000, 3_220, 1_955, 1_955)).toBe(1_200)
  })

  it('pays nothing below 15.000 when the imposta lorda is too small', () => {
    expect(trattamentoIntegrativo(5_000, 1_150, 1_955, 1_955)).toBe(0)
  })

  it('is capped by the incapienza between 15.000 and 28.000', () => {
    // Detrazioni exceed the imposta lorda by 400 -> only 400 survives.
    expect(trattamentoIntegrativo(20_000, 3_000, 2_500, 3_400)).toBeCloseTo(400, 2)
    // Detrazioni below the imposta lorda -> nothing.
    expect(trattamentoIntegrativo(20_000, 4_000, 2_500, 3_400)).toBe(0)
  })

  it('is never due above 28.000', () => {
    expect(trattamentoIntegrativo(30_000, 6_000, 1_800, 2_800)).toBe(0)
  })
})

describe('detrazioni familiari (art. 12 TUIR)', () => {
  it('computes the coniuge detrazione across its three bands', () => {
    // 10.000: 800 - 110 * 10.000/15.000 = 726,67
    expect(detrazioneConiuge(10_000)).toBeCloseTo(726.67, 2)
    // Flat 690 in the middle band, away from the small statutory bumps.
    expect(detrazioneConiuge(20_000)).toBe(690)
    // 60.000: 690 * 20.000/40.000 = 345
    expect(detrazioneConiuge(60_000)).toBeCloseTo(345, 2)
    expect(detrazioneConiuge(80_000)).toBeCloseTo(0, 6)
    expect(detrazioneConiuge(90_000)).toBe(0)
  })

  it('applies the small statutory bumps between 29.000 and 35.200', () => {
    expect(detrazioneConiuge(29_100)).toBe(700)
    expect(detrazioneConiuge(30_000)).toBe(710)
    expect(detrazioneConiuge(34_800)).toBe(720)
    expect(detrazioneConiuge(35_150)).toBe(700)
    expect(detrazioneConiuge(36_000)).toBe(690)
  })

  it('computes the figli detrazione and raises the ceiling per extra child', () => {
    // 40.000 with one child: 950 * (95.000 - 40.000)/95.000 = 550
    expect(detrazioneFigli(40_000, 1)).toBeCloseTo(550, 0)
    expect(detrazioneFigli(40_000, 0)).toBe(0)
    // Two children raise the ceiling to 110.000, so each child is worth more.
    expect(detrazioneFigli(40_000, 2)).toBeGreaterThan(2 * 550)
    // Above the ceiling nothing is due.
    expect(detrazioneFigli(95_000, 1)).toBe(0)
  })
})

describe('computeTaxBreakdown -- lavoratore dipendente', () => {
  it('returns all zeros for zero gross', () => {
    const b = computeTaxBreakdown(input({ grossAnnual: 0 }))
    expect(b.lordo).toBe(0)
    expect(b.contributi).toBe(0)
    expect(b.impostaNetta).toBe(0)
    expect(b.netto).toBe(0)
    expect(b.aliquotaEffettiva).toBe(0)
  })

  it('clamps negative input to zero', () => {
    const b = computeTaxBreakdown(input({ grossAnnual: -10_000 }))
    expect(b.lordo).toBe(0)
    expect(b.netto).toBe(0)
  })

  it('computes the full 2026 stack for a 30.000 € salary', () => {
    const b = computeTaxBreakdown(input({ grossAnnual: 30_000 }))
    // INPS: 30.000 * 0,0919 = 2.757
    expect(b.contributi).toBeCloseTo(2_757, 2)
    // Reddito complessivo: 27.243
    expect(b.redditoComplessivo).toBeCloseTo(27_243, 2)
    // IRPEF lorda: 27.243 * 0,23 = 6.265,89
    expect(b.impostaLorda).toBeCloseTo(6_265.89, 2)
    // Detrazione lavoro: 1.910 + 1.190 * 757/13.000 + 65 = 2.044,29
    expect(b.dettaglio.detrazioneRegime).toBeCloseTo(2_044.29, 2)
    // Ulteriore detrazione: full 1.000 (reddito is between 20k and 32k)
    expect(b.dettaglio.ulterioreDetrazione).toBe(1_000)
    // Imposta netta: 6.265,89 - 3.044,29 = 3.221,60
    expect(b.impostaNetta).toBeCloseTo(3_221.6, 2)
    // No bonus cuneo at this income, no trattamento integrativo.
    expect(b.bonus).toBe(0)
  })

  it('pays the bonus cuneo and the trattamento integrativo at low incomes', () => {
    const b = computeTaxBreakdown(input({ grossAnnual: 15_000 }))
    expect(b.dettaglio.bonusCuneo).toBeGreaterThan(0)
    expect(b.dettaglio.trattamentoIntegrativo).toBe(1_200)
    // The credits push the net income above the simple gross-minus-tax
    // figure, which is exactly what the old model got wrong.
    expect(b.netto).toBeGreaterThan(b.lordo - b.contributi - b.impostaLorda)
  })

  it('charges no addizionali when no IRPEF is due after detrazioni', () => {
    // At 9.000 the detrazione wipes out the imposta entirely.
    const b = computeTaxBreakdown(input({ grossAnnual: 9_000 }))
    expect(b.impostaNetta).toBe(0)
    expect(b.addizionaleRegionale).toBe(0)
    expect(b.addizionaleComunale).toBe(0)
  })

  it('keeps lordo = netto + totale trattenute for every realistic salary', () => {
    for (const lordo of [8_000, 15_000, 25_000, 35_000, 45_000, 80_000, 150_000]) {
      const b = computeTaxBreakdown(input({ grossAnnual: lordo }))
      expect(b.netto + b.totaleTrattenute).toBeCloseTo(lordo, 6)
      expect(b.totaleTrattenute).toBeCloseTo(b.contributi + b.imposteNette, 6)
    }
  })

  it('keeps the effective rate inside a plausible band', () => {
    const samples = [8_000, 15_000, 20_000, 25_000, 30_000, 40_000, 60_000, 100_000]
    for (const s of samples) {
      const r = computeTaxBreakdown(input({ grossAnnual: s })).aliquotaEffettiva
      expect(r).toBeGreaterThan(-0.1)
      expect(r).toBeLessThan(0.6)
    }
  })

  it('makes the effective rate rise with income above the credit cliff', () => {
    const samples = [25_000, 30_000, 40_000, 60_000, 100_000, 200_000]
    let prev = -Infinity
    for (const s of samples) {
      const r = computeTaxBreakdown(input({ grossAnnual: s })).aliquotaEffettiva
      expect(r).toBeGreaterThan(prev - 0.001)
      prev = r
    }
  })

  it('lowers the tax when a spouse and children are dependent', () => {
    const solo = computeTaxBreakdown(input({ grossAnnual: 35_000 }))
    const famiglia = computeTaxBreakdown(
      input({ grossAnnual: 35_000, coniugeACarico: true, figliACarico: 2 }),
    )
    expect(famiglia.detrazioni).toBeGreaterThan(solo.detrazioni)
    expect(famiglia.netto).toBeGreaterThan(solo.netto)
  })

  it('divides the net by the chosen number of mensilita', () => {
    const b = computeTaxBreakdown(input({ grossAnnual: 30_000, mensilita: 14 }))
    expect(b.nettoMensile).toBeCloseTo(b.netto / 14, 6)
  })
})

describe('computeTaxBreakdown -- pensionato', () => {
  it('charges no social contributions', () => {
    const b = computeTaxBreakdown(input({ grossAnnual: 25_000, regime: 'pensionato' }))
    expect(b.contributi).toBe(0)
    expect(b.redditoComplessivo).toBe(25_000)
  })

  it('gets no bonus cuneo and no ulteriore detrazione -- those are for employees', () => {
    const b = computeTaxBreakdown(input({ grossAnnual: 18_000, regime: 'pensionato' }))
    expect(b.dettaglio.bonusCuneo).toBe(0)
    expect(b.dettaglio.trattamentoIntegrativo).toBe(0)
    expect(b.dettaglio.ulterioreDetrazione).toBe(0)
  })

  it('nets more than an employee on the same gross, having no INPS to pay', () => {
    const pens = computeTaxBreakdown(input({ grossAnnual: 25_000, regime: 'pensionato' }))
    const dip = computeTaxBreakdown(input({ grossAnnual: 25_000, regime: 'dipendente' }))
    expect(pens.contributi).toBeLessThan(dip.contributi)
  })
})

describe('computeTaxBreakdown -- regime forfettario', () => {
  const forfettario = (over: Partial<TaxInput['forfettario']> = {}, gross = 50_000) =>
    computeTaxBreakdown(
      input({
        grossAnnual: gross,
        regime: 'forfettario',
        forfettario: { ...DEFAULT_TAX_INPUT.forfettario, ...over },
      }),
    )

  it('taxes only the coefficiente share of revenue', () => {
    const b = forfettario({ coefficiente: 0.78 })
    // Profit: 50.000 * 0,78 = 39.000. Contributions: 39.000 * 26,07% = 10.167,30
    // Base: 39.000 - 10.167,30 = 28.832,70. Imposta 15%: 4.324,905
    expect(b.contributi).toBeCloseTo(10_167.3, 2)
    expect(b.redditoComplessivo).toBeCloseTo(28_832.7, 2)
    expect(b.impostaNetta).toBeCloseTo(4_324.905, 2)
  })

  it('uses the 5% startup rate for the first five years', () => {
    const startup = forfettario({ startup: true })
    const ordinario = forfettario({ startup: false })
    expect(startup.impostaNetta).toBeCloseTo(ordinario.impostaNetta / 3, 2)
  })

  it('charges no addizionali -- the imposta sostitutiva replaces them', () => {
    const b = forfettario()
    expect(b.addizionaleRegionale).toBe(0)
    expect(b.addizionaleComunale).toBe(0)
  })

  it('grants no detrazioni, including for dependants', () => {
    const b = computeTaxBreakdown(
      input({
        grossAnnual: 50_000,
        regime: 'forfettario',
        coniugeACarico: true,
        figliACarico: 3,
      }),
    )
    expect(b.detrazioni).toBe(0)
  })

  it('applies the fixed contribution floor for artigiani', () => {
    // Tiny revenue: the fixed contribution still applies in full.
    const b = forfettario({ cassa: 'artigiani' }, 5_000)
    expect(b.contributi).toBeCloseTo(4_521.36, 2)
  })

  it('applies the 35% contribution reduction when claimed', () => {
    const full = forfettario({ cassa: 'artigiani' })
    const ridotto = forfettario({ cassa: 'artigiani', riduzioneContributiva: true })
    expect(ridotto.contributi).toBeCloseTo(full.contributi * 0.65, 2)
  })

  it('keeps lordo = netto + totale trattenute', () => {
    for (const ricavi of [15_000, 30_000, 50_000, 85_000]) {
      const b = forfettario({}, ricavi)
      expect(b.netto + b.totaleTrattenute).toBeCloseTo(ricavi, 6)
    }
  })

  it('always reports a plain twelfth as the monthly figure', () => {
    // A partita IVA has no thirteenth instalment, so the mensilita
    // selector must not leak into the forfettario result.
    const b = computeTaxBreakdown(
      input({ grossAnnual: 50_000, regime: 'forfettario', mensilita: 14 }),
    )
    expect(b.nettoMensile).toBeCloseTo(b.netto / 12, 6)
  })
})

describe('massimale contributivo (art. 2 c. 18 L. 335/1995)', () => {
  // The simulator had no ceiling at all, so contributions grew without bound.
  // These inputs sit above the forfettario revenue limit and are therefore
  // outside the regime, but the UI accepts any number, so the math still has
  // to be right rather than merely unreachable.
  const forfettarioAt = (gross: number, over: Partial<TaxInput['forfettario']> = {}) =>
    computeTaxBreakdown(
      input({
        grossAnnual: gross,
        regime: 'forfettario',
        forfettario: { ...DEFAULT_TAX_INPUT.forfettario, ...over },
      }),
    )

  it('caps the gestione separata base at the massimale', () => {
    // 200.000 * 0,78 = 156.000 of profit, above the 122.295 ceiling.
    const b = forfettarioAt(200_000, { cassa: 'gestione-separata', coefficiente: 0.78 })
    expect(b.contributi).toBeCloseTo(MASSIMALE_CONTRIBUTIVO * GESTIONE_SEPARATA_RATE, 2)
    // Sanity: that is materially less than the uncapped figure the old code gave.
    expect(b.contributi).toBeLessThan(156_000 * GESTIONE_SEPARATA_RATE)
  })

  it('caps the artigiani base at the massimale', () => {
    const b = forfettarioAt(200_000, { cassa: 'artigiani', coefficiente: 0.78 })
    const { contributoFisso, rate } = CASSE_AUTONOMI.artigiani
    const expected =
      contributoFisso + (MASSIMALE_CONTRIBUTIVO - ARTIGIANI_MINIMALE) * rate
    expect(b.contributi).toBeCloseTo(expected, 2)
  })

  it('leaves contributions untouched below the ceiling', () => {
    // Inside the legal forfettario limit the cap must never bind: 85.000 of
    // revenue at the highest coefficiente is 73.100 of profit.
    const b = forfettarioAt(85_000, { cassa: 'gestione-separata', coefficiente: 0.86 })
    expect(b.contributi).toBeCloseTo(85_000 * 0.86 * GESTIONE_SEPARATA_RATE, 2)
  })
})

describe('totalIncomeTax', () => {
  it('sums imposta netta and both addizionali, net of bonus, excluding contributi', () => {
    const b = computeTaxBreakdown(input({ grossAnnual: 35_000 }))
    expect(totalIncomeTax(b)).toBeCloseTo(
      b.impostaNetta + b.addizionaleRegionale + b.addizionaleComunale - b.bonus,
      6,
    )
    expect(totalIncomeTax(b)).toBeLessThan(b.totaleTrattenute)
  })

  it('never goes negative, even when the credits exceed the tax due', () => {
    const b = computeTaxBreakdown(input({ grossAnnual: 12_000 }))
    expect(totalIncomeTax(b)).toBeGreaterThanOrEqual(0)
  })
})
