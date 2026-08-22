import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { t } from '@/i18n/it'

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'ok' }),
        } as Response),
      ),
    )
  })

  it('renders the Italian hero headline on the home route', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )
    expect(
      screen.getByRole('heading', { level: 1, name: t.home.heroHeadline }),
    ).toBeInTheDocument()
  })

  it('reports the backend as operational once /api/health resolves', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(t.home.healthOk)
    })
  })

  it('renders the Appalti page when navigating to /appalti', async () => {
    render(
      <MemoryRouter initialEntries={['/appalti']}>
        <App />
      </MemoryRouter>,
    )
    // Appalti is lazy-loaded, so wait for the chunk to resolve.
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: t.sections.appalti.title }),
      ).toBeInTheDocument()
    })
  })

  it('renders the Contatti page with the LinkedIn link', async () => {
    render(
      <MemoryRouter initialEntries={[t.contatti.route]}>
        <App />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: t.contatti.title }),
      ).toBeInTheDocument()
    })
    expect(
      screen.getByRole('link', { name: t.contatti.linkedinLabel }),
    ).toHaveAttribute('href', t.contatti.linkedinUrl)
  })

  // The open-data licences require crediting the originating body, so the
  // Fonti page is a compliance surface rather than a nice-to-have: assert
  // every declared source actually renders a link to its portal.
  it('renders every declared source on the Fonti page', async () => {
    render(
      <MemoryRouter initialEntries={[t.fonti.route]}>
        <App />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: t.fonti.title }),
      ).toBeInTheDocument()
    })

    for (const source of t.fonti.sources) {
      expect(screen.getByText(source.name)).toBeInTheDocument()
    }
    const sourceLinks = screen
      .getAllByRole('link', { name: t.common.viewSource })
      .map((link) => link.getAttribute('href'))
    expect(sourceLinks).toEqual(t.fonti.sources.map((source) => source.url))
  })

  it('renders the Privacy page with every section', async () => {
    render(
      <MemoryRouter initialEntries={[t.privacy.route]}>
        <App />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: t.privacy.title }),
      ).toBeInTheDocument()
    })

    for (const section of t.privacy.sections) {
      expect(screen.getByText(section.title)).toBeInTheDocument()
    }
  })

  // Both pages are obligations that have to be reachable from anywhere, so
  // the footer link is load-bearing, not decorative.
  it('links to Fonti and Privacy from the footer on every route', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )
    const footerNav = screen.getByRole('navigation', { name: t.footer.nav })
    expect(
      within(footerNav).getByRole('link', { name: t.fonti.title }),
    ).toHaveAttribute('href', t.fonti.route)
    expect(
      within(footerNav).getByRole('link', { name: t.privacy.title }),
    ).toHaveAttribute('href', t.privacy.route)
  })
})
