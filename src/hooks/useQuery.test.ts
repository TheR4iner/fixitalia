import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

import { STORAGE_KEY } from './useQuery'

// The useQuery hook hydrates its cache from localStorage at module load
// time. To exercise that hydration path cleanly, each test calls
// `vi.resetModules()` and then dynamically imports the hook module AFTER
// seeding localStorage with whatever fixture it wants. This mirrors what
// a real cold page load does: the browser runs the module once and it
// reads whatever is already in storage.

// The storage key is IMPORTED, not restated. It used to be a literal
// ('fixitalia.query.v3') with a comment asking the next person to bump it in
// lockstep -- and the next bump duly broke three tests with an opaque
// "expected 'loading' to be 'success'", because the fixtures were seeded at a
// key the hook no longer reads.
//
// Importing it here is safe despite the resetModules dance below: STORAGE_KEY
// is a pure constant, and every test re-imports the module itself AFTER seeding
// storage, so this early evaluation is discarded and the hydration path is
// still exercised from scratch.

function seedStorage(entries: Record<string, { data: unknown; fetchedAt: number }>) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

async function loadHook() {
  vi.resetModules()
  return await import('./useQuery')
}

// Flush the microtask queue so the hook's batched write to localStorage
// lands before the test inspects storage.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => resolve()))
}

describe('useQuery', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('renders instantly from localStorage on a cold load with a fresh cached entry', async () => {
    seedStorage({
      '["cold"]': { data: { n: 42 }, fetchedAt: Date.now() },
    })

    const { useQuery } = await loadHook()

    const fetcher = vi.fn().mockResolvedValue({ n: 42 })
    const { result } = renderHook(() => useQuery(['cold'], fetcher))

    // First render must already be success, not loading.
    expect(result.current.status).toBe('success')
    expect(result.current.data).toEqual({ n: 42 })
    // Cache is within TTL so no network call happens at all.
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps showing cached data when a background refetch fails', async () => {
    // Seed with a stale entry (2 days old) so the refetch actually fires.
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
    seedStorage({
      '["stale"]': { data: { n: 1 }, fetchedAt: twoDaysAgo },
    })

    const { useQuery } = await loadHook()

    const fetcher = vi.fn().mockRejectedValue(new Error('backend 404'))
    const { result } = renderHook(() => useQuery(['stale'], fetcher))

    // Immediately renders from storage.
    expect(result.current.data).toEqual({ n: 1 })
    expect(result.current.status).toBe('success')

    // Wait for the doomed refetch to finish.
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.isFetching).toBe(false))

    // The core guarantee: stale cached data stays visible, no error flip.
    expect(result.current.data).toEqual({ n: 1 })
    expect(result.current.status).toBe('success')
    expect(result.current.error).toBeNull()
  })

  it('falls back to the error state only when there is no cache at all', async () => {
    const { useQuery } = await loadHook()

    const fetcher = vi.fn().mockRejectedValue(new Error('backend 404'))
    const { result } = renderHook(() => useQuery(['missing'], fetcher))

    expect(result.current.status).toBe('loading')

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.data).toBeNull()
    expect(result.current.error?.message).toBe('backend 404')
  })

  it('persists a successful fetch to localStorage so the next cold load is instant', async () => {
    const { useQuery } = await loadHook()

    const fetcher = vi.fn().mockResolvedValue({ n: 7 })
    const { result } = renderHook(() => useQuery(['persisted'], fetcher))

    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.data).toEqual({ n: 7 })

    // The write is batched via queueMicrotask, so yield once.
    await flushMicrotasks()

    const raw = window.localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as Record<string, { data: unknown }>
    expect(parsed['["persisted"]']?.data).toEqual({ n: 7 })
  })

  it('does not keep refetching fresh keys after a manual refetch', async () => {
    // Regression: the freshness check used to be `refreshNonce === 0`, so a
    // single refetch() left the nonce >0 forever and every later key change
    // bypassed the TTL for the life of the component.
    const { useQuery } = await loadHook()

    const fetcher = vi.fn().mockResolvedValue({ n: 1 })
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useQuery([key], fetcher),
      { initialProps: { key: 'a' } },
    )

    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Explicit refetch: this one SHOULD hit the network again.
    act(() => result.current.refetch())
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))

    // Move to a second key, then back to 'a'. Both are now cached and fresh,
    // so neither should trigger a fetch.
    rerender({ key: 'b' })
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))

    rerender({ key: 'a' })
    await waitFor(() => expect(result.current.status).toBe('success'))
    // Still 3: returning to a fresh key must not refetch.
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('evicts least-recently-used entries instead of blowing the storage quota', async () => {
    const { useQuery, __clearQueryCache } = await loadHook()
    __clearQueryCache()

    // ~400KB per entry: over the per-entry persist ceiling (256KB), so these
    // must be served from memory but never written to storage.
    const big = 'x'.repeat(400 * 1024)
    const fetcher = vi.fn().mockResolvedValue({ blob: big })
    const { result } = renderHook(() => useQuery(['huge'], fetcher))

    await waitFor(() => expect(result.current.status).toBe('success'))
    // In-memory it is fully available -- the session keeps working.
    expect((result.current.data as { blob: string }).blob.length).toBe(big.length)

    await flushMicrotasks()
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    // ...but it was not persisted, so it cannot exhaust the quota.
    expect(parsed['["huge"]']).toBeUndefined()
    expect((raw ?? '').length).toBeLessThan(3 * 1024 * 1024)
  })

  it('ignores entries under a different cache version', async () => {
    // An entry the user had from an earlier schema version.
    window.localStorage.setItem(
      'fixitalia.query.v0',
      JSON.stringify({
        '["foo"]': { data: { old: true }, fetchedAt: Date.now() },
      }),
    )

    const { useQuery } = await loadHook()

    const fetcher = vi.fn().mockResolvedValue({ new: true })
    const { result } = renderHook(() => useQuery(['foo'], fetcher))

    // No prior cache entry existed, so the hook must fetch rather than hydrate.
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.data).toEqual({ new: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
