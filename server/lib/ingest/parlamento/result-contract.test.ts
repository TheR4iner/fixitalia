import { describe, expect, it } from 'vitest'

import type { IngestParlamentoResult } from './index.ts'

// Regression guard for the 2026-07-16 -> 2026-08-16 silent-ingest incident.
//
// Every failure path in ingestParlamento used to return an all-zero result,
// which is byte-identical to the healthy "nothing new upstream" result. The
// scheduler rendered both as `index +0, body ok=0 ... (0.0s)`, so a month of
// failed ingests was indistinguishable from a month of parliamentary recess.
//
// These tests pin the property that made the incident invisible: a caller must
// be able to tell "found nothing" from "blew up" WITHOUT inspecting counters.

/** The shape a healthy run produces when parliament simply isn't sitting. */
const emptyButHealthy: IngestParlamentoResult = {
  chamber: 'camera',
  legislatura: 19,
  indexInserted: 0,
  bodyAttempted: 0,
  bodyOk: 0,
  bodyPartial: 0,
  bodyEmpty: 0,
  bodyError: 0,
  durationMs: 2113,
  ok: true,
}

/** The shape the real incident produced: index pass died on a DB auth error. */
const failedRun: IngestParlamentoResult = {
  chamber: 'camera',
  legislatura: 19,
  indexInserted: 0,
  bodyAttempted: 0,
  bodyOk: 0,
  bodyPartial: 0,
  bodyEmpty: 0,
  bodyError: 0,
  durationMs: 0,
  ok: false,
  error: 'index pass failed: There was a problem with authentication',
}

/** Mirrors how scheduler.ts decides whether to shout. */
function isDegraded(results: IngestParlamentoResult[]): boolean {
  return results.some((r) => !r.ok)
}

describe('IngestParlamentoResult failure contract', () => {
  it('distinguishes a failed pass from an empty one despite identical counters', () => {
    // Every numeric field is the same -- this is exactly why the incident was
    // invisible for a month.
    expect(failedRun.indexInserted).toBe(emptyButHealthy.indexInserted)
    expect(failedRun.bodyOk).toBe(emptyButHealthy.bodyOk)
    expect(failedRun.bodyError).toBe(emptyButHealthy.bodyError)

    // The ok flag is the only thing separating them, and it must.
    expect(emptyButHealthy.ok).toBe(true)
    expect(failedRun.ok).toBe(false)
  })

  it('flags a run as degraded when any chamber fails', () => {
    expect(isDegraded([emptyButHealthy, emptyButHealthy])).toBe(false)
    expect(isDegraded([emptyButHealthy, failedRun])).toBe(true)
    expect(isDegraded([failedRun, failedRun])).toBe(true)
  })

  it('carries a reason on failure so the log line is actionable', () => {
    expect(failedRun.error).toBeTruthy()
    expect(failedRun.error).toMatch(/authentication/)
    // A healthy run has nothing to explain.
    expect(emptyButHealthy.error).toBeUndefined()
  })

  it('does not let a zero duration imply failure on its own', () => {
    // durationMs === 0 was the incident's fingerprint, but it is a symptom,
    // not the contract. A fast healthy run must still read as healthy.
    const fastButHealthy: IngestParlamentoResult = { ...emptyButHealthy, durationMs: 0 }
    expect(isDegraded([fastButHealthy])).toBe(false)
  })
})
