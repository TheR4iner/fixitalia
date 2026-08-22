// Shared parsing helpers for data ingestion.
//
// Italian government open-data sources are wildly inconsistent: some cells
// use US number formatting (`9,075,000.00`), some use Italian
// (`9.075.000,00`), some are bare (`9075000`). Some files have U+FFFD
// replacement characters baked into the published bytes (MIT does this).
// These helpers normalise all of that in one place so every ingest file
// does not need to reinvent the wheel.

/**
 * Parse a string or number cell into a number, handling mixed
 * Italian / US / bare formats. Returns null for empty, NaN, or
 * unparseable values.
 *
 * Heuristic:
 *   - If both "," and "." are present, whichever appears LAST is the
 *     decimal separator.
 *   - If only one separator is present, treat it as a decimal separator
 *     when followed by 1 or 2 digits, otherwise as a thousands separator.
 */
export function parseNumericValue(raw: unknown): number | null {
  if (raw == null) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const trimmed = String(raw).trim()
  if (!trimmed) return null

  const cleaned = trimmed.replace(/[^\d,.-]/g, '')
  if (!cleaned) return null

  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')

  let normalized: string
  if (hasComma && hasDot) {
    const lastComma = cleaned.lastIndexOf(',')
    const lastDot = cleaned.lastIndexOf('.')
    normalized =
      lastDot > lastComma
        ? cleaned.replace(/,/g, '')
        : cleaned.replace(/\./g, '').replace(',', '.')
  } else if (hasComma) {
    const afterLast = cleaned.length - cleaned.lastIndexOf(',') - 1
    normalized = afterLast <= 2 ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '')
  } else if (hasDot) {
    const afterLast = cleaned.length - cleaned.lastIndexOf('.') - 1
    normalized = afterLast <= 2 ? cleaned : cleaned.replace(/\./g, '')
  } else {
    normalized = cleaned
  }

  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

/**
 * Trim a cell, drop U+FFFD replacement characters that some source rows
 * ship, and collapse internal whitespace runs. Returns null for empty.
 */
export function cleanString(raw: unknown): string | null {
  if (raw == null) return null
  const trimmed = String(raw).replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Remove null / undefined values from a record so SurrealDB's `option<T>`
 * schema accepts the row. `option<T>` means "absent or T", not "null or
 * T", so bound nulls are rejected at insert time. Generic so callers
 * preserve their input shape; the keys we keep stay as their original
 * type, the rest are simply absent.
 */
export function stripNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined),
  ) as Partial<T>
}
