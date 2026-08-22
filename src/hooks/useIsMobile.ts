import { useEffect, useState } from 'react'

// Small hook for when a component needs to know the viewport family at JS
// level (e.g. to pass different props to a third-party chart). For pure
// CSS decisions prefer Tailwind responsive utilities -- they reflow on
// resize without re-renders.
//
// The query matches "small and below", i.e. phones and small tablets in
// portrait. Mirrors the `sm` breakpoint in Tailwind (640px).

const MOBILE_QUERY = '(max-width: 639px)'

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(MOBILE_QUERY).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
