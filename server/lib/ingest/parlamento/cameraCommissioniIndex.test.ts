import { describe, expect, it } from 'vitest'

import {
  cameraCommissioneHtmlUrl,
  cameraCommissioneScope,
  parseCameraCommissioniListing,
} from './cameraCommissioniIndex.ts'

// A trimmed but structurally faithful slice of a monthly listing page. The
// nesting (sede -> commissioni -> sedute -> stenograficoList) and the
// parameterised anchor are exactly as upstream renders them, including the
// HTML-escaped ampersands.
const LISTING = `
<div id="sedi">
  <div id="sede.indag">
    <ul class="commissioni">
      <li class="commissione">
        <strong>Affari esteri e comunitari (III)</strong>
        <ul class="sedute">
          <li>
            <span class="dataSeduta">giovedì 27 giugno 2024</span>
            <ul class="titoliResocontoStenografico">
              <li class="titoloResocontoStenografico">Audizione, in videoconferenza, di Marco Mascia.</li>
            </ul>
            <ul class="stenograficoList">
              <li>
                <span class="testo">Resoconto stenografico num. 16<span class="tipoSeduta"> - seduta pomeridiana</span></span>
                <a href="//documenti.camera.it/apps/commonServices/getDocumento.ashx?idLegislatura=19&amp;sezione=commissioni&amp;tipoDoc=stenografico&amp;tipologia=indag&amp;sottotipologia=c03_discriminazioni&amp;anno=2024&amp;mese=06&amp;giorno=27&amp;view=filtered&amp;idCommissione=03&amp;numero=0016" class="link_html">HTML</a>
              </li>
            </ul>
          </li>
        </ul>
      </li>
    </ul>
  </div>
  <div id="sede.altro">
    <ul class="commissioni">
      <li class="commissione">
        <strong>Commissione parlamentare di inchiesta (XX)</strong>
        <ul class="sedute">
          <li>
            <span class="dataSeduta">martedì 11 giugno 2024</span>
            <ul class="stenograficoList">
              <li>
                <span class="testo">Resoconto stenografico num. 4</span>
                <a href="//documenti.camera.it/apps/commonServices/getDocumento.ashx?idLegislatura=19&amp;sezione=commissioni&amp;tipoDoc=stenografico&amp;tipologia=altro&amp;anno=2024&amp;mese=06&amp;giorno=11&amp;view=filtered&amp;idCommissione=79&amp;numero=0004" class="link_html">HTML</a>
              </li>
            </ul>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</div>`

describe('parseCameraCommissioniListing', () => {
  const entries = parseCameraCommissioniListing(19, LISTING)

  it('finds every sitting across sede blocks', () => {
    expect(entries).toHaveLength(2)
  })

  it('carries the committee name, title and sitting kind', () => {
    expect(entries[0]).toMatchObject({
      idCommissione: '03',
      commissioneNome: 'Affari esteri e comunitari (III)',
      tipologia: 'indag',
      sottotipologia: 'c03_discriminazioni',
      numero: 16,
      titolo: 'Audizione, in videoconferenza, di Marco Mascia.',
      tipoSeduta: 'seduta pomeridiana',
    })
    expect(entries[0].data.toISOString()).toBe('2024-06-27T00:00:00.000Z')
  })

  it('reports no sottotipologia for tipologia=altro', () => {
    expect(entries[1].sottotipologia).toBeNull()
  })
})

describe('cameraCommissioneHtmlUrl', () => {
  const base = 'https://documenti.camera.it/leg19/resoconti/commissioni/stenografici/html'

  it('includes the sottotipologia segment when there is one', () => {
    expect(
      cameraCommissioneHtmlUrl(19, {
        idCommissione: '03',
        tipologia: 'indag',
        sottotipologia: 'c03_commercio',
        data: new Date('2024-06-25T00:00:00Z'),
        numero: 6,
      }),
    ).toBe(`${base}/03/indag/c03_commercio/2024/06/25/stenografico.0006.html`)
  })

  it('omits the segment entirely when there is none', () => {
    // The single irregularity in an otherwise deterministic scheme; emitting
    // an empty path segment produces a 404.
    expect(
      cameraCommissioneHtmlUrl(19, {
        idCommissione: '79',
        tipologia: 'altro',
        sottotipologia: null,
        data: new Date('2024-06-11T00:00:00Z'),
        numero: 4,
      }),
    ).toBe(`${base}/79/altro/2024/06/11/stenografico.0004.html`)
  })

  it('zero-pads the resoconto number to four digits', () => {
    const url = cameraCommissioneHtmlUrl(19, {
      idCommissione: '03',
      tipologia: 'altro',
      sottotipologia: null,
      data: new Date('2024-01-02T00:00:00Z'),
      numero: 7,
    })
    expect(url.endsWith('stenografico.0007.html')).toBe(true)
  })
})

describe('cameraCommissioneScope', () => {
  it('separates two inquiries of the same committee with different numbering', () => {
    // Committee 03 ran indag/c03_commercio num. 6 and
    // indag/c03_discriminazioni num. 16 in the same month, so a scope keyed
    // on committee+numero alone would collide across inquiries.
    const a = cameraCommissioneScope(19, {
      idCommissione: '03',
      tipologia: 'indag',
      sottotipologia: 'c03_commercio',
      numero: 6,
    })
    const b = cameraCommissioneScope(19, {
      idCommissione: '03',
      tipologia: 'indag',
      sottotipologia: 'c03_discriminazioni',
      numero: 6,
    })
    expect(a).not.toBe(b)
  })

  it('separates the same numero across legislatures', () => {
    const shape = {
      idCommissione: '03',
      tipologia: 'altro',
      sottotipologia: null,
      numero: 1,
    }
    expect(cameraCommissioneScope(18, shape)).not.toBe(cameraCommissioneScope(19, shape))
  })

  it('produces a record-id-safe token', () => {
    const scope = cameraCommissioneScope(19, {
      idCommissione: '03',
      tipologia: 'indag',
      sottotipologia: 'c03_commercio',
      numero: 6,
    })
    expect(scope).toMatch(/^[a-z0-9-]+$/)
  })
})
