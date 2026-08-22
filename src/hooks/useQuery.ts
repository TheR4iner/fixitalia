import { useEffect, useRef, useState } from 'react'

// Persistent stale-while-revalidate query hook.
//
// Goals, in order of importance:
//
//   1. The user must never see a hard error screen for data they have seen
//      at least once before. Italian government open data is updated at
//      most a handful of times per year, so any value we have previously
//      rendered is a valid fallback indefinitely. A transient backend 404,
//      a dev-watcher glitch, an offline airport wifi -- none of these
//      should blank the page.
//
//   2. A cold page load (hard reload, new tab) should render instantly
//      from the last-known-good data, with no loading state, as long as
//      the cache has something for the key. The background refetch runs
//      silently.
//
//   3. No refetch at all if the cache is fresh (within TTL). Default TTL
//      is 24h because the upstream datasets update at most a few times a
//      year, so refetching every half hour is pure waste.
//
// Implementation: a single-object cache in `localStorage` under one key,
// loaded lazily at first use and written through on every successful
// fetch. Keyed by the hash of the serialised query key. A schema version
// lets us invalidate the whole cache when the response shape changes.
//
// This replaces the earlier in-memory-only cache from PR #3. All the same
// semantics hold (stale-while-revalidate, sequence numbering for
// pagination, manual refetch); the only difference is that cache entries
// now outlive a hard reload.

// Bump this when the shape of any cached response changes, OR when a new
// data source has been added that previous caches will have wrongly
// recorded as empty. Old entries under previous versions are discarded
// on load. v2 invalidated pre-parlamento empty caches. v3 invalidates
// pre-body-ingest empty parlamento session caches.
//
// v4 invalidates every entry written before the spesa-pubblica snapshot fix.
// This bump is not cosmetic: the TTL is 24 hours and reads are
// stale-while-revalidate, so without it every returning visitor would keep
// seeing the OLD, WRONG spesa figures (a two-month cumulative labelled as a
// full year) for a day after the deploy -- and the new copy would render the
// cached `anno` alongside them, producing captions like "nell'intero 2026, per
// tutte le 33 missioni" over a February number. Verified by reproducing
// exactly that in the browser against a corrected backend.
//
// Any change to a response shape in server/routes/ needs this bumped in the
// same commit.
const CACHE_VERSION = 4
// Exported so the tests address the live key instead of hardcoding a version
// that goes stale on the next bump.
export const STORAGE_KEY = `fixitalia.query.v${CACHE_VERSION}`

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// Budget for the persisted cache, in characters of serialised JSON (roughly
// bytes for our mostly-ASCII payloads).
//
// localStorage is ~5MB per origin in every current browser. Without a budget
// the cache was append-only: one entry per query key, forever, serialised in
// full on every write. The parlamento reader alone asks for whole sedute
// (pageSize=5000, full `testo` per intervento -- megabytes each), so a few
// transcript visits could exhaust the quota. The failure was silent and
// total: setItem throws QuotaExceededError, the catch below logs a warning
// nobody reads, and persistence stops working for the rest of the session --
// which is exactly the "cold load renders instantly from cache" promise this
// hook exists to keep.
//
// 3MB leaves headroom under the 5MB quota for other origin storage.
const MAX_CACHE_CHARS = 3 * 1024 * 1024

// Entries larger than this are kept in memory for the session but never
// persisted. A single 2MB seduta transcript would otherwise evict every
// small, cheap-to-keep listing entry in the cache to make room for itself.
const MAX_PERSISTED_ENTRY_CHARS = 256 * 1024

interface CacheEntry<T = unknown> {
  data: T
  fetchedAt: number
  /** Last read or write, used as the LRU recency key. Not persisted-critical. */
  usedAt?: number
}

type CacheShape = Record<string, CacheEntry>

// ---------------------------------------------------------------------------
// Storage layer
// ---------------------------------------------------------------------------

// Safe SSR / private-browsing fallback: if localStorage is unavailable or
// throws (Safari private mode, quota exceeded, etc.), we silently keep an
// in-memory shadow so the app still works for the session.
function isStorageAvailable(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const probe = '__fixitalia_probe__'
    window.localStorage.setItem(probe, probe)
    window.localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

const STORAGE_OK = isStorageAvailable()

// Hydrate the cache from localStorage once, at module load. A full page
// reload re-runs this module and rebuilds the in-memory mirror from the
// persisted snapshot, so the first render after a reload has the same
// data as before the reload.
function loadCache(): CacheShape {
  if (!STORAGE_OK) return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as CacheShape
  } catch (err) {
    console.warn('[useQuery] failed to load cache from storage:', err)
    return {}
  }
}

const cache: CacheShape = loadCache()

/**
 * Build the object to persist: drop oversized entries, then evict
 * least-recently-used entries until the payload fits MAX_CACHE_CHARS.
 *
 * Eviction is computed against a copy rather than against `cache` itself --
 * the in-memory cache stays complete for the session, so a value that is too
 * big or too cold to persist is still served instantly on re-navigation. Only
 * what survives a reload is trimmed.
 */
function buildPersistPayload(): string | null {
  const entries = Object.entries(cache)
    .filter(([, e]) => {
      // Cheap per-entry size guard before the expensive whole-cache pass.
      try {
        return JSON.stringify(e).length <= MAX_PERSISTED_ENTRY_CHARS
      } catch {
        // Unserialisable (cycles, BigInt); it can't be persisted at all.
        return false
      }
    })
    // Most recently used first, so the tail is what gets dropped.
    .sort((a, b) => (b[1].usedAt ?? b[1].fetchedAt) - (a[1].usedAt ?? a[1].fetchedAt))

  const kept: CacheShape = {}
  let used = 2 // the enclosing braces
  for (const [key, entry] of entries) {
    const chunk = JSON.stringify(entry).length + key.length + 4 // quotes, colon, comma
    if (used + chunk > MAX_CACHE_CHARS) break
    kept[key] = entry
    used += chunk
  }

  try {
    return JSON.stringify(kept)
  } catch {
    return null
  }
}

// Batch writes so rapid consecutive updates don't each serialize the whole
// cache. A zero-delay microtask is enough because React batches state
// updates anyway.
let flushScheduled = false
function flushCacheSoon() {
  if (!STORAGE_OK) return
  if (flushScheduled) return
  flushScheduled = true
  queueMicrotask(() => {
    flushScheduled = false
    const payload = buildPersistPayload()
    if (payload == null) return
    try {
      window.localStorage.setItem(STORAGE_KEY, payload)
    } catch (err) {
      // Still possible if the quota is smaller than we assumed or other
      // origin storage grew. Drop the persisted copy rather than leaving a
      // stale one behind, and keep serving from memory.
      console.warn('[useQuery] failed to persist cache, clearing it:', err)
      try {
        window.localStorage.removeItem(STORAGE_KEY)
      } catch {
        // nothing further we can do; the in-memory cache still works
      }
    }
  })
}

function writeEntry<T>(key: string, entry: CacheEntry<T>) {
  cache[key] = { ...entry, usedAt: Date.now() } as CacheEntry<unknown>
  flushCacheSoon()
}

function readEntry<T>(key: string): CacheEntry<T> | undefined {
  const entry = cache[key] as CacheEntry<T> | undefined
  // Touch on read so a key that is read often but written rarely (a listing
  // the user keeps coming back to) does not age out behind write-heavy keys.
  if (entry) entry.usedAt = Date.now()
  return entry
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type QueryStatus = 'loading' | 'success' | 'error'

export interface QueryResult<T> {
  status: QueryStatus
  data: T | null
  error: Error | null
  isFetching: boolean
  refetch: () => void
}

interface UseQueryOptions {
  /** TTL in milliseconds. After this age, a refetch fires on next mount. */
  ttlMs?: number
}

function serializeKey(key: unknown): string {
  return JSON.stringify(key)
}

export function useQuery<T>(
  key: unknown,
  fetcher: () => Promise<T>,
  options: UseQueryOptions = {},
): QueryResult<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cacheKey = serializeKey(key)
  const initialEntry = readEntry<T>(cacheKey)

  // Hydrate state from the cache at mount so first render is instant.
  const [data, setData] = useState<T | null>(initialEntry?.data ?? null)
  const [error, setError] = useState<Error | null>(null)
  const [isFetching, setIsFetching] = useState<boolean>(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  // Sequence number prevents an out-of-order response from overwriting a
  // fresher one when the user changes the key rapidly (e.g. paginating).
  const requestSeq = useRef(0)
  // The nonce value the last fetch actually ran under. The freshness check
  // below compares against THIS rather than against 0: `refreshNonce === 0`
  // meant that once the user hit a retry button, the nonce stayed >0 for the
  // life of the component, so every later key change (every page turn, every
  // filter tweak) bypassed the TTL and refetched -- silently defeating goal
  // #3 above for the rest of the session.
  const servedNonce = useRef(0)

  useEffect(() => {
    const now = Date.now()
    const entry = readEntry<T>(cacheKey)
    const isFresh = entry != null && now - entry.fetchedAt < ttlMs

    // Seed state from cache so a remount renders instantly.
    if (entry) {
      setData(entry.data)
      setError(null)
    } else {
      setData(null)
    }

    // Skip the network entirely if we are within TTL and the user has not
    // asked for a refetch since the last time we served this hook.
    if (isFresh && refreshNonce === servedNonce.current) {
      return
    }
    servedNonce.current = refreshNonce

    const seq = ++requestSeq.current
    setIsFetching(true)
    fetcher()
      .then((fresh) => {
        if (seq !== requestSeq.current) return
        writeEntry(cacheKey, { data: fresh, fetchedAt: Date.now() })
        setData(fresh)
        setError(null)
        setIsFetching(false)
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return
        const wrapped = err instanceof Error ? err : new Error(String(err))
        // If we already have data for this key in the cache, keep it on
        // screen and just record the error in the console. The page does
        // not need to know about a transient refetch failure -- the whole
        // point of this hook is that stale data beats a broken screen.
        const haveData = readEntry(cacheKey) != null
        if (!haveData) {
          setError(wrapped)
        } else {
          console.warn(`[useQuery] background refetch failed for ${cacheKey}:`, wrapped.message)
        }
        setIsFetching(false)
      })

    // fetcher is intentionally excluded -- callers pass a fresh closure on
    // every render. The serialised key drives the refetch decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, refreshNonce, ttlMs])

  const status: QueryStatus =
    data != null ? 'success' : error != null ? 'error' : 'loading'

  return {
    status,
    data,
    error,
    isFetching,
    refetch: () => setRefreshNonce((n) => n + 1),
  }
}

/** Test helper -- clear both the in-memory and persisted cache. */
export function __clearQueryCache() {
  for (const k of Object.keys(cache)) delete cache[k]
  if (STORAGE_OK) {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // best effort
    }
  }
}
