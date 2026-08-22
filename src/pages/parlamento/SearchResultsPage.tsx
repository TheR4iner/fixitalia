import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { BetaNotice } from '@/components/BetaNotice'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import { personaUrl, searchParlamento, sedutaUrl } from '@/services/parlamento'
import { isChamber } from '@/lib/parlamento-params'
import { formatDate, formatNumber } from '@/lib/format'
import { t } from '@/i18n/it'

// Search results page. Renders BM25 hits with highlighted snippets and
// links into the reader at the matched intervention's anchor.
//
// Snippet rendering: the backend returns `snippet` strings that already
// contain <mark>...</mark> wrappers around matched terms (Surreal's
// search::highlight()). We split on those literal markers and rebuild
// the snippet as React nodes, so no raw-HTML render path is needed and
// no sanitiser is required.
//
// Card semantics: the card itself is NOT a link. Each card carries
// multiple targets (speaker page, seduta-by-date, seduta-by-number, and
// the intervention anchor) -- nesting them inside a card-wide link
// would be invalid HTML and confuse assistive tech. Instead the snippet
// paragraph wraps in a Link to the matched intervento anchor; that's
// the dominant action, the rest are explicit anchors that read
// naturally as inline references.

function renderSnippet(snippet: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const parts = snippet.split('<mark>')
  parts.forEach((seg, i) => {
    if (i === 0) {
      out.push(seg)
      return
    }
    const close = seg.indexOf('</mark>')
    if (close === -1) {
      out.push(<mark key={`m${i}`}>{seg}</mark>)
      return
    }
    const inner = seg.slice(0, close)
    const after = seg.slice(close + '</mark>'.length)
    out.push(<mark key={`m${i}`}>{inner}</mark>)
    out.push(after)
  })
  return out
}

export default function SearchResultsPage() {
  const [params, setParams] = useSearchParams()
  const initialQ = params.get('q') ?? ''
  const initialChamber = params.get('chamber')
  const [input, setInput] = useState(initialQ)

  const q = initialQ
  const chamber = isChamber(initialChamber) ? initialChamber : null

  const queryKey = ['parlamento/search', q, chamber] as const
  const result = useQuery(
    queryKey,
    () =>
      q.length < 2
        ? Promise.resolve({ data: [], page: 1, pageSize: 0, total: 0, q })
        : searchParlamento(q, { chamber: chamber ?? undefined, page: 1 }),
    { ttlMs: 5 * 60 * 1000 },
  )

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const next = input.trim()
    if (next.length < 2) return
    const np = new URLSearchParams({ q: next })
    if (chamber) np.set('chamber', chamber)
    setParams(np)
  }

  const hits = result.data?.data ?? []

  return (
    <div className="flex flex-col gap-6">
      <BetaNotice compact />

      <header className="flex flex-col gap-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          {t.parlamento.searchSubmit}
        </h1>
        <p className="text-sm text-muted-foreground">{t.parlamento.searchHint}</p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row">
        <Input
          name="q"
          type="search"
          placeholder={t.parlamento.searchPlaceholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" disabled={input.trim().length < 2}>
          {t.parlamento.searchSubmit}
        </Button>
      </form>

      {q.length < 2 ? null : result.status === 'loading' ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : hits.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t.parlamento.searchEmpty}</CardTitle>
          </CardHeader>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {formatNumber(result.data?.total ?? 0)}
            {result.data?.has_more ? '+' : ''} {t.parlamento.searchResultCount}
          </p>
          <ul className="space-y-4">
            {hits.map((h) => {
              const sedutaHref = sedutaUrl(h.chamber, h.legislatura, h.numero, h.anchor)
              return (
                <li
                  // Search spans every legislature, and seduta numbers restart
                  // at 1 in each one -- without legislatura, two hits at the
                  // same position of the same-numbered seduta in different
                  // legislatures collide and React reuses the wrong node.
                  key={`${h.chamber}-${h.legislatura}-${h.numero}-${h.posizione}`}
                >
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <Badge variant="outline" className="font-mono uppercase text-xs">
                          {h.chamber === 'camera' ? 'Camera' : 'Senato'}
                        </Badge>
                        <CardTitle className="text-base">
                          {(() => {
                            const href = personaUrl(h.oratore_chamber, h.oratore_id_persona)
                            const label = h.oratore_nome ?? 'Anonimo'
                            return href && h.oratore_nome ? (
                              <Link
                                to={href}
                                className="underline decoration-muted-foreground/30 underline-offset-4 hover:decoration-foreground"
                              >
                                {label}
                              </Link>
                            ) : (
                              label
                            )
                          })()}
                        </CardTitle>
                        {h.gruppo ? (
                          <Badge variant="secondary" className="text-[10px]">
                            {h.gruppo}
                          </Badge>
                        ) : null}
                        <span className="ml-auto inline-flex items-baseline gap-1.5 text-xs text-muted-foreground">
                          <Link
                            to={sedutaHref}
                            className="underline decoration-muted-foreground/30 underline-offset-4 hover:decoration-foreground"
                          >
                            {formatDate(h.data)}
                          </Link>
                          <span aria-hidden="true">·</span>
                          <Link
                            to={sedutaHref}
                            className="underline decoration-muted-foreground/30 underline-offset-4 hover:decoration-foreground"
                          >
                            seduta n. {h.numero}
                          </Link>
                        </span>
                      </div>
                      {h.odg_titolo ? (
                        <CardDescription className="line-clamp-1">
                          {h.odg_titolo}
                        </CardDescription>
                      ) : null}
                    </CardHeader>
                    <CardContent className="text-sm text-foreground/90">
                      <Link
                        to={sedutaHref}
                        aria-label={t.parlamento.searchOpenSeduta}
                        className="block rounded-md outline-none transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <p className="line-clamp-3">{renderSnippet(h.snippet || h.testo)}</p>
                      </Link>
                    </CardContent>
                  </Card>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
