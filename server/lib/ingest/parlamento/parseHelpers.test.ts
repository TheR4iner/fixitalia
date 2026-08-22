import { describe, expect, it } from 'vitest'

import {
  htmlToText,
  parseSpeakerLabel,
  shortenTitle,
  slugify,
  speakerSlug,
} from './parseHelpers.ts'

describe('slugify', () => {
  it('lowercases, strips diacritics, replaces non-alphanumerics with dashes', () => {
    expect(slugify('Andò Caligiuri Più')).toBe('ando-caligiuri-piu')
  })
  it('trims leading/trailing dashes', () => {
    expect(slugify('---hello world---')).toBe('hello-world')
  })
  it('caps at 80 characters', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(80)
  })
})

describe('speakerSlug', () => {
  it('namespaces by chamber and includes role to disambiguate', () => {
    expect(speakerSlug('Mario Rossi', 'camera', null)).toBe('camera-mario-rossi')
    expect(speakerSlug('Mario Rossi', 'camera', 'Ministro')).toBe(
      'camera-mario-rossi-ministro',
    )
    expect(speakerSlug('Mario Rossi', 'senato', null)).toBe('senato-mario-rossi')
  })
})

describe('parseSpeakerLabel', () => {
  it('extracts a parenthetical group', () => {
    const r = parseSpeakerLabel('ROSSI Mario (FdI)', 'camera')
    expect(r.nome).toBe('ROSSI Mario')
    expect(r.gruppo).toBe('FdI')
  })
  it('detects the Presidente role', () => {
    const r = parseSpeakerLabel('PRESIDENTE.', 'camera')
    expect(r.ruolo).toBe('Presidente')
  })
  it('detects the Ministra role inline', () => {
    const r = parseSpeakerLabel('Ministra MELONI Giorgia', 'camera')
    expect(r.ruolo).toBe('Ministra')
    expect(r.nome.toUpperCase()).toContain('MELONI')
  })
  it('produces a stable slug', () => {
    const r1 = parseSpeakerLabel('ROSSI Mario (FdI)', 'camera')
    const r2 = parseSpeakerLabel('ROSSI Mario (FdI)', 'camera')
    expect(r1.slug).toBe(r2.slug)
  })
})

describe('htmlToText', () => {
  it('strips tags and normalises whitespace', () => {
    expect(htmlToText('<p>Hello <em>world</em>!</p>')).toBe('Hello world!')
  })
  it('decodes the common named entities', () => {
    expect(htmlToText('&amp; &lt; &gt; &quot; &#39;')).toBe(`& < > " '`)
  })
})

describe('shortenTitle', () => {
  it('keeps short titles intact', () => {
    expect(shortenTitle('Hello world')).toBe('Hello world')
  })
  it('truncates long titles with an ellipsis', () => {
    const long = 'a'.repeat(200)
    const out = shortenTitle(long, 50)
    expect(out.length).toBeLessThanOrEqual(50)
    expect(out.endsWith('...')).toBe(true)
  })
})
