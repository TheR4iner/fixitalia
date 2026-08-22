// Italian payroll / income tax calculator -- stima orientativa, anno d'imposta 2026.
//
// This models the three regimes that cover the vast majority of Italian
// taxpayers: lavoratore dipendente, pensionato, and partita IVA in regime
// forfettario. It is a simplification, but a deliberate and documented one:
// every term below carries the legal reference it implements, so that when
// the next legge di bilancio moves a number it is obvious what to change.
//
// IMPORTANT vocabulary note. Throughout this file `redditoComplessivo`
// means gross income minus mandatory social contributions (contributi
// previdenziali obbligatori, which are deducible). Every art. 12 / art. 13
// TUIR formula is parametrised on reddito complessivo, NOT on the raw
// gross, so the two must never be conflated.
//
// Sources (all verified for the 2026 tax year):
//  - IRPEF scaglioni: legge di bilancio 2026 cut the second bracket from
//    35% to 33%. Brackets are now 23% / 33% / 43%.
//  - Detrazione lavoro dipendente: art. 13 c. 1 TUIR, plus the +65 EUR
//    of art. 13 c. 1.1 for redditi 25.000-35.000.
//  - Detrazione pensione: art. 13 c. 3 TUIR.
//  - Bonus "cuneo fiscale": L. 207/2024 art. 1 c. 4-5, made permanent by
//    the 2026 manovra. A non-taxable sum for redditi da lavoro dipendente
//    up to 20.000, computed as a FLAT percentage of the whole amount
//    (Agenzia delle Entrate, circolare 4/E del 16 maggio 2025).
//  - Ulteriore detrazione: L. 207/2024 art. 1 c. 6, for redditi
//    complessivi 20.000-40.000.
//  - Trattamento integrativo (ex bonus Renzi): DL 3/2020 as amended,
//    1.200 EUR for redditi up to 15.000 subject to a capienza test.
//  - Detrazioni familiari a carico: art. 12 TUIR. Since the 2025 reform
//    the detrazione figli applies only to children aged 21-30 (under 21
//    are covered by the Assegno Unico Universale, not by IRPEF).
//  - INPS dipendenti: 9,19% aliquota AGO standard, plus the 1% aliquota
//    aggiuntiva on the portion above the prima fascia di retribuzione
//    pensionabile (56.224 EUR for 2026).
//  - Regime forfettario: imposta sostitutiva 5% (first five years of a
//    new activity) or 15%, on ricavi x coefficiente di redditivita minus
//    mandatory contributions. Replaces IRPEF AND both addizionali.
//
// Everything is computed in EUR per year.

import {
  addizionaleRegionale,
  ADDIZIONALE_COMUNALE_MEDIA,
  findRegione,
  type RegioneCode,
} from './tax-regions'

// --- National constants -------------------------------------------------

/** The tax year this module implements. Surfaced in the UI. */
export const TAX_YEAR = 2026

/** Standard employee INPS rate (aliquota AGO, settore privato). */
export const INPS_RATE = 0.0919

/**
 * Above the prima fascia di retribuzione pensionabile the employee pays
 * an extra 1% (art. 3-ter DL 384/1992). 2026 threshold.
 */
export const INPS_PRIMA_FASCIA = 56_224
export const INPS_RATE_AGGIUNTIVA = 0.01

/** 2026 IRPEF scaglioni: 23% / 33% / 43%. */
const IRPEF_BRACKETS: ReadonlyArray<{ threshold: number; rate: number }> = [
  { threshold: 28_000, rate: 0.23 },
  { threshold: 50_000, rate: 0.33 },
  { threshold: Infinity, rate: 0.43 },
]

/**
 * Redditi above this lose 440 EUR of detrazioni, so that the 33% bracket
 * cut does not benefit very high earners (legge di bilancio 2026).
 *
 * Scope caveat: in the statute the cut bites the detrazioni per oneri al 19%
 * (excluding spese sanitarie, erogazioni ai partiti and premi per eventi
 * calamitosi), NOT the art. 12/13 detrazioni this module models. We apply it to
 * the art. 12/13 total, which is harmless today only because all of those are
 * already zero at 200.000 EUR of reddito complessivo -- so the clamp is a
 * no-op. If a 19% oneri input is ever added, move the clawback onto it rather
 * than leaving it here.
 */
const DETRAZIONI_CLAWBACK_SOGLIA = 200_000
const DETRAZIONI_CLAWBACK_IMPORTO = 440

/** Income ceiling for a family member to count as fiscalmente a carico. */
export const LIMITE_FAMILIARE_A_CARICO = 2_840.51

// --- Regimes ------------------------------------------------------------

export type Regime = 'dipendente' | 'pensionato' | 'forfettario'

/**
 * Coefficienti di redditivita for the regime forfettario. The coefficient
 * is the share of revenue treated as taxable profit; the remainder is a
 * lump-sum allowance for costs. Keyed by activity group; the Italian
 * labels shown to the user live in the i18n module, not here.
 */
export const COEFFICIENTI_REDDITIVITA = [0.4, 0.54, 0.62, 0.67, 0.78, 0.86] as const

export type CoefficienteRedditivita = (typeof COEFFICIENTI_REDDITIVITA)[number]

/**
 * Gestione Separata INPS rate for professionals without a cassa (2026).
 * INPS circolare 8 del 3 febbraio 2026.
 */
export const GESTIONE_SEPARATA_RATE = 0.2607

/**
 * Contribution ceiling (massimale annuo di reddito imponibile) for 2026,
 * shared by the Gestione Separata and the artigiani/commercianti gestioni:
 * income above it carries no further contribution.
 *
 * Simplifying assumption, stated because it matters: the ceiling applies to
 * workers first registered with mandatory pension insurance from 1996 onward
 * (art. 2 c. 18 L. 335/1995). We cannot know a user's registration date, so we
 * apply it to everyone. For a pre-1996 registrant this under-states
 * contributions at very high income.
 *
 * Without the cap the simulator over-charged high revenues without bound --
 * 200.000 EUR of compensi on gestione separata produced 40.669 EUR of
 * contributions where the legal maximum is 31.882 EUR.
 */
export const MASSIMALE_CONTRIBUTIVO = 122_295

/**
 * Revenue ceiling of the regime forfettario (art. 1 c. 54 L. 190/2014, as
 * raised to 85.000 by L. 197/2022). Above it the regime does not apply at all,
 * so every figure this module computes for a forfettario stops being valid.
 * The UI surfaces this rather than silently returning a 15% flat tax on an
 * amount that legally cannot be in the regime.
 */
export const FORFETTARIO_LIMITE_RICAVI = 85_000

/**
 * Artigiani e commercianti pay a fixed contribution covering income up to
 * the minimale, then a percentage on the excess. Above the prima fascia
 * the rate gains one point. Figures from INPS circolare 14 del 9 febbraio
 * 2026. Forfettari may opt for a 35% reduction on the whole amount.
 */
export const ARTIGIANI_MINIMALE = 18_808
export const RIDUZIONE_FORFETTARIA = 0.35

export const CASSE_AUTONOMI = {
  artigiani: { contributoFisso: 4_521.36, rate: 0.24 },
  commercianti: { contributoFisso: 4_611.64, rate: 0.2448 },
} as const

export type CassaPrevidenziale = 'gestione-separata' | 'artigiani' | 'commercianti'

// --- Primitives ---------------------------------------------------------

/**
 * Apply the progressive IRPEF brackets to a taxable amount. Returns the
 * gross tax before any detrazione.
 */
export function irpefLorda(redditoComplessivo: number): number {
  if (redditoComplessivo <= 0) return 0
  let tax = 0
  let lowerBound = 0
  for (const { threshold, rate } of IRPEF_BRACKETS) {
    if (redditoComplessivo <= threshold) {
      return tax + (redditoComplessivo - lowerBound) * rate
    }
    tax += (threshold - lowerBound) * rate
    lowerBound = threshold
  }
  return tax
}

/**
 * Employee INPS contribution: 9,19% on the whole gross, plus 1% on the
 * portion exceeding the prima fascia di retribuzione pensionabile.
 */
export function contributiInps(lordo: number): number {
  if (lordo <= 0) return 0
  const base = lordo * INPS_RATE
  const eccedenza = Math.max(0, lordo - INPS_PRIMA_FASCIA)
  return base + eccedenza * INPS_RATE_AGGIUNTIVA
}

/**
 * Detrazione per redditi da lavoro dipendente -- art. 13 c. 1 TUIR,
 * including the +65 EUR of c. 1.1 for redditi between 25.000 and 35.000.
 */
export function detrazioneLavoroDipendente(redditoComplessivo: number): number {
  if (redditoComplessivo <= 0) return 0

  let detrazione: number
  if (redditoComplessivo <= 15_000) {
    detrazione = 1_955
  } else if (redditoComplessivo <= 28_000) {
    detrazione = 1_910 + (1_190 * (28_000 - redditoComplessivo)) / 13_000
  } else if (redditoComplessivo <= 50_000) {
    detrazione = (1_910 * (50_000 - redditoComplessivo)) / 22_000
  } else {
    return 0
  }

  // art. 13 c. 1.1: maggiorazione di 65 EUR nella fascia 25.000-35.000.
  if (redditoComplessivo > 25_000 && redditoComplessivo <= 35_000) {
    detrazione += 65
  }
  return detrazione
}

/** Detrazione per redditi da pensione -- art. 13 c. 3 TUIR. */
export function detrazionePensione(redditoComplessivo: number): number {
  if (redditoComplessivo <= 0) return 0
  if (redditoComplessivo <= 8_500) return 1_955
  if (redditoComplessivo <= 28_000) {
    return 700 + (1_255 * (28_000 - redditoComplessivo)) / 19_500
  }
  if (redditoComplessivo <= 50_000) {
    return (700 * (50_000 - redditoComplessivo)) / 22_000
  }
  return 0
}

/**
 * Bonus "taglio del cuneo fiscale" -- a non-taxable sum paid to employees
 * (L. 207/2024 art. 1 c. 4-5).
 *
 * TWO DIFFERENT INCOMES drive this, and conflating them is the single most
 * commonly mis-implemented part of the 2025-2026 reform:
 *
 *   - ELIGIBILITY is gated on `redditoComplessivo` (gross minus mandatory
 *     contributions): the bonus is due only up to 20.000 EUR.
 *   - The PERCENTAGE and the BASE it applies to are the `reddito di lavoro
 *     dipendente`, i.e. the gross employment income.
 *
 * The percentage is applied FLAT to the whole amount, not band by band: a
 * worker on 18.000 gets 18.000 x 4,8% = 864, not a progressive sum (Agenzia
 * delle Entrate, circolare 4/E del 16 maggio 2025).
 *
 * This function used to take a single argument and the caller passed
 * `redditoComplessivo` for both roles, despite the parameter being named
 * `redditoLavoroDipendente` and the module header warning that the two must
 * never be conflated. At a RAL of 21.500 that produced a 937 EUR bonus where
 * the correct answer is 0, because reddito complessivo (~19.524) slipped
 * under the 20.000 ceiling that the gross (21.500) exceeds.
 */
export function bonusCuneoFiscale(
  redditoComplessivo: number,
  redditoLavoroDipendente: number,
): number {
  if (redditoLavoroDipendente <= 0) return 0
  // Eligibility ceiling, on reddito complessivo.
  if (redditoComplessivo > 20_000) return 0
  // Band selection and base, on reddito di lavoro dipendente.
  if (redditoLavoroDipendente <= 8_500) return redditoLavoroDipendente * 0.071
  if (redditoLavoroDipendente <= 15_000) return redditoLavoroDipendente * 0.053
  if (redditoLavoroDipendente <= 20_000) return redditoLavoroDipendente * 0.048
  return 0
}

/**
 * Ulteriore detrazione for redditi complessivi between 20.000 and 40.000
 * (L. 207/2024 art. 1 c. 6). Flat 1.000 EUR up to 32.000, then tapering
 * linearly to zero at 40.000.
 */
export function ulterioreDetrazione(redditoComplessivo: number): number {
  if (redditoComplessivo <= 20_000) return 0
  if (redditoComplessivo <= 32_000) return 1_000
  if (redditoComplessivo <= 40_000) {
    return (1_000 * (40_000 - redditoComplessivo)) / 8_000
  }
  return 0
}

/**
 * Trattamento integrativo (ex bonus Renzi), 1.200 EUR/year.
 *
 * Up to 15.000 it is due in full provided the imposta lorda exceeds the
 * detrazione da lavoro dipendente reduced by 75 EUR (the "capienza"
 * test). Between 15.000 and 28.000 it survives only up to the amount by
 * which the taxpayer's detrazioni exceed the imposta lorda.
 */
export function trattamentoIntegrativo(
  redditoComplessivo: number,
  impostaLorda: number,
  detrazioneLavoro: number,
  detrazioniTotali: number,
): number {
  if (redditoComplessivo <= 0) return 0

  if (redditoComplessivo <= 15_000) {
    return impostaLorda > detrazioneLavoro - 75 ? 1_200 : 0
  }
  if (redditoComplessivo <= 28_000) {
    const incapienza = detrazioniTotali - impostaLorda
    return Math.max(0, Math.min(1_200, incapienza))
  }
  return 0
}

/**
 * Detrazione per coniuge a carico -- art. 12 c. 1 lett. a TUIR.
 * Parametrised on the taxpayer's own reddito complessivo.
 */
export function detrazioneConiuge(redditoComplessivo: number): number {
  if (redditoComplessivo <= 0) return 0
  if (redditoComplessivo <= 15_000) {
    return 800 - (110 * redditoComplessivo) / 15_000
  }
  if (redditoComplessivo <= 40_000) {
    // The law adds small bumps of 10-30 EUR in narrow bands between
    // 29.000 and 35.200. They are worth a few euro but they are in the
    // statute, so we implement them rather than rounding them away.
    let extra = 0
    if (redditoComplessivo > 29_000 && redditoComplessivo <= 29_200) extra = 10
    else if (redditoComplessivo > 29_200 && redditoComplessivo <= 34_700) extra = 20
    else if (redditoComplessivo > 34_700 && redditoComplessivo <= 35_000) extra = 30
    else if (redditoComplessivo > 35_000 && redditoComplessivo <= 35_100) extra = 20
    else if (redditoComplessivo > 35_100 && redditoComplessivo <= 35_200) extra = 10
    return 690 + extra
  }
  if (redditoComplessivo <= 80_000) {
    return (690 * (80_000 - redditoComplessivo)) / 40_000
  }
  return 0
}

/**
 * Detrazione per figli a carico -- art. 12 c. 1 lett. c TUIR.
 *
 * Only children aged 21 to 30 qualify: under 21 the support runs through
 * the Assegno Unico Universale (which is not an IRPEF detrazione at all),
 * and the 2025 reform capped the upper age at 30 except for children
 * with a recognised disability.
 */
export function detrazioneFigli(redditoComplessivo: number, numeroFigli: number): number {
  if (numeroFigli <= 0 || redditoComplessivo <= 0) return 0
  // The 95.000 ceiling is raised by 15.000 for each child after the first.
  const ceiling = 95_000 + 15_000 * (numeroFigli - 1)
  if (redditoComplessivo >= ceiling) return 0
  const coefficiente = (ceiling - redditoComplessivo) / ceiling
  return 950 * numeroFigli * coefficiente
}

// --- Input and output shapes --------------------------------------------

export interface ForfettarioOptions {
  /** Share of revenue treated as taxable profit. */
  coefficiente: number
  /** 5% imposta sostitutiva for the first five years of a new activity. */
  startup: boolean
  cassa: CassaPrevidenziale
  /** Artigiani/commercianti forfettari may claim a 35% contribution cut. */
  riduzioneContributiva: boolean
}

export interface TaxInput {
  /**
   * Annual gross: RAL for dipendente, pensione lorda for pensionato,
   * ricavi/compensi for forfettario.
   */
  grossAnnual: number
  regime: Regime
  /** null falls back to the national average addizionale regionale. */
  regione: RegioneCode | null
  /** Municipal rate as a fraction; null falls back to the national average. */
  aliquotaComunale: number | null
  coniugeACarico: boolean
  /** Dependent children aged 21-30. */
  figliACarico: number
  forfettario: ForfettarioOptions
  /** Presentation only: how many instalments the net is paid in. */
  mensilita: 12 | 13 | 14
}

export const DEFAULT_TAX_INPUT: TaxInput = {
  grossAnnual: 30_000,
  regime: 'dipendente',
  regione: null,
  aliquotaComunale: null,
  coniugeACarico: false,
  figliACarico: 0,
  forfettario: {
    coefficiente: 0.78,
    startup: false,
    cassa: 'gestione-separata',
    riduzioneContributiva: false,
  },
  mensilita: 13,
}

export interface TaxBreakdown {
  regime: Regime
  /** Annual gross exactly as input. */
  lordo: number
  /** Mandatory social contributions (INPS or gestione separata). */
  contributi: number
  /** Gross minus contributions -- the reddito complessivo. */
  redditoComplessivo: number
  /** IRPEF lorda, or the imposta sostitutiva base for a forfettario. */
  impostaLorda: number
  /** Every detrazione applied, summed. */
  detrazioni: number
  /** Imposta after detrazioni, floored at zero. */
  impostaNetta: number
  addizionaleRegionale: number
  addizionaleComunale: number
  /**
   * Credits paid out on top of the salary: bonus cuneo fiscale plus
   * trattamento integrativo. These are money received, not tax paid.
   */
  bonus: number
  /**
   * Net tax burden on income: imposta netta + addizionali - bonus. Can be
   * negative at low incomes, where the credits exceed the tax due.
   */
  imposteNette: number
  /** contributi + imposteNette. */
  totaleTrattenute: number
  netto: number
  nettoMensile: number
  aliquotaEffettiva: number
  /** Per-term detail, for the UI to explain the result honestly. */
  dettaglio: {
    detrazioneRegime: number
    ulterioreDetrazione: number
    detrazioneConiuge: number
    detrazioneFigli: number
    bonusCuneo: number
    trattamentoIntegrativo: number
    coefficienteRedditivita: number | null
    aliquotaSostitutiva: number | null
  }
}

// --- Regime calculators -------------------------------------------------

function computeForfettario(input: TaxInput): TaxBreakdown {
  const { forfettario } = input
  const lordo = Math.max(0, input.grossAnnual)
  const redditoLordo = lordo * forfettario.coefficiente

  // Contributions are computed on the forfait profit and are deducible
  // from it, so the taxable base is profit minus contributions.
  //
  // The contribution base is capped at the massimale: income above it carries
  // no further contribution in either gestione.
  const baseContributiva = Math.min(redditoLordo, MASSIMALE_CONTRIBUTIVO)
  let contributi: number
  if (forfettario.cassa === 'gestione-separata') {
    contributi = baseContributiva * GESTIONE_SEPARATA_RATE
  } else {
    // The fixed contribution already covers income up to the minimale;
    // only the excess is charged at the percentage rate.
    const { contributoFisso, rate } = CASSE_AUTONOMI[forfettario.cassa]
    const eccedenza = Math.max(0, baseContributiva - ARTIGIANI_MINIMALE)
    contributi = contributoFisso + eccedenza * rate
  }
  if (forfettario.riduzioneContributiva) {
    contributi *= 1 - RIDUZIONE_FORFETTARIA
  }

  const imponibile = Math.max(0, redditoLordo - contributi)
  const aliquota = forfettario.startup ? 0.05 : 0.15
  const imposta = imponibile * aliquota

  // The imposta sostitutiva replaces IRPEF and BOTH addizionali, and no
  // detrazioni apply. That is the whole point of the regime.
  const imposteNette = imposta
  const totaleTrattenute = contributi + imposteNette
  const netto = lordo - totaleTrattenute

  return {
    regime: 'forfettario',
    lordo,
    contributi,
    redditoComplessivo: imponibile,
    impostaLorda: imposta,
    detrazioni: 0,
    impostaNetta: imposta,
    addizionaleRegionale: 0,
    addizionaleComunale: 0,
    bonus: 0,
    imposteNette,
    totaleTrattenute,
    netto,
    // "Mensilita" is a payroll concept: a partita IVA has no thirteenth
    // instalment, so the monthly figure is a plain twelfth of the year
    // regardless of what the (hidden) mensilita selector holds.
    nettoMensile: netto / 12,
    aliquotaEffettiva: lordo > 0 ? totaleTrattenute / lordo : 0,
    dettaglio: {
      detrazioneRegime: 0,
      ulterioreDetrazione: 0,
      detrazioneConiuge: 0,
      detrazioneFigli: 0,
      bonusCuneo: 0,
      trattamentoIntegrativo: 0,
      coefficienteRedditivita: forfettario.coefficiente,
      aliquotaSostitutiva: aliquota,
    },
  }
}

function computeIrpefRegime(input: TaxInput): TaxBreakdown {
  const isDipendente = input.regime === 'dipendente'
  const lordo = Math.max(0, input.grossAnnual)

  // Pensions carry no social contribution: the pensioner already paid.
  const contributi = isDipendente ? contributiInps(lordo) : 0
  const redditoComplessivo = Math.max(0, lordo - contributi)

  const impostaLorda = irpefLorda(redditoComplessivo)

  const detrazioneRegime = isDipendente
    ? detrazioneLavoroDipendente(redditoComplessivo)
    : detrazionePensione(redditoComplessivo)
  const ulteriore = isDipendente ? ulterioreDetrazione(redditoComplessivo) : 0
  const coniuge = input.coniugeACarico ? detrazioneConiuge(redditoComplessivo) : 0
  const figli = detrazioneFigli(redditoComplessivo, input.figliACarico)

  let detrazioni = detrazioneRegime + ulteriore + coniuge + figli
  // Very high earners lose 440 EUR of detrazioni so that the 33% bracket
  // cut does not reach them (legge di bilancio 2026).
  if (redditoComplessivo > DETRAZIONI_CLAWBACK_SOGLIA) {
    detrazioni = Math.max(0, detrazioni - DETRAZIONI_CLAWBACK_IMPORTO)
  }

  const impostaNetta = Math.max(0, impostaLorda - detrazioni)

  // Gated on reddito complessivo, computed on the gross employment income.
  const bonusCuneo = isDipendente ? bonusCuneoFiscale(redditoComplessivo, lordo) : 0
  const ti = isDipendente
    ? trattamentoIntegrativo(redditoComplessivo, impostaLorda, detrazioneRegime, detrazioni)
    : 0
  const bonus = bonusCuneo + ti

  // Addizionali are levied on the reddito complessivo, before detrazioni,
  // but are only due at all if some IRPEF is due after them.
  const regione = findRegione(input.regione)
  const addReg =
    impostaNetta > 0 ? addizionaleRegionale(redditoComplessivo, regione) : 0
  const aliquotaComunale = input.aliquotaComunale ?? ADDIZIONALE_COMUNALE_MEDIA
  const addCom = impostaNetta > 0 ? redditoComplessivo * aliquotaComunale : 0

  const imposteNette = impostaNetta + addReg + addCom - bonus
  const totaleTrattenute = contributi + imposteNette
  const netto = lordo - totaleTrattenute

  return {
    regime: input.regime,
    lordo,
    contributi,
    redditoComplessivo,
    impostaLorda,
    detrazioni,
    impostaNetta,
    addizionaleRegionale: addReg,
    addizionaleComunale: addCom,
    bonus,
    imposteNette,
    totaleTrattenute,
    netto,
    nettoMensile: netto / input.mensilita,
    aliquotaEffettiva: lordo > 0 ? totaleTrattenute / lordo : 0,
    dettaglio: {
      detrazioneRegime,
      ulterioreDetrazione: ulteriore,
      detrazioneConiuge: coniuge,
      detrazioneFigli: figli,
      bonusCuneo,
      trattamentoIntegrativo: ti,
      coefficienteRedditivita: null,
      aliquotaSostitutiva: null,
    },
  }
}

/** Compute the full breakdown for any supported regime. */
export function computeTaxBreakdown(input: TaxInput): TaxBreakdown {
  return input.regime === 'forfettario'
    ? computeForfettario(input)
    : computeIrpefRegime(input)
}

/**
 * The share of the result that notionally funds state spending, and so
 * gets distributed across the missioni del Bilancio dello Stato.
 *
 * Social contributions are excluded: they are earmarked for pensions, not
 * for general revenue. The bonus credits are netted off, because a euro
 * handed back to the taxpayer is a euro that never funded a missione.
 * Floored at zero: a taxpayer who receives more than they pay funds
 * nothing, rather than funding a negative amount.
 */
export function totalIncomeTax(b: TaxBreakdown): number {
  return Math.max(0, b.imposteNette)
}
