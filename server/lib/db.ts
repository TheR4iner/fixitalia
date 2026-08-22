import { Surreal } from 'surrealdb'

// SurrealDB client singleton.
//
// We keep a single long-lived connection shared across the process. Connect
// lazily on first call so the backend boots even if the DB sidecar is still
// starting up; the first ingest or query call is what actually opens the
// connection.
//
// SurrealDB JS client v2 uses a stateful connect/use pattern. All config
// comes from environment variables set in docker-compose.yml.
//
// IMPORTANT: we pass `authentication` as a callback, not a static value.
// SurrealDB's server issues a session token after signin which eventually
// expires (default TTL is short -- on the order of an hour). Passing a
// static object signs in exactly once and then the connection starts
// returning "token has expired" on every query. Passing a callback tells
// the SDK to re-invoke it whenever the token needs to be refreshed, which
// means we stay authenticated for the lifetime of the process without
// writing any reconnect plumbing.
//
// We also catch "token has expired" + "authentication" errors in the query
// path below as a belt-and-braces fallback: if the callback refresh ever
// fails to fire (e.g. the SDK decides the error is not retryable), we
// force-close the client and lazily reconnect on the next call.

// Fall back to the SurrealDB default only in non-production. A
// misconfigured prod env (missing SURREAL_USER/PASS) would otherwise
// silently auth with the well-known root/root pair; throwing at module
// load surfaces the misconfiguration at boot instead.
function requireProdEnv(name: string, devDefault: string): string {
  const v = process.env[name]
  if (v && v.length > 0) return v
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${name} must be set in production`)
  }
  return devDefault
}

const DB_URL = process.env.SURREALDB_URL ?? 'http://fixitalia-surrealdb:8000/rpc'
const DB_NAMESPACE = process.env.SURREALDB_NAMESPACE ?? 'fixitalia'
const DB_DATABASE = process.env.SURREALDB_DATABASE ?? 'fixitalia'
// SURREAL_USER/SURREAL_PASS, not SURREALDB_* like the three above, because
// these are the SurrealDB image's OWN env vars: `surreal start` reads them
// natively. Both this container and the db container get them from the same
// .env.secrets via env_file, so one pair of keys is the single source of truth
// and the db no longer needs the credentials on its command line. Renaming them
// to match the SURREALDB_* prefix would mean defining each secret twice.
const DB_USER = requireProdEnv('SURREAL_USER', 'root')
const DB_PASS = requireProdEnv('SURREAL_PASS', 'root')

let client: Surreal | null = null
let connecting: Promise<Surreal> | null = null

async function connectFresh(): Promise<Surreal> {
  const db = new Surreal()
  await db.connect(DB_URL, {
    namespace: DB_NAMESPACE,
    database: DB_DATABASE,
    // Callable form: the SDK re-invokes this when it needs to re-auth,
    // so expired session tokens get refreshed transparently.
    authentication: () => ({ username: DB_USER, password: DB_PASS }),
  })
  console.log(`[db] connected to ${DB_URL} (ns=${DB_NAMESPACE} db=${DB_DATABASE})`)
  return db
}

export async function getDb(): Promise<Surreal> {
  if (client) return client
  if (connecting) return connecting

  connecting = (async () => {
    try {
      const db = await connectFresh()
      client = db
      return db
    } catch (err) {
      connecting = null
      throw err
    }
  })()

  return connecting
}

/**
 * Drop the cached client so the next getDb() reconnects from scratch.
 * Used by the query layer when it detects an expired / invalid session.
 */
export async function resetDb(): Promise<void> {
  const stale = client
  client = null
  connecting = null
  if (stale) {
    try {
      await stale.close()
    } catch {
      // best effort; the connection is already broken
    }
  }
}

export async function closeDb(): Promise<void> {
  await resetDb()
}
