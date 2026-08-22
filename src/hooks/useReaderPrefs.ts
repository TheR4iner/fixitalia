import { useEffect, useState } from 'react'

// Persisted reading preferences for the Parlamento reader. Mirrors the
// shape of useTheme: localStorage-backed, falls back gracefully when
// storage is unavailable. Kept separate from useTheme because the user
// might want a different colour scheme for the reader than for the rest
// of the site (e.g. system theme everywhere, but explicit dark inside
// the reader for evening reading).

const STORAGE_KEY = 'fixitalia.parlamento.reader'

export type ReaderFont = 'serif' | 'sans' | 'mono'
export type ReaderSize = 16 | 18 | 20 | 22
export type ReaderLine = 1.5 | 1.7 | 1.9

export interface ReaderPrefs {
  font: ReaderFont
  size: ReaderSize
  line: ReaderLine
}

const DEFAULT_PREFS: ReaderPrefs = {
  font: 'serif',
  size: 18,
  line: 1.7,
}

function isFont(v: unknown): v is ReaderFont {
  return v === 'serif' || v === 'sans' || v === 'mono'
}

function isSize(v: unknown): v is ReaderSize {
  return v === 16 || v === 18 || v === 20 || v === 22
}

function isLine(v: unknown): v is ReaderLine {
  return v === 1.5 || v === 1.7 || v === 1.9
}

function readStored(): ReaderPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<ReaderPrefs>
    return {
      font: isFont(parsed.font) ? parsed.font : DEFAULT_PREFS.font,
      size: isSize(parsed.size) ? parsed.size : DEFAULT_PREFS.size,
      line: isLine(parsed.line) ? parsed.line : DEFAULT_PREFS.line,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function useReaderPrefs() {
  const [prefs, setPrefsState] = useState<ReaderPrefs>(() => readStored())

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    } catch {
      // unavailable storage is acceptable; the change is in-memory for the session
    }
  }, [prefs])

  function setPrefs(next: Partial<ReaderPrefs>) {
    setPrefsState((p) => ({ ...p, ...next }))
  }

  return { prefs, setPrefs }
}

/** Map a font preference to a CSS family. Kept here so consumers don't
 * inline magic strings. The "serif" choice falls back to the project's
 * `font-heading` (Source Serif loaded by the layout); "sans" uses the
 * system stack; "mono" uses the system mono stack. */
export function readerFontFamily(font: ReaderFont): string {
  switch (font) {
    case 'serif':
      return "'Source Serif 4', 'Source Serif Pro', Georgia, 'Times New Roman', serif"
    case 'sans':
      return "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    case 'mono':
      return "ui-monospace, SFMono-Regular, 'JetBrains Mono', 'Fira Code', monospace"
  }
}
