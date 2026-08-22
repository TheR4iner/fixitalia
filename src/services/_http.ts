// Shared fetch helper used by every typed service module. Centralised so a
// future cross-cutting change (auth header, tracing, retry policy) lands in
// one place instead of five.
//
// All service-layer functions throw on non-2xx. The frontend layer above
// (useQuery) handles loading/error/stale-while-revalidate state.

/**
 * Wall-clock ceiling for a single API call.
 *
 * Without one, a backend that accepts the connection and then stalls leaves
 * the promise pending forever: useQuery stays `isFetching`, its spinner never
 * resolves, and the request is never retried. 30s is generous next to the
 * slowest endpoint we have (a whole-seduta fetch of up to 5000 interventi)
 * while still bounding the failure.
 */
const REQUEST_TIMEOUT_MS = 30_000

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  // Abort on our own timeout, but also honour a caller-supplied signal so a
  // future in-flight-cancellation caller composes rather than conflicts.
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  let res: Response
  try {
    res = await fetch(path, { signal: composed })
  } catch (err) {
    // A timeout surfaces as a TimeoutError DOMException; relabel it so the
    // message that reaches the console (and any error UI) says what happened
    // rather than the opaque "signal is aborted without reason".
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`${path} failed: timed out after ${REQUEST_TIMEOUT_MS}ms`)
    }
    throw err
  }

  if (!res.ok) {
    throw new Error(`${path} failed: HTTP ${res.status}`)
  }
  return (await res.json()) as T
}
