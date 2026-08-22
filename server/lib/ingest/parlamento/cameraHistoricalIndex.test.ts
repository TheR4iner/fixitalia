import { describe, it, expect } from 'vitest'

import { parseItalianDate } from './cameraHistoricalIndex.ts'

// The mangled ordinal day ("1° aprile" arriving as "1� aprile" because the
// Latin-1 0xB0 byte decodes to U+FFFD) was silently dropping every
// first-of-month session from the leg 13/14 index. Build the bytes from char
// codes so the test does not depend on source-file encoding.
const REPLACEMENT = String.fromCharCode(0xfffd) // �
const DEGREE = '°' // °

describe('parseItalianDate', () => {
  it('parses the normal "21 novembre 1996" form', () => {
    expect(parseItalianDate('21 novembre 1996')?.toISOString()).toBe('1996-11-21T00:00:00.000Z')
  })

  it('parses the leg-13 "21novembre 1996" typo (no space)', () => {
    expect(parseItalianDate('21novembre 1996')?.toISOString()).toBe('1996-11-21T00:00:00.000Z')
  })

  it('parses an ordinal first-of-month with a real degree sign', () => {
    expect(parseItalianDate(`1${DEGREE} aprile 1997`)?.toISOString()).toBe('1997-04-01T00:00:00.000Z')
  })

  it('parses an ordinal first-of-month mangled to the replacement char', () => {
    // This is exactly what leg13 sed172 produced -> previously dropped.
    expect(parseItalianDate(`Seduta di martedì 1${REPLACEMENT} aprile 1997`)?.toISOString()).toBe(
      '1997-04-01T00:00:00.000Z',
    )
  })

  it('still returns null for genuinely dateless text', () => {
    expect(parseItalianDate('INDICE')).toBeNull()
    expect(parseItalianDate('')).toBeNull()
  })
})
