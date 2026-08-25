import { describe, expect, it } from 'vitest'

import {
  parseCameraCommissioneTranscript,
  splitAttribution,
} from './cameraCommissioniSession.ts'

// Fixtures are hand-written rather than captured wholesale from upstream so
// each one isolates a single real behaviour of the source markup. Every shape
// below was observed in a live leg-19 committee transcript.
function doc(body: string): string {
  return `<html><body><div id="wrapper"><div id="stenograficoCommissione">${body}</div></div></body></html>`
}

const DEPUTY_LINK =
  '<a title="Vai alla scheda personale: BATTILOCCHIO Alessandro" ' +
  'href="//documenti.camera.it/apps/commonServices/getDocumento.ashx?idLegislatura=19&amp;sezione=deputati&amp;tipoDoc=schedaDeputato&amp;idPersona=307456">PRESIDENTE</a>'

describe('splitAttribution', () => {
  it('treats a leading period as "no role"', () => {
    expect(splitAttribution('. Avverto che la seduta comincia.')).toEqual({
      ruolo: null,
      body: 'Avverto che la seduta comincia.',
    })
  })

  it('reads a comma-delimited qualification as the role', () => {
    expect(splitAttribution(', Consulente della Commissione. Grazie, presidente.')).toEqual({
      ruolo: 'Consulente della Commissione',
      body: 'Grazie, presidente.',
    })
  })

  it('keeps a qualification that contains parentheses intact', () => {
    // The source splits this across several <em> runs, so element-based
    // detection captures only "...italo-germanica (" and strands the rest.
    expect(
      splitAttribution(
        ', rappresentante della Camera di commercio italo-germanica (AHK Italien). Ringrazio la Commissione.',
      ),
    ).toEqual({
      ruolo: 'rappresentante della Camera di commercio italo-germanica (AHK Italien)',
      body: 'Ringrazio la Commissione.',
    })
  })

  it('refuses an implausibly long "role" and keeps the text as body', () => {
    const long = ', ' + 'x'.repeat(200) + '. tail'
    const out = splitAttribution(long)
    expect(out.ruolo).toBeNull()
    expect(out.body.startsWith('x')).toBe(true)
  })
})

describe('parseCameraCommissioneTranscript', () => {
  it('splits a multi-paragraph speech on <br>', () => {
    // In committee the WHOLE speech is one <p class="intervento"> with <br>
    // separators, unlike the assembly format where each paragraph is its own
    // sibling <p class="interventoVirtuale">.
    const r = parseCameraCommissioneTranscript(
      doc(
        '<p class="titolo"><strong>Audizione.</strong></p>' +
          `<p class="intervento">${DEPUTY_LINK}. Primo capoverso.` +
          '<br />Secondo capoverso.<br />Terzo capoverso.</p>',
      ),
    )
    expect(r.interventi).toHaveLength(1)
    expect(r.interventi[0].paragraphs).toEqual([
      'Primo capoverso.',
      'Secondo capoverso.',
      'Terzo capoverso.',
    ])
  })

  it('keeps speakers who are not parliamentarians', () => {
    // Auditees and consultants appear as a bare <a> with NO href, because
    // they have no deputy profile. A selector requiring idPersona drops
    // exactly the people an audizione exists to hear.
    const r = parseCameraCommissioneTranscript(
      doc(
        '<p class="titolo"><strong>Audizione.</strong></p>' +
          '<p class="intervento" title="Consulente della Commissione">' +
          '<a>MARCO ACCORINTI</a>, <em>Consulente della Commissione</em>. Grazie, presidente.</p>',
      ),
    )
    expect(r.interventi).toHaveLength(1)
    expect(r.interventi[0]).toMatchObject({
      oratoreNome: 'MARCO ACCORINTI',
      idPersona: null,
      ruolo: 'Consulente della Commissione',
    })
    expect(r.interventi[0].paragraphs).toEqual(['Grazie, presidente.'])
  })

  it('prefers the scheda title over the link text for a deputy name', () => {
    // The visible link text is usually the role ("PRESIDENTE"); the title
    // attribute is the only place the human is actually named.
    const r = parseCameraCommissioneTranscript(
      doc(`<p class="intervento">${DEPUTY_LINK}. Testo.</p>`),
    )
    expect(r.interventi[0]).toMatchObject({
      oratoreNome: 'BATTILOCCHIO Alessandro',
      idPersona: '307456',
    })
  })

  it('strips inline page markers out of the middle of a sentence', () => {
    const r = parseCameraCommissioneTranscript(
      doc(
        `<p class="intervento">${DEPUTY_LINK}. Prima parte` +
          '<span class="numeroPagina" id="x"><span>Pag. 4</span></span>' +
          ' e seconda parte.</p>',
      ),
    )
    expect(r.interventi[0].paragraphs[0]).toBe('Prima parte e seconda parte.')
  })

  it('does not mistake ordinary emphasis inside the speech for a role', () => {
    // <em>web-tv</em> is the first <em> in the paragraph and its
    // previousElementSibling IS the speaker anchor (only text sits between),
    // so element-adjacency detection reads it as the speaker's role.
    const r = parseCameraCommissioneTranscript(
      doc(
        `<p class="intervento">${DEPUTY_LINK}. La trasmissione attraverso la ` +
          '<em>web-tv</em> della Camera.</p>',
      ),
    )
    expect(r.interventi[0].ruolo).toBeNull()
    expect(r.interventi[0].paragraphs[0]).toContain('web-tv')
  })

  it('opens a new agenda item on each titolo and links speeches to it', () => {
    const r = parseCameraCommissioneTranscript(
      doc(
        '<p class="titolo"><strong>Sulla pubblicità dei lavori.</strong></p>' +
          `<p class="intervento">${DEPUTY_LINK}. Uno.</p>` +
          '<p class="titolo"><strong>Audizione di rappresentanti.</strong></p>' +
          `<p class="intervento">${DEPUTY_LINK}. Due.</p>`,
      ),
    )
    expect(r.odg.map((o) => o.titolo)).toEqual([
      'Sulla pubblicità dei lavori.',
      'Audizione di rappresentanti.',
    ])
    expect(r.interventi.map((i) => i.odgPosition)).toEqual([1, 2])
  })

  it('attaches presidenza and avviso lines to the preceding speech', () => {
    const r = parseCameraCommissioneTranscript(
      doc(
        `<p class="intervento">${DEPUTY_LINK}. Testo.</p>` +
          '<p class="avviso"><strong>La seduta termina alle 14.</strong></p>',
      ),
    )
    expect(r.interventi[0].paragraphs).toEqual(['Testo.', 'La seduta termina alle 14.'])
  })

  it('drops leading context that precedes the first speech', () => {
    const r = parseCameraCommissioneTranscript(
      doc('<p class="presidenza">PRESIDENZA DEL PRESIDENTE</p>'),
    )
    expect(r.interventi).toHaveLength(0)
  })
})
