// Addizionale regionale all'IRPEF -- aliquote 2026, per regione.
//
// Primary source for every entry is the MEF Dipartimento delle Finanze
// rate database, which holds the figures the regions themselves file and
// which are legally binding:
//
//   https://www1.finanze.gov.it/finanze2/dipartimentopolitichefiscali/
//     fiscalitalocale/addregirpef/addregirpef.php?reg=<NN>&anno=2026
//
// Each region below carries the URL it was taken from, so any figure on
// the site can be traced back to the government record behind it.
//
// TWO THINGS THAT ARE EASY TO GET WRONG, and that most third-party
// calculators do get wrong:
//
//  1. Progressive vs cliff. Most regions apply their brackets the way
//     national IRPEF does -- each rate to its own slice of income only.
//     But Friuli-Venezia Giulia, Valle d'Aosta and Lazio legislate a
//     CLIFF: once you cross the threshold, a single rate applies to the
//     ENTIRE imponibile. Lazio's 2026 law says so explicitly ("l'aliquota
//     e determinata in misura pari al ..."), and FVG's says "sull'intero
//     importo". Treating those three as progressive understates the tax
//     by hundreds of euro.
//
//  2. Regions publish "maggiorazioni" over the 1,23% national base rate,
//     not final rates. The figures stored here are always the FINAL rate
//     (base + maggiorazione), already summed.
//
// Regional per-child detrazioni are deliberately NOT applied. Six regions
// offer one, but each defines the qualifying child differently (figli
// minorenni in Sardegna, figli a carico in Trento, oltre il terzo in
// Puglia), and none of those definitions matches the 21-30 age band the
// national art. 12 detrazione uses. Applying them off a single "figli a
// carico" number would produce a confidently wrong figure, so instead
// each region carries a note that the UI shows to the reader.

export interface AddizionaleBracket {
  /** Upper bound of this bracket; use Infinity for the top one. */
  upTo: number
  /** Final rate as a fraction (e.g. 0.0173 for 1,73%). */
  rate: number
}

export interface Regione {
  /** Internal key; the ISTAT region code, with the two autonomous provinces split out. */
  code: string
  /** ISTAT region code proper, kept for future joins against ISTAT-keyed data. */
  istat: string
  nome: string
  brackets: ReadonlyArray<AddizionaleBracket>
  /**
   * When true, the rate of the matching bracket applies to the whole
   * imponibile rather than slice by slice.
   */
  cliff: boolean
  /** Income at or below which no addizionale is due at all. */
  esenzioneFinoA?: number
  /**
   * Some regions grant a reduced rate set below a threshold rather than a
   * flat exemption (Umbria waives its maggiorazioni up to 28.000).
   */
  bracketsAgevolate?: {
    finoA: number
    brackets: ReadonlyArray<AddizionaleBracket>
  }
  /** Flat credit against the computed addizionale, never below zero. */
  detrazione?: {
    importo: number
    /** Applies only when reddito is above this (exclusive). */
    daReddito?: number
    /** Applies only when reddito is at or below this. */
    aReddito?: number
  }
  /** Italian note shown to the reader about reliefs we do not model. */
  nota?: string
  fonte: string
}

const MEF = (reg: string) =>
  `https://www1.finanze.gov.it/finanze2/dipartimentopolitichefiscali/fiscalitalocale/addregirpef/addregirpef.php?reg=${reg}&anno=2026`

/** National average rates, used when the reader has not picked a region. */
export const ADDIZIONALE_REGIONALE_MEDIA = 0.0173
export const ADDIZIONALE_COMUNALE_MEDIA = 0.006

/** Legal ceiling for the addizionale comunale (0,9% in provincial capitals). */
export const ADDIZIONALE_COMUNALE_MAX = 0.009

export const REGIONI: ReadonlyArray<Regione> = [
  {
    code: '01',
    istat: '01',
    nome: 'Piemonte',
    brackets: [
      { upTo: 15_000, rate: 0.0162 },
      { upTo: 28_000, rate: 0.0268 },
      { upTo: 50_000, rate: 0.0331 },
      { upTo: Infinity, rate: 0.0333 },
    ],
    cliff: false,
    nota: 'Il Piemonte prevede inoltre una detrazione di 100 euro per ogni figlio a carico oltre il secondo e di 500 euro per figlio con disabilita, non inclusa in questa stima.',
    fonte:
      'https://www.regione.piemonte.it/web/temi/tributi/addizionali-regionali/addizionale-regionale-allirpef',
  },
  {
    code: '02',
    istat: '02',
    nome: "Valle d'Aosta",
    brackets: [{ upTo: Infinity, rate: 0.0123 }],
    cliff: true,
    esenzioneFinoA: 15_000,
    nota: "In Valle d'Aosta chi ha un reddito complessivo fino a 15.000 euro e esentato dal pagamento; sopra tale soglia l'aliquota si applica sull'intero imponibile.",
    fonte: MEF('20'),
  },
  {
    code: '03',
    istat: '03',
    nome: 'Lombardia',
    brackets: [
      { upTo: 15_000, rate: 0.0123 },
      { upTo: 28_000, rate: 0.0158 },
      { upTo: 50_000, rate: 0.0172 },
      { upTo: Infinity, rate: 0.0173 },
    ],
    cliff: false,
    fonte:
      'https://www.regione.lombardia.it/bollo-auto-e-tributi-regionali/red-addizionale-regionale-irpef',
  },
  {
    code: '04-TN',
    istat: '04',
    nome: 'Provincia autonoma di Trento',
    brackets: [
      { upTo: 50_000, rate: 0.0123 },
      { upTo: Infinity, rate: 0.0173 },
    ],
    cliff: false,
    // Trento grants a 30.000 euro deduction that exactly cancels the base
    // for anyone at or below 30.000, and is lost entirely above it.
    esenzioneFinoA: 30_000,
    nota: 'La Provincia di Trento azzera di fatto l’addizionale fino a 30.000 euro tramite una deduzione, e prevede una detrazione di 246 euro per figlio a carico sotto i 50.000 euro, non inclusa in questa stima.',
    fonte: MEF('18'),
  },
  {
    code: '04-BZ',
    istat: '04',
    nome: 'Provincia autonoma di Bolzano',
    brackets: [
      { upTo: 50_000, rate: 0.0123 },
      { upTo: Infinity, rate: 0.0173 },
    ],
    cliff: false,
    detrazione: { importo: 430.5, aReddito: 90_000 },
    nota: 'Bolzano concede una detrazione di 430,50 euro fino a 90.000 euro di imponibile (qui inclusa), piu una detrazione aggiuntiva fino a 125 euro sopra i 50.000 euro e 340 euro per figlio a carico, non incluse.',
    fonte: MEF('03'),
  },
  {
    code: '05',
    istat: '05',
    nome: 'Veneto',
    brackets: [{ upTo: Infinity, rate: 0.0123 }],
    cliff: false,
    nota: 'Il Veneto non applica alcun aumento rispetto all’aliquota di base. E prevista un’aliquota agevolata dello 0,90% per contribuenti con disabilita fino a 50.000 euro, non inclusa in questa stima.',
    fonte:
      'https://www.regione.veneto.it/web/tributi-regionali/addirpef-determinazione-dellimposta',
  },
  {
    code: '06',
    istat: '06',
    nome: 'Friuli-Venezia Giulia',
    brackets: [
      { upTo: 15_000, rate: 0.007 },
      { upTo: Infinity, rate: 0.0123 },
    ],
    // The law says "sull'intero importo": above 15.000 the 1,23% applies
    // to the whole imponibile, not just to the part above the threshold.
    cliff: true,
    fonte: MEF('07'),
  },
  {
    code: '07',
    istat: '07',
    nome: 'Liguria',
    brackets: [
      { upTo: 28_000, rate: 0.0123 },
      { upTo: 50_000, rate: 0.0318 },
      { upTo: Infinity, rate: 0.0323 },
    ],
    cliff: false,
    fonte:
      'https://www.regione.liguria.it/homepage-pagamenti-online-imposte/cosa-cerchi/irpef_addizionale_regionale_imposta_reddito/irpef-2025.html',
  },
  {
    code: '08',
    istat: '08',
    nome: 'Emilia-Romagna',
    brackets: [
      { upTo: 15_000, rate: 0.0133 },
      { upTo: 28_000, rate: 0.0193 },
      { upTo: 50_000, rate: 0.0278 },
      { upTo: Infinity, rate: 0.0333 },
    ],
    cliff: false,
    fonte:
      'https://finanze.regione.emilia-romagna.it/tributi-regionali/imposte/addizionale-irpef/quanto-come-e-quando-si-paga',
  },
  {
    code: '09',
    istat: '09',
    nome: 'Toscana',
    brackets: [
      { upTo: 15_000, rate: 0.0142 },
      { upTo: 28_000, rate: 0.0143 },
      { upTo: 50_000, rate: 0.0332 },
      { upTo: Infinity, rate: 0.0333 },
    ],
    cliff: false,
    fonte: 'https://www.regione.toscana.it/-/addizionale-regionale-all-irpef',
  },
  {
    code: '10',
    istat: '10',
    nome: 'Umbria',
    brackets: [
      { upTo: 15_000, rate: 0.0173 },
      { upTo: 28_000, rate: 0.0302 },
      { upTo: 50_000, rate: 0.0312 },
      { upTo: Infinity, rate: 0.0333 },
    ],
    cliff: false,
    // Up to 28.000 the region waives its maggiorazioni entirely, so the
    // taxpayer falls back to the 1,23% national base rate.
    bracketsAgevolate: {
      finoA: 28_000,
      brackets: [{ upTo: Infinity, rate: 0.0123 }],
    },
    detrazione: { importo: 150, daReddito: 28_000, aReddito: 50_000 },
    fonte: MEF('19'),
  },
  {
    code: '11',
    istat: '11',
    nome: 'Marche',
    brackets: [
      { upTo: 15_000, rate: 0.0123 },
      { upTo: 28_000, rate: 0.0153 },
      { upTo: 50_000, rate: 0.017 },
      { upTo: Infinity, rate: 0.0173 },
    ],
    cliff: false,
    fonte: MEF('11'),
  },
  {
    code: '12',
    istat: '12',
    nome: 'Lazio',
    brackets: [
      { upTo: 28_000, rate: 0.0173 },
      { upTo: Infinity, rate: 0.0333 },
    ],
    // L.R. 20/2025 sets the rate "in misura pari" to a single value for
    // the whole imponibile -- an explicit cliff, unlike its neighbours.
    cliff: true,
    detrazione: { importo: 60, daReddito: 28_000, aReddito: 30_000 },
    fonte:
      'https://www.regione.lazio.it/sites/default/files/2026-01/Addizionale-regionale-2026.pdf',
  },
  {
    code: '13',
    istat: '13',
    nome: 'Abruzzo',
    brackets: [
      { upTo: 28_000, rate: 0.0167 },
      { upTo: 50_000, rate: 0.0287 },
      { upTo: Infinity, rate: 0.0333 },
    ],
    cliff: false,
    fonte: MEF('01'),
  },
  {
    code: '14',
    istat: '14',
    nome: 'Molise',
    brackets: [
      { upTo: 15_000, rate: 0.0203 },
      { upTo: 28_000, rate: 0.0223 },
      { upTo: Infinity, rate: 0.0363 },
    ],
    cliff: false,
    fonte: MEF('12'),
  },
  {
    code: '15',
    istat: '15',
    nome: 'Campania',
    brackets: [
      { upTo: 15_000, rate: 0.0173 },
      { upTo: 28_000, rate: 0.0296 },
      { upTo: 50_000, rate: 0.032 },
      { upTo: Infinity, rate: 0.0333 },
    ],
    cliff: false,
    nota: 'La Campania prevede una detrazione di 30 euro per figlio (40 se con disabilita) per chi ha almeno due figli a carico e un imponibile fino a 28.000 euro, non inclusa in questa stima.',
    fonte: MEF('05'),
  },
  {
    code: '16',
    istat: '16',
    nome: 'Puglia',
    brackets: [
      { upTo: 15_000, rate: 0.0133 },
      { upTo: 28_000, rate: 0.0213 },
      { upTo: 50_000, rate: 0.0323 },
      { upTo: Infinity, rate: 0.0333 },
    ],
    cliff: false,
    nota: 'La Puglia prevede una detrazione di 20 euro per figlio per chi ha piu di tre figli a carico, non inclusa in questa stima.',
    fonte: MEF('14'),
  },
  {
    code: '17',
    istat: '17',
    nome: 'Basilicata',
    brackets: [{ upTo: Infinity, rate: 0.0123 }],
    cliff: false,
    fonte: MEF('02'),
  },
  {
    code: '18',
    istat: '18',
    nome: 'Calabria',
    brackets: [{ upTo: Infinity, rate: 0.0173 }],
    cliff: false,
    fonte: MEF('04'),
  },
  {
    code: '19',
    istat: '19',
    nome: 'Sicilia',
    brackets: [{ upTo: Infinity, rate: 0.0123 }],
    cliff: false,
    fonte: MEF('16'),
  },
  {
    code: '20',
    istat: '20',
    nome: 'Sardegna',
    brackets: [{ upTo: Infinity, rate: 0.0123 }],
    cliff: false,
    nota: 'La Sardegna prevede una detrazione di 200 euro per ogni figlio minorenne a carico (300 se con disabilita) fino a 50.000 euro di imponibile, non inclusa in questa stima.',
    fonte: MEF('15'),
  },
]

export type RegioneCode = (typeof REGIONI)[number]['code']

/** The synthetic "no region chosen" entry: flat national average. */
export const MEDIA_NAZIONALE: Regione = {
  code: 'media',
  istat: '',
  nome: 'Media nazionale',
  brackets: [{ upTo: Infinity, rate: ADDIZIONALE_REGIONALE_MEDIA }],
  cliff: false,
  fonte: 'https://www.finanze.gov.it/it/fiscalita-regionale-e-locale/',
}

/** Resolve a region code, falling back to the national average. */
export function findRegione(code: RegioneCode | null | undefined): Regione {
  if (!code) return MEDIA_NAZIONALE
  return REGIONI.find((r) => r.code === code) ?? MEDIA_NAZIONALE
}

function applyBrackets(
  imponibile: number,
  brackets: ReadonlyArray<AddizionaleBracket>,
  cliff: boolean,
): number {
  if (cliff) {
    // One rate on the whole amount: find the first bracket that contains
    // the income and apply its rate to everything.
    for (const b of brackets) {
      if (imponibile <= b.upTo) return imponibile * b.rate
    }
    return imponibile * (brackets[brackets.length - 1]?.rate ?? 0)
  }

  // Marginal: each rate applies only to its own slice.
  let dovuta = 0
  let lower = 0
  for (const { upTo, rate } of brackets) {
    if (imponibile <= upTo) {
      return dovuta + (imponibile - lower) * rate
    }
    dovuta += (upTo - lower) * rate
    lower = upTo
  }
  return dovuta
}

/**
 * Addizionale regionale due on a given imponibile, for a given region.
 *
 * Order of operations matters: the exemption is tested first, then the
 * reduced bracket set if the region has one, then the ordinary ladder,
 * and only then is any flat detrazione subtracted (never below zero --
 * these regional detrazioni explicitly do not generate a tax credit).
 */
export function addizionaleRegionale(imponibile: number, regione: Regione): number {
  if (imponibile <= 0) return 0

  if (regione.esenzioneFinoA != null && imponibile <= regione.esenzioneFinoA) {
    return 0
  }

  const agevolate = regione.bracketsAgevolate
  const brackets =
    agevolate && imponibile <= agevolate.finoA ? agevolate.brackets : regione.brackets

  let dovuta = applyBrackets(imponibile, brackets, regione.cliff)

  const d = regione.detrazione
  if (d) {
    const sopraMinimo = d.daReddito == null || imponibile > d.daReddito
    const sottoMassimo = d.aReddito == null || imponibile <= d.aReddito
    if (sopraMinimo && sottoMassimo) {
      dovuta = Math.max(0, dovuta - d.importo)
    }
  }

  return dovuta
}
