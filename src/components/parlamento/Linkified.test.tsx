import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { Linkified } from './Linkified'
import type { Riferimento } from '@/services/parlamento'

function ref(partial: Partial<Riferimento>): Riferimento {
  return {
    tipo: 'legge',
    anno: null,
    numero: null,
    articolo: null,
    urn: null,
    url: null,
    resolve_status: 'ok',
    start: 0,
    end_offset: 0,
    raw: '',
    ...partial,
  }
}

describe('Linkified', () => {
  it('renders plain text when no refs', () => {
    render(<Linkified text="solo testo, niente riferimenti." refs={[]} />)
    expect(screen.getByText(/solo testo/)).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders an anchor for a ref with a url', () => {
    const text = 'la legge n. 205 del 2017 prevede modifiche'
    const refs = [
      ref({
        tipo: 'legge',
        anno: 2017,
        numero: '205',
        url: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2017;205',
        raw: 'legge n. 205 del 2017',
        start: 3,
        end_offset: 24,
      }),
    ]
    render(<Linkified text={text} refs={refs} />)
    const a = screen.getByRole('link')
    expect(a).toHaveTextContent('legge n. 205 del 2017')
    expect(a).toHaveAttribute(
      'href',
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2017;205',
    )
    expect(a).toHaveAttribute('target', '_blank')
    expect(a).toHaveAttribute('rel', 'noopener noreferrer')
    expect(a).toHaveAttribute('title', 'Legge 2017/205')
  })

  it('renders ref text without anchor when url is null (e.g. unresolved AS bill)', () => {
    const text = 'esame del A.S. 1236 di conversione'
    const refs = [
      ref({
        tipo: 'as',
        numero: '1236',
        url: null,
        resolve_status: 'pending',
        raw: 'A.S. 1236',
        start: 10,
        end_offset: 19,
      }),
    ]
    render(<Linkified text={text} refs={refs} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(/A\.S\. 1236/)).toBeInTheDocument()
  })

  it('handles multiple refs in the same paragraph', () => {
    const text = 'il D.L. 34/2020 modifica la legge n. 5 del 2019 in materia di...'
    const refs = [
      ref({
        tipo: 'decreto.legge',
        anno: 2020,
        numero: '34',
        url: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legge:2020;34',
        raw: 'D.L. 34/2020',
        start: 3,
        end_offset: 15,
      }),
      ref({
        tipo: 'legge',
        anno: 2019,
        numero: '5',
        url: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2019;5',
        raw: 'legge n. 5 del 2019',
        start: 28,
        end_offset: 47,
      }),
    ]
    render(<Linkified text={text} refs={refs} />)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links[0]).toHaveTextContent('D.L. 34/2020')
    expect(links[1]).toHaveTextContent('legge n. 5 del 2019')
  })

  it('splits paragraphs on \\n\\n and bucketizes refs to the right paragraph', () => {
    const text = 'prima paragrafo con D.L. 34/2020.\n\nsecondo paragrafo con A.C. 1234.'
    const refs = [
      ref({
        tipo: 'decreto.legge',
        anno: 2020,
        numero: '34',
        url: 'https://example.test/dl-34',
        raw: 'D.L. 34/2020',
        start: 20,
        end_offset: 32,
      }),
      ref({
        tipo: 'ac',
        numero: '1234',
        url: 'https://example.test/ac-1234',
        raw: 'A.C. 1234',
        // \n\n at indices 33-34, second paragraph starts at 35
        start: 57,
        end_offset: 66,
      }),
    ]
    const { container } = render(<Linkified text={text} refs={refs} />)
    const paragraphs = container.querySelectorAll('p')
    expect(paragraphs).toHaveLength(2)
    // First paragraph carries the D.L. link
    expect(paragraphs[0].querySelector('a')).toHaveAttribute(
      'href',
      'https://example.test/dl-34',
    )
    // Second paragraph carries the A.C. link
    expect(paragraphs[1].querySelector('a')).toHaveAttribute(
      'href',
      'https://example.test/ac-1234',
    )
  })
})
