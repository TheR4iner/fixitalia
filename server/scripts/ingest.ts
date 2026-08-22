#!/usr/bin/env tsx
// Command line entry point for manual data ingestion.
//
// Usage (from inside the workspace container):
//   dev exec backend npx tsx scripts/ingest.ts opere-incompiute
//
// In production:
//   docker compose -f docker-compose.prod.yml exec backend \
//     npx tsx scripts/ingest.ts opere-incompiute
//
// (The old `fixitalia-dev` sidecar named here stopped existing at the
// collapsed-workspace migration.)
//
// Each data source gets a subcommand here so every ingest has the same
// operational interface. This remains the manual escape hatch; routine
// refreshes are handled in-process by lib/openDataRefresh.ts, which runs a
// staleness-gated pass at boot and once a day thereafter.

import { ingestOpereIncompiute } from '../lib/ingest/opereIncompiute.ts'
import { ingestSpesaPubblica } from '../lib/ingest/spesaPubblica.ts'
import { ingestFondiEuropei } from '../lib/ingest/fondiEuropei.ts'
import { ingestAppalti } from '../lib/ingest/appalti.ts'
import { ingestParlamento, type Chamber } from '../lib/ingest/parlamento/index.ts'
import { SenatoBlockError } from '../lib/ingest/parlamento/senatoBrowser.ts'
import { ingestCameraDeputati } from '../lib/ingest/parlamento/cameraDeputatiBulk.ts'
import { CURRENT_LEGISLATURE } from '../lib/ingest/parlamento/constants.ts'
import { runRefsPass } from '../lib/ingest/parlamento/refs.ts'
import { runSchema } from '../lib/schema.ts'
import { closeDb } from '../lib/db.ts'

// Camera dei Deputati has been online since the 11th legislature (1992) but
// we probe from 1 so earlier legs with no data bail quickly after 40 404s.
const FIRST_LEGISLATURE = 1

interface ParsedFlags {
  chamber: Chamber | 'both'
  legislatura: number
  allLegislatures: boolean
  limit: number | undefined
  resume: boolean
  refresh: boolean
  fromNumero: number | undefined
  toNumero: number | undefined
}

function parseParlamentoArgs(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    chamber: 'both',
    legislatura: 19,
    allLegislatures: false,
    limit: undefined,
    resume: true,
    refresh: false,
    fromNumero: undefined,
    toNumero: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = argv[i + 1]
    switch (a) {
      case '--chamber': {
        const v = next
        if (v !== 'camera' && v !== 'senato' && v !== 'both') {
          throw new Error(`--chamber must be camera|senato|both, got ${v}`)
        }
        flags.chamber = v
        i += 1
        break
      }
      case '--legislatura':
        flags.legislatura = Number(next)
        i += 1
        break
      case '--all-legislatures':
        flags.allLegislatures = true
        break
      case '--limit':
        flags.limit = Number(next)
        i += 1
        break
      case '--from':
        flags.fromNumero = Number(next)
        i += 1
        break
      case '--to':
        flags.toNumero = Number(next)
        i += 1
        break
      case '--no-resume':
        flags.resume = false
        break
      case '--refresh':
        flags.refresh = true
        break
      default:
        throw new Error(`unknown flag: ${a}`)
    }
  }
  if (flags.allLegislatures && argv.includes('--legislatura')) {
    throw new Error('--all-legislatures and --legislatura are mutually exclusive')
  }
  return flags
}

type Handler = (rest: string[]) => Promise<void>

const SUBCOMMANDS: Record<string, Handler> = {
  'opere-incompiute': async () => {
    await runSchema()
    const result = await ingestOpereIncompiute()
    console.log(JSON.stringify(result, null, 2))
  },
  'spesa-pubblica': async () => {
    await runSchema()
    const result = await ingestSpesaPubblica()
    console.log(JSON.stringify(result, null, 2))
  },
  'fondi-europei': async () => {
    await runSchema()
    const result = await ingestFondiEuropei()
    console.log(JSON.stringify(result, null, 2))
  },
  appalti: async () => {
    await runSchema()
    const result = await ingestAppalti()
    console.log(JSON.stringify(result, null, 2))
  },
  parlamento: async (rest: string[]) => {
    await runSchema()
    const flags = parseParlamentoArgs(rest)
    if (flags.allLegislatures) {
      const allResults = []
      for (let leg = FIRST_LEGISLATURE; leg <= CURRENT_LEGISLATURE; leg++) {
        console.log(`\n[ingest] ======= legislatura ${leg} / ${CURRENT_LEGISLATURE} =======`)
        const results = await ingestParlamento({
          chamber: flags.chamber,
          legislatura: leg,
          limit: flags.limit,
          resume: flags.resume,
          refresh: flags.refresh,
        })
        allResults.push(...results)
      }
      console.log(JSON.stringify(allResults, null, 2))
    } else {
      const results = await ingestParlamento({
        chamber: flags.chamber,
        legislatura: flags.legislatura,
        limit: flags.limit,
        resume: flags.resume,
        refresh: flags.refresh,
        fromNumero: flags.fromNumero,
        toNumero: flags.toNumero,
      })
      console.log(JSON.stringify(results, null, 2))
    }
  },
  'parlamento-refs': async (rest: string[]) => {
    await runSchema()
    const flags = parseRefsArgs(rest)
    if (flags.allLegislatures) {
      const allResults = []
      for (let leg = FIRST_LEGISLATURE; leg <= CURRENT_LEGISLATURE; leg++) {
        console.log(`\n[refs] ======= legislatura ${leg} / ${CURRENT_LEGISLATURE} =======`)
        const result = await runRefsPass({
          chamber: flags.chamber,
          legislatura: leg,
          reparse: flags.reparse,
          reresolve: flags.reresolve,
          limit: flags.limit,
        })
        allResults.push({ legislatura: leg, ...result })
      }
      console.log(JSON.stringify(allResults, null, 2))
    } else {
      const result = await runRefsPass(flags)
      console.log(JSON.stringify(result, null, 2))
    }
  },
  'parlamento-deputati': async (rest: string[]) => {
    await runSchema()
    const flags = parseDeputatiArgs(rest)
    const result = await ingestCameraDeputati(flags)
    console.log(JSON.stringify(result, null, 2))
  },
}

interface DeputatiFlags {
  legislatura: number
  limit?: number
  refresh: boolean
}

function parseDeputatiArgs(argv: string[]): DeputatiFlags {
  const flags: DeputatiFlags = { legislatura: 19, limit: undefined, refresh: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = argv[i + 1]
    switch (a) {
      case '--legislatura': {
        const n = Number(next)
        if (!Number.isFinite(n)) throw new Error(`--legislatura must be a number, got ${next}`)
        flags.legislatura = n
        i += 1
        break
      }
      case '--limit': {
        const n = Number(next)
        if (!Number.isFinite(n)) throw new Error(`--limit must be a number, got ${next}`)
        flags.limit = n
        i += 1
        break
      }
      case '--refresh':
        flags.refresh = true
        break
      default:
        throw new Error(`unknown flag: ${a}`)
    }
  }
  return flags
}

interface RefsFlags {
  chamber: 'camera' | 'senato' | 'both'
  legislatura: number
  allLegislatures: boolean
  reparse: boolean
  reresolve: boolean
  limit?: number
}

function parseRefsArgs(argv: string[]): RefsFlags {
  const flags: RefsFlags = {
    chamber: 'both',
    legislatura: 19,
    allLegislatures: false,
    reparse: false,
    reresolve: false,
    limit: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = argv[i + 1]
    switch (a) {
      case '--chamber': {
        const v = next
        if (v !== 'camera' && v !== 'senato' && v !== 'both') {
          throw new Error(`--chamber must be camera|senato|both, got ${v}`)
        }
        flags.chamber = v
        i += 1
        break
      }
      case '--legislatura': {
        const n = Number(next)
        if (!Number.isFinite(n)) throw new Error(`--legislatura must be a number, got ${next}`)
        flags.legislatura = n
        i += 1
        break
      }
      case '--all-legislatures':
        flags.allLegislatures = true
        break
      case '--limit': {
        const n = Number(next)
        if (!Number.isFinite(n)) throw new Error(`--limit must be a number, got ${next}`)
        flags.limit = n
        i += 1
        break
      }
      case '--reparse':
        flags.reparse = true
        break
      case '--reresolve':
        flags.reresolve = true
        break
      default:
        throw new Error(`unknown flag: ${a}`)
    }
  }
  if (flags.allLegislatures && argv.includes('--legislatura')) {
    throw new Error('--all-legislatures and --legislatura are mutually exclusive')
  }
  return flags
}

async function main() {
  const [, , sub, ...rest] = process.argv
  if (!sub || !(sub in SUBCOMMANDS)) {
    console.error(`usage: ingest.ts <subcommand> [...flags]`)
    console.error(`subcommands: ${Object.keys(SUBCOMMANDS).join(', ')}`)
    console.error(`parlamento flags:`)
    console.error(`  --chamber camera|senato|both   (default both)`)
    console.error(`  --legislatura N                (default 19)`)
    console.error(`  --all-legislatures             loop legs ${FIRST_LEGISLATURE}..${CURRENT_LEGISLATURE} (mutually exclusive with --legislatura)`)
    console.error(`  --limit N                      cap body-pass count per legislature`)
    console.error(`  --from N --to N                seduta-numero range for the index probe (camera, single-leg only)`)
    console.error(`  --refresh                      re-parse sedute already marked ok`)
    console.error(`parlamento-refs flags:`)
    console.error(`  --chamber camera|senato|both   (default both)`)
    console.error(`  --legislatura N                (default 19)`)
    console.error(`  --all-legislatures             loop legs ${FIRST_LEGISLATURE}..${CURRENT_LEGISLATURE} (mutually exclusive with --legislatura)`)
    console.error(`  --limit N                      cap sedute processed per leg`)
    console.error(`  --reparse                      re-extract refs even at current parser_version`)
    console.error(`  --reresolve                    retry failed AS SPARQL lookups (commit 5)`)
    console.error(`parlamento-deputati flags:`)
    console.error(`  --legislatura N                (default 19)`)
    console.error(`  --limit N                      cap deputies attempted`)
    console.error(`  --refresh                      re-scrape rows fresher than the 7-day TTL`)
    process.exit(2)
  }
  try {
    await SUBCOMMANDS[sub](rest)
    await closeDb()
    process.exit(0)
  } catch (err) {
    // Exit 75 (EX_TEMPFAIL) on a senato WAF block so the driver can stop the
    // whole multi-leg run and resume after the ban clears, rather than
    // hammering every remaining leg against the wall.
    if (err instanceof SenatoBlockError) {
      console.error('[ingest] senato WAF BLOCK -- stopping. Resume after the ban clears.')
      await closeDb().catch(() => {})
      process.exit(75)
    }
    console.error('[ingest] failed:', err)
    await closeDb().catch(() => {})
    process.exit(1)
  }
}

void main()
