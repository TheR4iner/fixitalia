import { describe, it, expect } from 'vitest'

import type { RosterDeputy } from './cameraHistoricalDeputatoSparql.ts'
import {
  nameTokens,
  buildRosterIndex,
  matchSpeaker,
  canonicalName,
} from './historicalSpeakerLink.ts'

function dep(idPersona: number, firstName: string, surname: string, gruppo: string | null = null): RosterDeputy {
  return { idPersona, firstName, surname, gruppo }
}

describe('nameTokens', () => {
  it('is order-independent and sorted', () => {
    expect(nameTokens('PAOLO GENTILONI SILVERI')).toEqual(['GENTILONI', 'PAOLO', 'SILVERI'])
    expect(nameTokens('GENTILONI SILVERI PAOLO')).toEqual(['GENTILONI', 'PAOLO', 'SILVERI'])
  })

  it('strips diacritics and apostrophes', () => {
    expect(nameTokens('IVO COLLÈ')).toEqual(['COLLE', 'IVO'])
    expect(nameTokens("LUIGI D'AGRÒ")).toEqual(['DAGRO', 'LUIGI'])
    expect(nameTokens('GIANFRANCO MICCICHÈ')).toEqual(['GIANFRANCO', 'MICCICHE'])
  })

  it('drops a single leading role token', () => {
    expect(nameTokens('PRESIDENTE ROSSI MARIO')).toEqual(['MARIO', 'ROSSI'])
    expect(nameTokens('MINISTRO BONINO EMMA')).toEqual(['BONINO', 'EMMA'])
  })

  it('keeps a bare role word as a lone token', () => {
    expect(nameTokens('PRESIDENTE')).toEqual(['PRESIDENTE'])
  })
})

describe('matchSpeaker', () => {
  const roster = [
    dep(1, 'PAOLO', 'GENTILONI SILVERI'),
    dep(2, 'MARIA TERESA', 'ARMOSINO'),
    dep(3, 'SANDRO', 'DELMASTRO DELLE VEDOVE'),
    dep(4, 'GIOVANNA', 'BIANCHI CLERICI'),
    dep(5, 'GIANFRANCO', "MICCICHE'"),
    dep(6, 'CARLO AMEDEO', 'GIOVANARDI'), // official has a middle name
    dep(7, 'IGNAZIO BENITO', 'LA RUSSA'),
  ]
  const index = buildRosterIndex(roster)

  it('matches a multi-token firstname/surname regardless of accents (exact tier)', () => {
    expect(matchSpeaker('PAOLO GENTILONI SILVERI', index)).toMatchObject({
      kind: 'matched',
      deputy: { idPersona: 1 },
      tier: 'exact',
    })
    expect(matchSpeaker('MARIA TERESA ARMOSINO', index)).toMatchObject({ kind: 'matched', deputy: { idPersona: 2 } })
    expect(matchSpeaker('GIANFRANCO MICCICHÈ', index)).toMatchObject({ kind: 'matched', deputy: { idPersona: 5 } })
  })

  it('matches the everyday name when the roster carries a middle name (relaxed tier)', () => {
    expect(matchSpeaker('CARLO GIOVANARDI', index)).toMatchObject({
      kind: 'matched',
      deputy: { idPersona: 6 },
      tier: 'relaxed',
    })
    expect(matchSpeaker('IGNAZIO LA RUSSA', index)).toMatchObject({
      kind: 'matched',
      deputy: { idPersona: 7 },
      tier: 'relaxed',
    })
    // Full official form still works via exact.
    expect(matchSpeaker('CARLO AMEDEO GIOVANARDI', index)).toMatchObject({ kind: 'matched', tier: 'exact' })
  })

  it('does not invent a match from a foreign given name', () => {
    // Same surname, wrong first name -> must not link to Giovanardi.
    expect(matchSpeaker('MARIO GIOVANARDI', index).kind).toBe('unmatched')
  })

  it('classifies bare roles and unknowns without guessing', () => {
    expect(matchSpeaker('PRESIDENTE', index).kind).toBe('role')
    expect(matchSpeaker('CHI SA CHI', index).kind).toBe('unmatched')
    expect(matchSpeaker('', index).kind).toBe('unmatched')
  })

  it('leaves true homonyms ambiguous rather than mislinking', () => {
    const homonyms = buildRosterIndex([dep(10, 'MARIO', 'ROSSI'), dep(11, 'MARIO', 'ROSSI')])
    const r = matchSpeaker('MARIO ROSSI', homonyms)
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.candidates).toHaveLength(2)
  })

  it('leaves a relaxed homonym ambiguous (two middle-name variants)', () => {
    const homonyms = buildRosterIndex([
      dep(20, 'MARIO LUIGI', 'ROSSI'),
      dep(21, 'MARIO PAOLO', 'ROSSI'),
    ])
    expect(matchSpeaker('MARIO ROSSI', homonyms).kind).toBe('ambiguous')
  })
})

describe('canonicalName', () => {
  it('renders SURNAME Firstname with title-cased given names', () => {
    expect(canonicalName(dep(1, 'PAOLO', 'GENTILONI SILVERI'))).toBe('GENTILONI SILVERI Paolo')
    expect(canonicalName(dep(2, 'MARIA TERESA', 'ARMOSINO'))).toBe('ARMOSINO Maria Teresa')
  })
})
