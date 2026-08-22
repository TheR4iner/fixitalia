// Italian locale formatting helpers. Use these everywhere instead of
// hand-rolling number or date formatting. Italian convention: "." as thousands
// separator, "," as decimal separator, currency suffix (e.g. "1.234.567,89 EUR").
//
// Instances are created once at module load rather than per-call; Intl
// constructors are comparatively heavy and these formatters are invoked many
// times per render (tables, charts, KPIs).

const LOCALE = 'it-IT'

const eurFormatter = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
})

const eurFormatterPrecise = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
})

const numberFormatter = new Intl.NumberFormat(LOCALE)

const percentFormatter = new Intl.NumberFormat(LOCALE, {
  style: 'percent',
  maximumFractionDigits: 1,
})

const dateFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long' })
const dateFormatterShort = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short' })

/**
 * Format a value as euro currency in Italian locale.
 * By default rounds to whole euros; pass { precise: true } to show cents.
 */
export function formatEUR(value: number, options?: { precise?: boolean }): string {
  if (!Number.isFinite(value)) return '--'
  return options?.precise ? eurFormatterPrecise.format(value) : eurFormatter.format(value)
}

/** Format an integer or decimal number in Italian locale. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '--'
  return numberFormatter.format(value)
}

/**
 * Format a fraction as an Italian-locale percentage.
 * Pass the raw ratio (e.g. 0.234), not the scaled value (23.4).
 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '--'
  return percentFormatter.format(value)
}

/** Format a Date or ISO string in Italian long date style (e.g. "10 aprile 2026"). */
export function formatDate(value: Date | string, options?: { short?: boolean }): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '--'
  return options?.short ? dateFormatterShort.format(date) : dateFormatter.format(date)
}

// OpenCoesione's aggregati API ships data_aggiornamento as a bare YYYYMMDD
// string ("20251231"), which neither Date.parse nor formatDate accepts.
// Normalise it to ISO so the existing formatters can take it.
function yyyymmddToIso(value: string): string | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/**
 * Format a publisher-provided "data di aggiornamento" string for a section
 * badge ("Aggiornato al ...").
 *
 * Accepts either a YYYYMMDD bare string (OpenCoesione style) or any ISO date
 * string; returns the Italian short form (DD/MM/YYYY) used in badges. When
 * the input is null/undefined or unparseable, returns null so the caller can
 * decide what to render in the meantime.
 */
export function formatBadgeDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const iso = yyyymmddToIso(raw) ?? raw
  return formatDate(iso, { short: true })
}
