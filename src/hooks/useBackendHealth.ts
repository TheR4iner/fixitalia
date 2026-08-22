import { useEffect, useState } from 'react'

export type HealthStatus =
  | { state: 'loading' }
  | { state: 'ok'; data: { status: string } }
  | { state: 'error'; message: string }

/**
 * Polls /api/health once on mount. Used as a subdued signal on the home page
 * so readers know whether the data service itself is reachable.
 */
export function useBackendHealth(): HealthStatus {
  const [health, setHealth] = useState<HealthStatus>({ state: 'loading' })

  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ status: string }>
      })
      .then((data) => {
        if (!cancelled) setHealth({ state: 'ok', data })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err)
          setHealth({ state: 'error', message })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return health
}
