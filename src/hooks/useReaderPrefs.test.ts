import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { readerFontFamily, useReaderPrefs } from './useReaderPrefs'

const STORAGE_KEY = 'fixitalia.parlamento.reader'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('useReaderPrefs', () => {
  it('starts at the default preferences', () => {
    const { result } = renderHook(() => useReaderPrefs())
    expect(result.current.prefs.font).toBe('serif')
    expect(result.current.prefs.size).toBe(18)
    expect(result.current.prefs.line).toBe(1.7)
  })

  it('persists changes to localStorage', () => {
    const { result } = renderHook(() => useReaderPrefs())
    act(() => result.current.setPrefs({ font: 'sans', size: 22 }))
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      font: string
      size: number
      line: number
    }
    expect(persisted.font).toBe('sans')
    expect(persisted.size).toBe(22)
    // Line should keep its previous default since we did not touch it.
    expect(persisted.line).toBe(1.7)
  })

  it('rejects invalid stored values and falls back to defaults', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ font: 'comic-sans', size: 99, line: 'big' }),
    )
    const { result } = renderHook(() => useReaderPrefs())
    expect(result.current.prefs.font).toBe('serif')
    expect(result.current.prefs.size).toBe(18)
    expect(result.current.prefs.line).toBe(1.7)
  })
})

describe('readerFontFamily', () => {
  it('returns a serif stack for serif', () => {
    expect(readerFontFamily('serif')).toMatch(/serif/i)
  })
  it('returns a sans stack for sans', () => {
    expect(readerFontFamily('sans')).toMatch(/sans|system-ui/i)
  })
  it('returns a mono stack for mono', () => {
    expect(readerFontFamily('mono')).toMatch(/mono/i)
  })
})
