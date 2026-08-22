// Italian NUTS 2 region codes.
//
// The MIT dataset stores `localizz_cod_NUTS` which is either a NUTS 3
// (province) or NUTS 2 (region) code. NUTS 2 codes for Italy start with
// "ITC", "ITF", "ITG", "ITH", or "ITI" and are four characters long.
// Truncating any longer NUTS code to its first four characters gives the
// region, which is exactly what we want for the regional breakdown chart.
//
// Reference: Eurostat NUTS 2021 classification.

// Supports both NUTS 2006/2010 and NUTS 2013+ Italian codes. The MIT 2017
// dataset uses the 2010 vintage (ITD*, ITE*), while newer releases use the
// 2013+ vintage (ITH*, ITI*). We map both to the same region names.
const NUTS2_TO_REGION: Readonly<Record<string, string>> = {
  // NUTS 2013+
  ITC1: 'Piemonte',
  ITC2: "Valle d'Aosta",
  ITC3: 'Liguria',
  ITC4: 'Lombardia',
  ITH1: 'Trentino-Alto Adige',
  ITH2: 'Trentino-Alto Adige',
  ITH3: 'Veneto',
  ITH4: 'Friuli-Venezia Giulia',
  ITH5: 'Emilia-Romagna',
  ITI1: 'Toscana',
  ITI2: 'Umbria',
  ITI3: 'Marche',
  ITI4: 'Lazio',
  ITF1: 'Abruzzo',
  ITF2: 'Molise',
  ITF3: 'Campania',
  ITF4: 'Puglia',
  ITF5: 'Basilicata',
  ITF6: 'Calabria',
  ITG1: 'Sicilia',
  ITG2: 'Sardegna',
  // NUTS 2006/2010 (used by MIT 2017 dataset)
  ITD1: 'Trentino-Alto Adige',
  ITD2: 'Trentino-Alto Adige',
  ITD3: 'Veneto',
  ITD4: 'Friuli-Venezia Giulia',
  ITD5: 'Emilia-Romagna',
  ITE1: 'Toscana',
  ITE2: 'Umbria',
  ITE3: 'Marche',
  ITE4: 'Lazio',
}

export function regionFromNuts(nuts: string | null | undefined): string | null {
  if (!nuts) return null
  const key = nuts.trim().toUpperCase().slice(0, 4)
  return NUTS2_TO_REGION[key] ?? null
}

// Province-code prefix of an ISTAT codice comune (first three digits) maps
// to a region via a separate lookup. We use the NUTS path first because the
// MIT dataset has clean NUTS codes; this is here as a fallback.
// Regional codes per ISTAT classification at
// https://www.istat.it/it/archivio/6789.
const ISTAT_REGION_CODE_TO_NAME: Readonly<Record<string, string>> = {
  '01': 'Piemonte',
  '02': "Valle d'Aosta",
  '03': 'Lombardia',
  '04': 'Trentino-Alto Adige',
  '05': 'Veneto',
  '06': 'Friuli-Venezia Giulia',
  '07': 'Liguria',
  '08': 'Emilia-Romagna',
  '09': 'Toscana',
  '10': 'Umbria',
  '11': 'Marche',
  '12': 'Lazio',
  '13': 'Abruzzo',
  '14': 'Molise',
  '15': 'Campania',
  '16': 'Puglia',
  '17': 'Basilicata',
  '18': 'Calabria',
  '19': 'Sicilia',
  '20': 'Sardegna',
}

export function regionFromIstatRegionCode(code: string | null | undefined): string | null {
  if (!code) return null
  // The MIT dataset's `Localizz. cod. ISTAT` is a 9-digit concatenated
  // identifier: first 3 digits encode the region (e.g. "003" = Lombardia),
  // next 3 the province, last 3 the comune. Older datasets sometimes use
  // just the 6-digit province-comune form. In that case we have no region
  // information to extract.
  const digits = code.trim().replace(/\D/g, '')
  if (digits.length < 9) return null
  const regionCode = digits.slice(0, 3).replace(/^0/, '').padStart(2, '0')
  return ISTAT_REGION_CODE_TO_NAME[regionCode] ?? null
}

export const ITALIAN_REGIONS: readonly string[] = Array.from(
  new Set(Object.values(NUTS2_TO_REGION)),
).sort((a, b) => a.localeCompare(b, 'it'))

// ISO 3166-2:IT province codes to region names. Used by the ANAC
// stazioni-appaltanti ingest, where the `provincia_codice` column ships
// in the form "IT-MI", "IT-RM", etc. We accept both the full form and
// the bare two-letter province code. 110 provinces total; this map is
// the authoritative source for "which region does this province belong
// to". Derived from the ISTAT elenco codici territoriali.
const PROVINCE_TO_REGION: Readonly<Record<string, string>> = {
  // Piemonte
  TO: 'Piemonte',
  VC: 'Piemonte',
  NO: 'Piemonte',
  CN: 'Piemonte',
  AT: 'Piemonte',
  AL: 'Piemonte',
  BI: 'Piemonte',
  VB: 'Piemonte',
  // Valle d'Aosta
  AO: "Valle d'Aosta",
  // Lombardia
  VA: 'Lombardia',
  CO: 'Lombardia',
  SO: 'Lombardia',
  MI: 'Lombardia',
  BG: 'Lombardia',
  BS: 'Lombardia',
  PV: 'Lombardia',
  CR: 'Lombardia',
  MN: 'Lombardia',
  LC: 'Lombardia',
  LO: 'Lombardia',
  MB: 'Lombardia',
  // Trentino-Alto Adige
  BZ: 'Trentino-Alto Adige',
  TN: 'Trentino-Alto Adige',
  // Veneto
  VR: 'Veneto',
  VI: 'Veneto',
  BL: 'Veneto',
  TV: 'Veneto',
  VE: 'Veneto',
  PD: 'Veneto',
  RO: 'Veneto',
  // Friuli-Venezia Giulia
  UD: 'Friuli-Venezia Giulia',
  GO: 'Friuli-Venezia Giulia',
  TS: 'Friuli-Venezia Giulia',
  PN: 'Friuli-Venezia Giulia',
  // Liguria
  IM: 'Liguria',
  SV: 'Liguria',
  GE: 'Liguria',
  SP: 'Liguria',
  // Emilia-Romagna
  PC: 'Emilia-Romagna',
  PR: 'Emilia-Romagna',
  RE: 'Emilia-Romagna',
  MO: 'Emilia-Romagna',
  BO: 'Emilia-Romagna',
  FE: 'Emilia-Romagna',
  RA: 'Emilia-Romagna',
  FC: 'Emilia-Romagna',
  RN: 'Emilia-Romagna',
  // Toscana
  MS: 'Toscana',
  LU: 'Toscana',
  PT: 'Toscana',
  FI: 'Toscana',
  LI: 'Toscana',
  PI: 'Toscana',
  AR: 'Toscana',
  SI: 'Toscana',
  GR: 'Toscana',
  PO: 'Toscana',
  // Umbria
  PG: 'Umbria',
  TR: 'Umbria',
  // Marche
  PU: 'Marche',
  AN: 'Marche',
  MC: 'Marche',
  AP: 'Marche',
  FM: 'Marche',
  // Lazio
  VT: 'Lazio',
  RI: 'Lazio',
  RM: 'Lazio',
  LT: 'Lazio',
  FR: 'Lazio',
  // Abruzzo
  AQ: 'Abruzzo',
  TE: 'Abruzzo',
  PE: 'Abruzzo',
  CH: 'Abruzzo',
  // Molise
  CB: 'Molise',
  IS: 'Molise',
  // Campania
  CE: 'Campania',
  BN: 'Campania',
  NA: 'Campania',
  AV: 'Campania',
  SA: 'Campania',
  // Puglia
  FG: 'Puglia',
  BA: 'Puglia',
  TA: 'Puglia',
  BR: 'Puglia',
  LE: 'Puglia',
  BT: 'Puglia',
  // Basilicata
  PZ: 'Basilicata',
  MT: 'Basilicata',
  // Calabria
  CS: 'Calabria',
  CZ: 'Calabria',
  RC: 'Calabria',
  KR: 'Calabria',
  VV: 'Calabria',
  // Sicilia
  TP: 'Sicilia',
  PA: 'Sicilia',
  ME: 'Sicilia',
  AG: 'Sicilia',
  CL: 'Sicilia',
  EN: 'Sicilia',
  CT: 'Sicilia',
  RG: 'Sicilia',
  SR: 'Sicilia',
  // Sardegna
  SS: 'Sardegna',
  NU: 'Sardegna',
  CA: 'Sardegna',
  OR: 'Sardegna',
  SU: 'Sardegna', // Sud Sardegna
}

/**
 * Map an Italian province code to its region.
 *
 * Accepts: "MI", "IT-MI", "it-mi" and the same with surrounding whitespace.
 * Returns null for unknown or empty codes (e.g. foreign entities).
 */
export function regionFromProvinceCode(code: string | null | undefined): string | null {
  if (!code) return null
  const trimmed = code.trim().toUpperCase()
  // Strip an "IT-" ISO prefix if present.
  const bare = trimmed.startsWith('IT-') ? trimmed.slice(3) : trimmed
  return PROVINCE_TO_REGION[bare] ?? null
}
