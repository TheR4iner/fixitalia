import { describe, expect, it } from 'vitest'
import { parseRefs } from './index.ts'
import type { Ref, RefContext } from './types.ts'

const CAMERA: RefContext = { chamber: 'camera', legislatura: 19 }
const SENATO: RefContext = { chamber: 'senato', legislatura: 19 }

// Helper that asserts a single match with the expected core fields.
// Keeps each fixture line readable by collapsing the noise around
// what each test actually cares about (tipo / numero / anno / url).
function expectOne(testo: string, ctx: RefContext, expected: Partial<Ref> & { raw: string }): Ref {
  const refs = parseRefs(testo, ctx)
  expect(refs, `expected exactly one ref in: ${testo}`).toHaveLength(1)
  const r = refs[0]!
  expect(r.tipo).toBe(expected.tipo)
  expect(r.raw).toBe(expected.raw)
  if (expected.numero !== undefined) expect(r.numero).toBe(expected.numero)
  if (expected.anno !== undefined) expect(r.anno).toBe(expected.anno)
  if (expected.articolo !== undefined) expect(r.articolo).toBe(expected.articolo)
  if (expected.urn !== undefined) expect(r.urn).toBe(expected.urn)
  if (expected.url !== undefined) expect(r.url).toBe(expected.url)
  expect(testo.slice(r.start, r.end_offset)).toBe(expected.raw)
  return r
}

describe('parseRefs - leggi (laws)', () => {
  it('matches "legge n. 205 del 2017"', () => {
    expectOne('ai sensi della legge n. 205 del 2017 si dispone', CAMERA, {
      tipo: 'legge',
      raw: 'legge n. 205 del 2017',
      numero: '205',
      anno: 2017,
      urn: 'urn:nir:stato:legge:2017;205',
      url: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2017;205',
    })
  })

  it('matches the date form "legge 27 dicembre 2017, n. 205"', () => {
    expectOne('la legge 27 dicembre 2017, n. 205 prevede', CAMERA, {
      tipo: 'legge',
      raw: 'legge 27 dicembre 2017, n. 205',
      numero: '205',
      anno: 2017,
      urn: 'urn:nir:stato:legge:2017-12-27;205',
    })
  })

  it('matches the date form without comma', () => {
    expectOne('la legge 27 dicembre 2017 n. 205 prevede', CAMERA, {
      tipo: 'legge',
      raw: 'legge 27 dicembre 2017 n. 205',
      numero: '205',
      anno: 2017,
      urn: 'urn:nir:stato:legge:2017-12-27;205',
    })
  })

  it('matches the slash form "legge 205/2017"', () => {
    expectOne('la legge 205/2017 stabilisce', CAMERA, {
      tipo: 'legge',
      raw: 'legge 205/2017',
      numero: '205',
      anno: 2017,
    })
  })

  it('matches "L. 205/2017" (case-sensitive short form)', () => {
    expectOne('vedi L. 205/2017 sul punto', CAMERA, {
      tipo: 'legge',
      raw: 'L. 205/2017',
      numero: '205',
      anno: 2017,
    })
  })

  it('matches plural "leggi 205 del 2017"', () => {
    expectOne('le leggi 205 del 2017 sono superate', CAMERA, {
      tipo: 'legge',
      raw: 'leggi 205 del 2017',
      numero: '205',
      anno: 2017,
    })
  })

  it('matches capitalised "Legge n. 205 del 2017"', () => {
    expectOne('Legge n. 205 del 2017 prevede', CAMERA, {
      tipo: 'legge',
      raw: 'Legge n. 205 del 2017',
      numero: '205',
      anno: 2017,
    })
  })
})

describe('parseRefs - decreto-legge', () => {
  it('matches "decreto-legge 19 maggio 2020, n. 34"', () => {
    expectOne('il decreto-legge 19 maggio 2020, n. 34 ha disposto', CAMERA, {
      tipo: 'decreto.legge',
      raw: 'decreto-legge 19 maggio 2020, n. 34',
      numero: '34',
      anno: 2020,
      urn: 'urn:nir:stato:decreto.legge:2020-05-19;34',
    })
  })

  it('matches "decreto legge" with single space (no hyphen)', () => {
    expectOne('il decreto legge 34/2020 ha disposto', CAMERA, {
      tipo: 'decreto.legge',
      raw: 'decreto legge 34/2020',
      numero: '34',
      anno: 2020,
    })
  })

  it('matches "D.L. 34/2020"', () => {
    expectOne('vedi il D.L. 34/2020', CAMERA, {
      tipo: 'decreto.legge',
      raw: 'D.L. 34/2020',
      numero: '34',
      anno: 2020,
    })
  })

  it('matches "DL 34/2020" without periods', () => {
    expectOne('il DL 34/2020 ha disposto', CAMERA, {
      tipo: 'decreto.legge',
      raw: 'DL 34/2020',
      numero: '34',
      anno: 2020,
    })
  })

  it('does not let bare "legge" match inside "decreto-legge"', () => {
    const refs = parseRefs('il decreto-legge n. 34 del 2020 prevede', CAMERA)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.tipo).toBe('decreto.legge')
  })
})

describe('parseRefs - decreto legislativo', () => {
  it('matches "decreto legislativo n. 165 del 2001"', () => {
    expectOne('il decreto legislativo n. 165 del 2001 dispone', CAMERA, {
      tipo: 'decreto.legislativo',
      raw: 'decreto legislativo n. 165 del 2001',
      numero: '165',
      anno: 2001,
      urn: 'urn:nir:stato:decreto.legislativo:2001;165',
    })
  })

  it('matches "D.Lgs. 165/2001"', () => {
    expectOne('vedi il D.Lgs. 165/2001', CAMERA, {
      tipo: 'decreto.legislativo',
      raw: 'D.Lgs. 165/2001',
      numero: '165',
      anno: 2001,
    })
  })

  it('matches "Dlgs n. 165 del 2001" no periods', () => {
    expectOne('il Dlgs n. 165 del 2001 stabilisce', CAMERA, {
      tipo: 'decreto.legislativo',
      raw: 'Dlgs n. 165 del 2001',
      numero: '165',
      anno: 2001,
    })
  })

  it('does not confuse D.Lgs. with D.L.', () => {
    const refs = parseRefs('il D.Lgs. 165/2001 e il D.L. 34/2020 ', CAMERA)
    expect(refs).toHaveLength(2)
    const tipi = refs.map((r) => r.tipo).sort()
    expect(tipi).toEqual(['decreto.legge', 'decreto.legislativo'])
  })
})

describe('parseRefs - DPR', () => {
  it('matches "D.P.R. 380/2001"', () => {
    expectOne('il D.P.R. 380/2001 disciplina', CAMERA, {
      tipo: 'dpr',
      raw: 'D.P.R. 380/2001',
      numero: '380',
      anno: 2001,
      urn: 'urn:nir:stato:decreto.presidente.repubblica:2001;380',
    })
  })

  it('matches "DPR 380/2001" without periods', () => {
    expectOne('il DPR 380/2001 disciplina', CAMERA, {
      tipo: 'dpr',
      raw: 'DPR 380/2001',
      numero: '380',
      anno: 2001,
    })
  })

  it('matches the long form "decreto del Presidente della Repubblica n. 380 del 2001"', () => {
    expectOne(
      'il decreto del Presidente della Repubblica n. 380 del 2001 disciplina',
      CAMERA,
      {
        tipo: 'dpr',
        raw: 'decreto del Presidente della Repubblica n. 380 del 2001',
        numero: '380',
        anno: 2001,
      },
    )
  })
})

describe('parseRefs - Costituzione', () => {
  it('matches "articolo 138 della Costituzione"', () => {
    expectOne("ai sensi dell'articolo 138 della Costituzione si modifica", CAMERA, {
      tipo: 'costituzione',
      raw: 'articolo 138 della Costituzione',
      articolo: 138,
      urn: 'urn:nir:stato:costituzione:1947-12-27~art138',
      url: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:costituzione:1947-12-27~art138',
    })
  })

  it('matches "art. 81 Cost."', () => {
    expectOne("come previsto dall'art. 81 Cost.", CAMERA, {
      tipo: 'costituzione',
      raw: 'art. 81 Cost.',
      articolo: 81,
    })
  })

  it('matches "art. 138, comma 2 della Costituzione" (comma is part of raw)', () => {
    const refs = parseRefs("ai sensi dell'art. 138, comma 2 della Costituzione", CAMERA)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.tipo).toBe('costituzione')
    expect(refs[0]!.articolo).toBe(138)
  })

  it('skips bare "Costituzione" with no article', () => {
    const refs = parseRefs('come prevede la Costituzione italiana', CAMERA)
    expect(refs).toHaveLength(0)
  })
})

describe('parseRefs - atto Camera (AC)', () => {
  it('matches "atto Camera n. 1234"', () => {
    expectOne("dell'atto Camera n. 1234 si discute", CAMERA, {
      tipo: 'ac',
      raw: 'atto Camera n. 1234',
      numero: '1234',
      url: 'https://www.camera.it/leg19/126?leg=19&idDocumento=1234',
    })
  })

  it('matches "A.C. 1234"', () => {
    expectOne('vedi A.C. 1234 in calendario', CAMERA, {
      tipo: 'ac',
      raw: 'A.C. 1234',
      numero: '1234',
    })
  })

  it('matches uppercase "AC 1234"', () => {
    expectOne('discussione su AC 1234 in aula', CAMERA, {
      tipo: 'ac',
      raw: 'AC 1234',
      numero: '1234',
    })
  })

  it('matches "proposta di legge C. 1234"', () => {
    expectOne('la proposta di legge C. 1234 e abbinati', CAMERA, {
      tipo: 'ac',
      raw: 'proposta di legge C. 1234',
      numero: '1234',
    })
  })

  it('respects the seduta legislatura when building Camera URL', () => {
    const r = parseRefs('A.C. 1234', { chamber: 'camera', legislatura: 18 })[0]!
    expect(r.url).toBe('https://www.camera.it/leg18/126?leg=18&idDocumento=1234')
  })

  it('does not match "AC Milan" (no number)', () => {
    expect(parseRefs('AC Milan ha vinto', CAMERA)).toHaveLength(0)
  })
})

describe('parseRefs - atto Senato (AS)', () => {
  it('matches "atto Senato n. 1236" with null url (deferred resolution)', () => {
    expectOne("dell'atto Senato n. 1236 si discute", SENATO, {
      tipo: 'as',
      raw: 'atto Senato n. 1236',
      numero: '1236',
      url: null,
    })
  })

  it('matches "A.S. 1236"', () => {
    expectOne('vedi A.S. 1236 in calendario', SENATO, {
      tipo: 'as',
      raw: 'A.S. 1236',
      numero: '1236',
    })
  })

  it('matches uppercase "AS 1236"', () => {
    expectOne('discussione su AS 1236 in aula', SENATO, {
      tipo: 'as',
      raw: 'AS 1236',
      numero: '1236',
    })
  })

  it('matches "disegno di legge S. 1236"', () => {
    expectOne('il disegno di legge S. 1236 e abbinati', SENATO, {
      tipo: 'as',
      raw: 'disegno di legge S. 1236',
      numero: '1236',
    })
  })
})

describe('parseRefs - chamber-name forms (no AC/AS abbreviation)', () => {
  it('"proposta di legge n. 1311" resolves to AC regardless of chamber', () => {
    expectOne('discussione della proposta di legge n. 1311 in aula', CAMERA, {
      tipo: 'ac',
      raw: 'proposta di legge n. 1311',
      numero: '1311',
    })
    // Senato never originates a "proposta di legge", but if a Senato
    // transcript somehow mentions one, it still resolves to AC.
    const r = parseRefs('discussione della proposta di legge n. 1311 in aula', SENATO)[0]!
    expect(r.tipo).toBe('ac')
  })

  it('"disegno di legge n. 1946" in a Camera transcript resolves to AC', () => {
    expectOne(
      'esame del disegno di legge n. 1946- Conversione in legge del decreto-legge',
      CAMERA,
      {
        tipo: 'ac',
        raw: 'disegno di legge n. 1946',
        numero: '1946',
        url: 'https://www.camera.it/leg19/126?leg=19&idDocumento=1946',
      },
    )
  })

  it('"disegno di legge n. 1946" in a Senato transcript resolves to AS', () => {
    const r = parseRefs('esame del disegno di legge n. 1946 di conversione', SENATO)[0]!
    expect(r.tipo).toBe('as')
    expect(r.numero).toBe('1946')
    expect(r.url).toBeNull() // AS resolution is deferred
  })

  it('captures both "disegno di legge n. 1946" and "decreto-legge 15 maggio 2024, n. 63"', () => {
    const refs = parseRefs(
      'esame del disegno di legge n. 1946- Conversione in legge del decreto-legge 15 maggio 2024, n. 63 recante',
      CAMERA,
    )
    expect(refs).toHaveLength(2)
    const tipi = refs.map((r) => r.tipo).sort()
    expect(tipi).toEqual(['ac', 'decreto.legge'])
  })
})

describe('parseRefs - tripwires (must NOT match)', () => {
  it('does not match a bare year', () => {
    expect(parseRefs('il bilancio del 2017 prevede', CAMERA)).toHaveLength(0)
  })

  it('does not match "legge sulla scuola" (no number)', () => {
    expect(parseRefs('una legge sulla scuola servirebbe', CAMERA)).toHaveLength(0)
  })

  it('does not match an article of a non-Costituzione document', () => {
    expect(parseRefs('art. 5 del nostro regolamento prevede', CAMERA)).toHaveLength(0)
  })

  it('does not match "n. 205" without a tipo marker', () => {
    expect(parseRefs('n. 205 dei votanti hanno scelto', CAMERA)).toHaveLength(0)
  })

  it('does not match D.Lgs. without a number', () => {
    expect(parseRefs('il D.Lgs. da rinnovare', CAMERA)).toHaveLength(0)
  })

  it('does not match "S. Maria" (S. without bill context, no number)', () => {
    expect(parseRefs('la chiesa di S. Maria del Fiore', CAMERA)).toHaveLength(0)
  })

  it('does not match "ac" lowercase inside ordinary words', () => {
    expect(parseRefs('iliac arteries are a thing 1234 km long', CAMERA)).toHaveLength(0)
  })
})

describe('parseRefs - multiple references in one paragraph', () => {
  it('captures two laws separated by "e"', () => {
    const refs = parseRefs('le leggi 205 del 2017 e 232 del 2016 sono superate', CAMERA)
    // Note: only the leftmost "leggi 205 del 2017" carries the tipo
    // marker, so the trailing "232 del 2016" is unmatched -- pattern
    // bank does not infer from context. This is intentional.
    expect(refs).toHaveLength(1)
    expect(refs[0]!.numero).toBe('205')
  })

  it('captures decreto-legge and a separate legge in the same sentence', () => {
    const refs = parseRefs('il D.L. 34/2020 modifica la legge n. 5 del 2019', CAMERA)
    expect(refs).toHaveLength(2)
    const sorted = [...refs].sort((a, b) => a.start - b.start)
    expect(sorted[0]!.tipo).toBe('decreto.legge')
    expect(sorted[0]!.numero).toBe('34')
    expect(sorted[1]!.tipo).toBe('legge')
    expect(sorted[1]!.numero).toBe('5')
  })

  it('returns refs in document order', () => {
    const refs = parseRefs('art. 41 Cost. e poi art. 81 Cost. ancora', CAMERA)
    expect(refs.map((r) => r.articolo)).toEqual([41, 81])
  })
})

describe('parseRefs - offsets', () => {
  it('produces start/end_offset that slice back to the raw match', () => {
    const testo = 'prima il D.L. 34/2020 e poi'
    const refs = parseRefs(testo, CAMERA)
    expect(refs).toHaveLength(1)
    const r = refs[0]!
    expect(testo.slice(r.start, r.end_offset)).toBe('D.L. 34/2020')
  })
})
