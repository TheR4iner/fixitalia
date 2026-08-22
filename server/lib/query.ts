import { getDb, resetDb } from './db.ts'

// Shared SurrealQL query helper used by every section's routes file.
//
// Responsibilities:
//  - Acquire the lazy singleton DB client and run the query.
//  - Unwrap the first statement's result (our queries are always a single
//    statement) so callers don't have to.
//  - Transparently retry once if the SDK reports an expired session or
//    authentication failure. SurrealDB v2 session tokens have a short TTL
//    and, while passing `authentication` as a callback to `connect()`
//    should cause the SDK to refresh them automatically, we still see
//    "token has expired" surface under some SDK edge cases. The retry is
//    a belt-and-braces fallback: drop the cached client, let getDb()
//    reconnect from scratch, and run the query again. If it fails a
//    second time, the error propagates as before.
//
// Bind parameters are passed through to the SDK's `query(sql, bindings)`
// overload. Route handlers should never interpolate user input into the
// SQL string; always use $param bindings.
//
// -----------------------------------------------------------------------------
// READ THIS BEFORE WRITING A `count()` WITH MORE THAN ONE FILTER.
//
// In the SurrealDB version this project runs, `SELECT count() ... GROUP ALL`
// with several indexable predicates can answer the aggregate from ONE index
// and SILENTLY DROP the others. No error, no warning: just a number that is
// too large. Reproduced on real data in this database:
//
//   WHERE stato = "ATTIVO" AND regione = "Sicilia"   count() 3.247 vs true 3.090
//   WHERE regione = "Sicilia" AND stato = "ATTIVO"   count() 45.202 (!)
//   WHERE chamber = "camera" AND data >= .. AND <=   count()   187 vs true 115
//
// Note the second line: swapping the order of two conditions changes which one
// gets dropped. That is the diagnostic tell, and it is also why this is easy to
// miss -- each query looks locally reasonable.
//
// Whenever a count() carries more than one filter, do ONE of:
//   1. verify it against `array::len((SELECT VALUE id FROM ... WHERE ...))`,
//      which is always correct, and leave a comment saying you did;
//   2. add `WITH NOINDEX` to force a scan (correct, but costs ~1,4s on the
//      175k-row tables, so only where the table is small);
//   3. derive the number by arithmetic from counts that each carry a single
//      predicate (see routes/appalti.ts /by-regione).
//
// GROUP BY aggregates and plain materialised SELECTs are NOT affected; they
// apply every predicate. It is specifically the count() aggregate path.
// -----------------------------------------------------------------------------

type SurrealLikeError = { message?: string; cause?: unknown } | Error | string | unknown

function errorMessage(err: SurrealLikeError): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message?: unknown }).message ?? '')
  }
  return ''
}

function errorCauseCode(err: SurrealLikeError): string {
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause
    if (typeof cause === 'object' && cause !== null && 'code' in cause) {
      return String((cause as { code?: unknown }).code ?? '')
    }
  }
  return ''
}

function errorHttpStatus(err: SurrealLikeError): number | null {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const s = (err as { status?: unknown }).status
    if (typeof s === 'number') return s
  }
  return null
}

function isExpiredSessionError(err: SurrealLikeError): boolean {
  // Primary signal: SurrealDB returns HTTP 401 when the HTTP session
  // token has expired (v2.6.5 introduces the new wording, v2.1.4 used
  // the older one; the status is consistent across both).
  if (errorHttpStatus(err) === 401) return true
  // Fallback: message-shape matching for SDK paths that don't surface
  // `status` cleanly (WS engine, wrapped errors).
  //   v2.1.4  : "The token has expired"
  //   v2.6.5  : "There was a problem with authentication"
  //   variant : "HTTP connection failed: There was a problem with the
  //             database: The token has expired"
  const msg = errorMessage(err)
  return (
    /token has expired/i.test(msg) ||
    /invalid session/i.test(msg) ||
    /problem with authentication/i.test(msg)
  )
}

/**
 * Returns true for transport-level failures that look retryable: the
 * SurrealDB HTTP/WS engine dropped the connection mid-call. Caused by
 * server restarts, idle-timeout-on-keepalive, or specific server-side
 * crashes that close the socket. Distinct from user/SQL errors which we
 * never want to retry.
 */
function isRetryableTransportError(err: SurrealLikeError): boolean {
  const msg = errorMessage(err)
  const code = errorCauseCode(err)
  return (
    /fetch failed/i.test(msg) ||
    /socket hang up/i.test(msg) ||
    /ECONNRESET/i.test(msg) ||
    code === 'UND_ERR_SOCKET' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED'
  )
}

// Retry schedule for reconnect attempts, in milliseconds of backoff BEFORE
// each attempt. The first retry is immediate (the common case is a genuinely
// expired token, where reconnecting fixes it instantly); the later ones give a
// recovering datastore time to come back.
//
// Sized from a real incident (2026-08-16): the backend started alongside
// SurrealDB, issued its first query 8s later while a multi-GB RocksDB store
// was still opening, and got "There was a problem with authentication". The
// old code retried exactly once, 8ms later, which was far too fast to help --
// and once that retry failed the error propagated to a caller that swallowed
// it, so the daily ingest silently no-opped for a month. Total wait here is
// ~7s, which covers a datastore that is still finishing its open.
const RECONNECT_BACKOFF_MS = [0, 500, 1_500, 5_000]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Run `op` against the SurrealDB client, transparently reconnecting and
 * retrying on expired-session or transport-level failures. Each attempt drops
 * the cached client first so `getDb()` reopens from scratch.
 *
 * Use this to wrap raw `db.insert` / `db.update` / `db.delete` calls that
 * otherwise bypass the retry logic baked into `runQuery`. SDK-level
 * operations don't have a retry hook of their own, so a single mid-ingest
 * connection drop dumps every subsequent call until the process exits.
 */
export async function withDbRetry<T>(op: (db: Awaited<ReturnType<typeof getDb>>) => Promise<T>): Promise<T> {
  try {
    const db = await getDb()
    return await op(db)
  } catch (err) {
    if (!isExpiredSessionError(err) && !isRetryableTransportError(err)) throw err
    const kind = isExpiredSessionError(err) ? 'session expired' : 'transport error'

    let lastErr: unknown = err
    for (let attempt = 0; attempt < RECONNECT_BACKOFF_MS.length; attempt += 1) {
      const backoff = RECONNECT_BACKOFF_MS[attempt]
      if (backoff > 0) await sleep(backoff)
      console.warn(
        `[query] ${kind}, reconnecting (attempt ${attempt + 1}/${RECONNECT_BACKOFF_MS.length})`,
      )
      try {
        await resetDb()
        const db = await getDb()
        const out = await op(db)
        if (attempt > 0) console.log(`[query] recovered after ${attempt + 1} reconnect attempts`)
        return out
      } catch (retryErr) {
        lastErr = retryErr
        // A non-connection error on the retry is a real failure; stop early
        // rather than burning the remaining budget on it.
        if (!isExpiredSessionError(retryErr) && !isRetryableTransportError(retryErr)) throw retryErr
      }
    }
    console.error(
      `[query] gave up after ${RECONNECT_BACKOFF_MS.length} reconnect attempts:`,
      lastErr instanceof Error ? lastErr.message : lastErr,
    )
    throw lastErr
  }
}

export async function runQuery<T>(
  query: string,
  bindings: Record<string, unknown> = {},
): Promise<T> {
  return withDbRetry(async (db) => {
    const response = (await db.query(query, bindings)) as unknown as T[]
    return response[0] as T
  })
}
