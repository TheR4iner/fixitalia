// Shared query/path parameter parsing for the read-side routes.
//
// Every section's routes file used to carry its own byte-identical copy of
// `clampInt`, and the parlamento routes additionally repeated the
// `req.query.leg ? Number(...) : null` dance five times with subtly
// different validity rules. One copy here keeps the clamping semantics --
// and the "what does a malformed value mean?" answer -- identical across
// every endpoint.
//
// Two families of helper:
//
//   clampInt / parseChamber   forgiving: a missing or unusable value falls
//                             back to a documented default. Used for
//                             pagination and for filters where "absent"
//                             is a meaningful, safe state.
//
//   parseIntParam / parseLegParam   strict: they distinguish "not supplied"
//                             (null) from "supplied but malformed"
//                             (BadParamError). Routes turn the latter into
//                             a 400 rather than silently ignoring the
//                             filter and returning an unfiltered 200, which
//                             reads to the caller as "the filter matched
//                             everything".

/** Thrown by the strict parsers; routes map it to a 400. */
export class BadParamError extends Error {
  constructor(readonly param: string) {
    super(`invalid ${param}`)
    this.name = 'BadParamError'
  }
}

/**
 * Coerce an unknown query value to an integer inside [min, max], falling
 * back when it is missing or unparseable. The result is always a finite
 * integer, which is what makes it safe to use for LIMIT/START.
 */
export function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** Narrow a query value to a chamber, or null when absent/unrecognised. */
export function parseChamber(raw: unknown): 'camera' | 'senato' | null {
  if (raw === 'camera' || raw === 'senato') return raw
  return null
}

/**
 * Strict integer parse for an optional filter.
 *
 * Returns null when the param was not supplied at all. Throws BadParamError
 * when it was supplied but is not an integer in [min, max] -- an explicit
 * 400 beats silently dropping the filter, which produces a full unfiltered
 * result set that looks like a successful query.
 */
export function parseIntParam(
  raw: unknown,
  name: string,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  // Express gives an array when a param is repeated (?leg=1&leg=2). There is
  // no sensible single value there, so treat it as malformed.
  if (typeof raw !== 'string' && typeof raw !== 'number') throw new BadParamError(name)
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new BadParamError(name)
  return n
}

/** Legislature filter: an integer in the range the archive can hold. */
export function parseLegParam(raw: unknown, name = 'leg'): number | null {
  return parseIntParam(raw, name, { min: 1, max: 50 })
}

/**
 * Single trimmed string for a query param, or '' when absent. Express hands
 * back an array for repeated params; we take nothing rather than the
 * accidental "a,b" that String() would produce.
 */
export function parseStringParam(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}
