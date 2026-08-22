// Shared parsing + domain constants for the Parlamento pages.
//
// Each page used to carry its own copy of these. The legislature list existed
// five times under three different names (LEGISLATURE, LEGISLATURES,
// LEGISLATURE_WITH_DATA), the chamber narrowing six times across two shapes
// (parseChamber / isChamber), and parseLeg three times with different bounds
// and different null-vs-undefined conventions. That is the kind of
// duplication that does not break anything until the day the archive gains a
// legislature and four of the five lists silently stay wrong.

import type { Chamber } from '@/services/parlamento'

/**
 * Legislatures with transcript data in the archive, oldest first.
 *
 * Camera and Senato HTML transcripts both begin at leg 13 (1996); everything
 * earlier is PDF-only (see project-kb/Historical data sources probe.md).
 * Extend this when an earlier or later legislature is ingested -- every
 * legislature picker in the section reads it.
 */
export const LEGISLATURE_WITH_DATA = [13, 14, 15, 16, 17, 18, 19] as const

/** Type guard for a chamber coming out of a URL param or search param. */
export function isChamber(s: string | null | undefined): s is Chamber {
  return s === 'camera' || s === 'senato'
}

/**
 * Chamber from a search param, as `undefined` when absent -- the shape the
 * service-layer fetchers want, since they omit undefined params.
 */
export function parseChamberParam(s: string | null | undefined): Chamber | undefined {
  return isChamber(s) ? s : undefined
}

/**
 * Chamber from a search param, as the literal `'all'` when absent -- the
 * shape the filter toggles want, since 'all' is a selectable state.
 */
export function parseChamberFilter(s: string | null | undefined): Chamber | 'all' {
  return isChamber(s) ? s : 'all'
}

/** Legislature from a search param; null when absent or out of range. */
export function parseLeg(s: string | null | undefined): number | null {
  if (!s) return null
  const n = Number(s)
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : null
}

/** As parseLeg, but `undefined` for the service-layer fetchers. */
export function parseLegParam(s: string | null | undefined): number | undefined {
  return parseLeg(s) ?? undefined
}

/** Positive integer from a search param (page numbers), with a fallback. */
export function parsePositiveInt(s: string | null | undefined, fallback: number): number {
  const n = Number(s)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/** Four-digit year from a search param; null when absent or implausible. */
export function parseYear(s: string | null | undefined): number | null {
  if (!s) return null
  const n = Number(s)
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null
}
