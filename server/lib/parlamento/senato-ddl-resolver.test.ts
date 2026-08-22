import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// We mock the network layer (fetchWithRetry) and the DB layer
// (runQuery + getDb) so the resolver runs purely in-memory. The
// actual SPARQL query string is asserted on rather than executed.

const mockFetch = vi.fn()
const mockRunQuery = vi.fn()
const mockInsert = vi.fn()
const mockGetDb = vi.fn(async () => ({ insert: mockInsert }))

vi.mock('../ingest/parlamento/parseHelpers.ts', () => ({
  fetchWithRetry: mockFetch,
  // The other helpers are unused by the resolver, but the module
  // exports them, so we provide stubs.
  parseSpeakerLabel: vi.fn(),
  shortenTitle: vi.fn(),
  slugify: vi.fn(),
}))

vi.mock('../db.ts', () => ({
  getDb: mockGetDb,
  closeDb: vi.fn(),
}))

vi.mock('../query.ts', () => ({
  runQuery: mockRunQuery,
}))

// Import AFTER mocks are wired so the resolver picks up the doubles.
const { resolveSenatoBill, sparqlLookup } = await import('./senato-ddl-resolver.ts')

function sparqlOk(ddlIri: string) {
  return {
    ok: true,
    json: async () => ({ results: { bindings: [{ ddl: { value: ddlIri } }] } }),
  }
}

function sparqlEmpty() {
  return {
    ok: true,
    json: async () => ({ results: { bindings: [] } }),
  }
}

beforeEach(() => {
  mockFetch.mockReset()
  mockRunQuery.mockReset()
  mockInsert.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveSenatoBill', () => {
  it('returns the cached idmap row when one exists, no SPARQL call', async () => {
    mockRunQuery.mockResolvedValueOnce([
      {
        leg: 19,
        numero: 1236,
        id_ddl: '58519',
        url: 'https://www.senato.it/leg/19/BGT/Schede/Ddliter/58519.htm',
      },
    ])
    const r = await resolveSenatoBill(19, 1236)
    expect(r).toEqual({
      id_ddl: '58519',
      url: 'https://www.senato.it/leg/19/BGT/Schede/Ddliter/58519.htm',
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('queries SPARQL on cache miss, persists the idmap row, returns the URL', async () => {
    mockRunQuery.mockResolvedValueOnce([]) // cache miss
    mockFetch.mockResolvedValueOnce(sparqlOk('http://dati.senato.it/ddl/58519'))
    mockInsert.mockResolvedValueOnce([{ id: 'parlamento_senato_ddl_idmap:abc' }])

    const r = await resolveSenatoBill(19, 1236)
    expect(r).toEqual({
      id_ddl: '58519',
      url: 'https://www.senato.it/leg/19/BGT/Schede/Ddliter/58519.htm',
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // Assert the SPARQL query carries the right numero + legislatura
    // filters and uses the verified osr:numeroFase / osr:legislatura
    // predicates (live-tested against dati.senato.it).
    const calledUrl = mockFetch.mock.calls[0]![0] as string
    expect(calledUrl).toContain('dati.senato.it/sparql')
    const decoded = decodeURIComponent(calledUrl)
    expect(decoded).toContain('"1236"')
    expect(decoded).toContain('osr:legislatura 19')
    expect(decoded).toContain('osr:numeroFase')
    expect(mockInsert).toHaveBeenCalledTimes(1)
  })

  it('returns null when SPARQL returns an empty result set', async () => {
    mockRunQuery.mockResolvedValueOnce([])
    mockFetch.mockResolvedValueOnce(sparqlEmpty())
    const r = await resolveSenatoBill(19, 99999)
    expect(r).toBeNull()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('returns null when SPARQL throws (network / 5xx)', async () => {
    mockRunQuery.mockResolvedValueOnce([])
    mockFetch.mockRejectedValueOnce(new Error('connect ETIMEDOUT'))
    const r = await resolveSenatoBill(19, 1236)
    expect(r).toBeNull()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('returns null when SPARQL returns a non-OK HTTP status', async () => {
    mockRunQuery.mockResolvedValueOnce([])
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    const r = await resolveSenatoBill(19, 1236)
    expect(r).toBeNull()
  })

  it('still returns the resolved url when the idmap insert fails (race with another worker)', async () => {
    mockRunQuery.mockResolvedValueOnce([])
    mockFetch.mockResolvedValueOnce(sparqlOk('http://dati.senato.it/ddl/58519'))
    mockInsert.mockRejectedValueOnce(new Error('UNIQUE constraint violated'))
    const r = await resolveSenatoBill(19, 1236)
    expect(r).toEqual({
      id_ddl: '58519',
      url: 'https://www.senato.it/leg/19/BGT/Schede/Ddliter/58519.htm',
    })
  })
})

describe('sparqlLookup direct', () => {
  it('extracts the idDdl from the LOD URI tail', async () => {
    mockFetch.mockResolvedValueOnce(sparqlOk('http://dati.senato.it/ddl/12345'))
    const id = await sparqlLookup(19, 99)
    expect(id).toBe('12345')
  })

  it('returns null when the URI does not match the /ddl/ pattern', async () => {
    mockFetch.mockResolvedValueOnce(sparqlOk('http://dati.senato.it/something/else/'))
    const id = await sparqlLookup(19, 99)
    expect(id).toBeNull()
  })
})
