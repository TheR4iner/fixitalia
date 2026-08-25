import { describe, expect, it } from 'vitest'

import { commissioneSedutaUrl, scopeFromRecordId } from './parlamento'

// Committee sittings are addressed by document scope, extracted from a
// SurrealDB record id. The delimiter around a quoted id depends on which layer
// stringified it, and getting that wrong 400s every reader link -- so both
// forms are pinned here.

describe('scopeFromRecordId', () => {
  it('strips the table prefix', () => {
    expect(scopeFromRecordId('parlamento_sedute:sc-18-1070263')).toBe('sc-18-1070263')
  })

  it('strips BACKTICK quoting, as emitted by SurrealQL type::string()', () => {
    expect(
      scopeFromRecordId('parlamento_sedute:`cc-19-03-indag-c03-commercio-6`'),
    ).toBe('cc-19-03-indag-c03-commercio-6')
  })

  it('strips ANGLE-BRACKET quoting, as emitted by the JS SDK', () => {
    expect(scopeFromRecordId('parlamento_sedute:⟨cc-19-39-altro-none-49⟩')).toBe(
      'cc-19-39-altro-none-49',
    )
  })

  it('accepts a bare scope with no table prefix', () => {
    expect(scopeFromRecordId('cc-19-70-audiz2-audizione-25')).toBe(
      'cc-19-70-audiz2-audizione-25',
    )
  })

  it('returns null for empty or missing input', () => {
    expect(scopeFromRecordId(null)).toBeNull()
    expect(scopeFromRecordId(undefined)).toBeNull()
    expect(scopeFromRecordId('')).toBeNull()
    expect(scopeFromRecordId('parlamento_sedute:')).toBeNull()
  })
})

describe('commissioneSedutaUrl', () => {
  it('builds a reader URL from a quoted record id', () => {
    expect(commissioneSedutaUrl('parlamento_sedute:`cc-19-03-indag-c03-commercio-6`')).toBe(
      '/parlamento/commissioni/seduta/cc-19-03-indag-c03-commercio-6',
    )
  })

  it('appends an intervento anchor when given one', () => {
    expect(commissioneSedutaUrl('parlamento_sedute:sc-18-1070263', 'int-4')).toBe(
      '/parlamento/commissioni/seduta/sc-18-1070263#int-4',
    )
  })

  it('returns null when there is no id to build from', () => {
    expect(commissioneSedutaUrl(null)).toBeNull()
  })
})
