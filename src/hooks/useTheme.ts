import { useEffect, useState } from 'react'

// Theme management with three user-visible options: follow the system,
// explicit light, explicit dark. The "system" default respects the user's
// OS choice and reacts to changes at runtime.
//
// Initial application happens in an inline script in index.html (to avoid
// a pre-hydration colour flash). This hook owns *updates*: user toggles
// and system-preference changes after mount.

const STORAGE_KEY = 'fixitalia.theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark') return v
    return 'system'
  } catch {
    return 'system'
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia(DARK_QUERY).matches
}

function resolve(pref: ThemePreference): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref
  return systemPrefersDark() ? 'dark' : 'light'
}

function applyResolved(resolved: ResolvedTheme) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', resolved === 'dark')
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStoredPreference(),
  )
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolve(readStoredPreference()),
  )

  // Keep the DOM class in sync with the resolved theme.
  useEffect(() => {
    applyResolved(resolved)
  }, [resolved])

  // Recompute resolved whenever the preference changes, and subscribe to
  // system changes when the preference is "system".
  useEffect(() => {
    setResolved(resolve(preference))
    if (preference !== 'system') return

    const mq = window.matchMedia(DARK_QUERY)
    const onChange = (e: MediaQueryListEvent) =>
      setResolved(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [preference])

  function setPreference(next: ThemePreference) {
    setPreferenceState(next)
    try {
      if (next === 'system') window.localStorage.removeItem(STORAGE_KEY)
      else window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage unavailable; the preference will revert on reload, which
      // is acceptable.
    }
  }

  return { preference, resolved, setPreference }
}
