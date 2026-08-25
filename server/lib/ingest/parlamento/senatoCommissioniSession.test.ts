import { describe, expect, it } from 'vitest'

import { parseSenatoCommissioneAkn } from './senatoCommissioniSession.ts'

// Structurally faithful Akoma Ntoso, trimmed to the elements the parser reads.
// The nesting (a heading section containing sub-sections that hold the
// speeches) and the #pNNNN reference style are exactly as senato.it exports.
const AKN = `<?xml version="1.0" encoding="UTF-8"?>
<an:akomaNtoso xmlns:an="http://docs.oasis-open.org/legaldocml/ns/akn/3.0/CSD03">
  <an:debate contains="originalVersion">
    <an:meta>
      <an:references>
        <an:TLCPerson id="p29110" href="http://dati.senato.it/osr/Persona/29110" showAs="GRASSO"/>
        <an:TLCPerson id="p1103" href="http://dati.senato.it/osr/Persona/1103" showAs="GASPARRI"/>
        <an:TLCRole id="senatore" href="http://dati.senato.it/osr/Senatore" showAs="senatore"/>
      </an:references>
    </an:meta>
    <an:debateBody>
      <an:debateSection id="d1" name="InizioSeduta">
        <an:narrative title="InizioSeduta">
          <an:recordedTime time="14:05:00"/>
          <an:i> La seduta inizia alle ore 14,05.</an:i>
        </an:narrative>
      </an:debateSection>
      <an:debateSection id="d2" name="IMMUNITA' PARLAMENTARI">
        <an:heading>IMMUNITA' PARLAMENTARI</an:heading>
        <an:debateSection id="d3" name="Richiesta di deliberazione">
          <an:heading>Richiesta di deliberazione</an:heading>
          <an:speech by="#p29110" as="#senatore">
            <an:from refersTo="#p29110"/>
            <an:p> Pone domande all'audito il senatore <an:ref id="r1" href="#p29110">GRASSO</an:ref> (<an:i>Misto-LeU-Eco</an:i>), al quale risponde il professor CLINI.</an:p>
            <an:p> Congedato il professor Clini, il seguito e' rinviato.</an:p>
          </an:speech>
          <an:speech by="#p1103" as="#senatore">
            <an:from refersTo="#p1103"/>
            <an:p> Il Presidente relatore <an:ref id="r2" href="#p1103">GASPARRI</an:ref> illustra la propria proposta, citando la <an:i>relazione</an:i> allegata.</an:p>
          </an:speech>
        </an:debateSection>
      </an:debateSection>
      <an:debateSection id="d9" name="FineSeduta">
        <an:narrative title="FineSeduta"><an:i> La seduta termina alle ore 15.</an:i></an:narrative>
      </an:debateSection>
    </an:debateBody>
  </an:debate>
</an:akomaNtoso>`

describe('parseSenatoCommissioneAkn', () => {
  const r = parseSenatoCommissioneAkn(AKN)

  it('makes an agenda item of every section that has a heading', () => {
    expect(r.odg.map((o) => o.titolo)).toEqual([
      "IMMUNITA' PARLAMENTARI",
      'Richiesta di deliberazione',
    ])
  })

  it('does not promote the opening and closing bell into agenda items', () => {
    // InizioSeduta / FineSeduta carry a `name` but no heading. Falling back to
    // the name attribute would put "InizioSeduta" in the reader's agenda.
    expect(r.odg.some((o) => /Seduta$/.test(o.titolo))).toBe(false)
  })

  it('attributes a speech to its innermost agenda item', () => {
    expect(r.interventi.map((i) => i.odgPosition)).toEqual([2, 2])
  })

  it('resolves the speaker to the numeric senator id from the TLCPerson table', () => {
    expect(r.interventi[0]).toMatchObject({ oratoreNome: 'GRASSO', idPersona: '29110' })
  })

  it('reads the parliamentary group from the italics following the speaker reference', () => {
    expect(r.interventi[0].gruppo).toBe('Misto-LeU-Eco')
  })

  it('does not mistake ordinary italics for a group', () => {
    // "<an:i>relazione</an:i>" follows the speaker's own ref but with real
    // prose in between, so it is emphasis, not a group.
    expect(r.interventi[1].gruppo).toBeNull()
  })

  it('keeps each an:p as its own paragraph', () => {
    expect(r.interventi[0].paragraphs).toHaveLength(2)
    expect(r.interventi[0].paragraphs[1]).toContain('Congedato il professor Clini')
  })

  it('flattens inline markup into the paragraph text', () => {
    expect(r.interventi[0].paragraphs[0]).toBe(
      "Pone domande all'audito il senatore GRASSO (Misto-LeU-Eco), al quale risponde il professor CLINI.",
    )
  })

  it('visits nested sections exactly once', () => {
    // visitSection recurses, so seeding it from a descending search would
    // duplicate every speech in a nested section.
    expect(r.interventi).toHaveLength(2)
  })
})
