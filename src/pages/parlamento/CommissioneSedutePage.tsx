import { type FormEvent, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Search } from 'lucide-react'

import { BetaNotice } from '@/components/BetaNotice'
import { Pagination } from '@/components/Pagination'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import {
  commissioneSedutaUrl,
  fetchCommissioneSedute,
  ricercaUrl,
  type Seduta,
} from '@/services/parlamento'
import { parseLegParam, parsePositiveInt } from '@/lib/parlamento-params'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n/it'

const PAGE_SIZE = 30

// One committee's sittings.
//
// Two different searches live here and they answer different questions, so
// they are deliberately separate controls rather than one box:
//   - "filtra le sedute" narrows THIS list by sitting title (server-side,
//     because a committee can hold 400+ sittings across many pages);
//   - "cerca nelle trascrizioni" hands off to the full-text search scoped to
//     this committee, which searches what people actually said.
//
// Rows link by document scope, not numero: committee resoconti are numbered
// per-committee AND per inquiry, so the same number recurs many times here.

function kindLabel(seduta: Seduta): string | null {
  const tip = seduta.tipologia
  if (!tip) return null
  const map = t.parlamento.commissioni.tipologia as Record<string, string | undefined>
  return map[tip] ?? null
}

export default function CommissioneSedutePage() {
  const params = useParams<{ slug: string }>()
  const slug = params.slug ?? ''
  const [searchParams, setSearchParams] = useSearchParams()
  const page = parsePositiveInt(searchParams.get('page'), 1)
  const titleQuery = searchParams.get('q') ?? ''
  const year = searchParams.get('year')
  const legFilter = parseLegParam(searchParams.get('leg'))
  const tipologia = searchParams.get('tipologia') ?? ''
  const conTesto = searchParams.get('conTesto') === 'true'
  const sort: 'newest' | 'oldest' =
    searchParams.get('sort') === 'oldest' ? 'oldest' : 'newest'
  const hasFilters =
    Boolean(titleQuery || year || tipologia || conTesto) ||
    legFilter != null ||
    sort !== 'newest'

  const [titleInput, setTitleInput] = useState(titleQuery)
  useEffect(() => setTitleInput(titleQuery), [titleQuery])
  const [fullText, setFullText] = useState('')

  const query = useQuery(
    [
      'parlamento/commissione/sedute',
      slug, page, titleQuery, year, legFilter, tipologia, conTesto, sort,
    ] as const,
    () =>
      fetchCommissioneSedute(slug, {
        page,
        pageSize: PAGE_SIZE,
        q: titleQuery,
        year: year ? Number(year) : undefined,
        leg: legFilter,
        tipologia: tipologia || undefined,
        conTesto,
        sort,
      }),
    { ttlMs: 5 * 60 * 1000 },
  )

  const rows = query.data?.data ?? []
  const total = query.data?.total ?? 0
  const facets = query.data?.facets ?? { anni: [], legislature: [], tipologie: [] }
  const nome = rows[0]?.organo_nome ?? slug
  const isSommario = rows[0]?.tipo_resoconto === 'sommario'

  function setParam(key: string, value: string | undefined, resetPage = true) {
    const p = new URLSearchParams(searchParams)
    if (value) p.set(key, value)
    else p.delete(key)
    if (resetPage) p.delete('page')
    setSearchParams(p)
  }

  function onTitleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setParam('q', titleInput.trim() || undefined)
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link
          to="/parlamento/commissioni"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t.parlamento.commissioni.backToCommissioni}
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          {nome}
        </h1>
        {isSommario ? (
          <p className="max-w-3xl rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {t.parlamento.commissioni.sommarioNotice}
          </p>
        ) : null}
      </header>

      <BetaNotice compact />

      {/* Full-text search across what was SAID in this committee. */}
      <section className="flex flex-col gap-2 rounded-lg border border-border p-4">
        <h2 className="text-sm font-medium text-foreground">
          {t.parlamento.commissioni.searchInside}
        </h2>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => e.preventDefault()}
        >
          <Input
            type="search"
            value={fullText}
            onChange={(e) => setFullText(e.target.value)}
            placeholder={t.parlamento.commissioni.searchInsidePlaceholder}
            aria-label={t.parlamento.commissioni.searchInsidePlaceholder}
            className="flex-1"
          />
          <Button asChild disabled={fullText.trim().length < 2}>
            <Link
              to={ricercaUrl(fullText.trim(), { commissione: slug })}
              aria-disabled={fullText.trim().length < 2}
            >
              {t.parlamento.searchSubmit}
            </Link>
          </Button>
        </form>
      </section>

      {/* Facet filters. Options come from what this committee actually has, so
          a year with no sittings is never offered. */}
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">{t.parlamento.commissioni.filtersLegend}</legend>

        {facets.anni.length > 1 ? (
          <select
            value={year ?? ''}
            onChange={(e) => setParam('year', e.target.value || undefined)}
            aria-label={t.parlamento.commissioni.yearAll}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">{t.parlamento.commissioni.yearAll}</option>
            {facets.anni.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        ) : null}

        {facets.legislature.length > 1 ? (
          <select
            value={legFilter == null ? '' : String(legFilter)}
            onChange={(e) => setParam('leg', e.target.value || undefined)}
            aria-label={t.parlamento.commissioni.legFilterAll}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">{t.parlamento.commissioni.legFilterAll}</option>
            {facets.legislature.map((n) => (
              <option key={n} value={n}>{t.parlamento.commissioni.legLabel(n)}</option>
            ))}
          </select>
        ) : null}

        {facets.tipologie.length > 1 ? (
          <select
            value={tipologia}
            onChange={(e) => setParam('tipologia', e.target.value || undefined)}
            aria-label={t.parlamento.commissioni.kindAll}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">{t.parlamento.commissioni.kindAll}</option>
            {facets.tipologie.map((k) => {
              const map = t.parlamento.commissioni.tipologia as Record<string, string | undefined>
              return <option key={k} value={k}>{map[k] ?? k}</option>
            })}
          </select>
        ) : null}

        <select
          value={sort}
          onChange={(e) => setParam('sort', e.target.value === 'oldest' ? 'oldest' : undefined)}
          aria-label={t.parlamento.commissioni.sortNewest}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="newest">{t.parlamento.commissioni.sortNewest}</option>
          <option value="oldest">{t.parlamento.commissioni.sortOldest}</option>
        </select>

        <button
          type="button"
          onClick={() => setParam('conTesto', conTesto ? undefined : 'true')}
          aria-pressed={conTesto}
          className={
            'rounded-md border px-3 py-1.5 text-sm transition-colors ' +
            (conTesto
              ? 'border-foreground bg-foreground text-background'
              : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground')
          }
        >
          {t.parlamento.commissioni.onlyWithText}
        </button>

        {hasFilters ? (
          <button
            type="button"
            onClick={() => setSearchParams(new URLSearchParams())}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {t.parlamento.commissioni.resetFilters}
          </button>
        ) : null}
      </fieldset>

      {/* Narrow THIS list by sitting title. */}
      <form onSubmit={onTitleSubmit} className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={titleInput}
          onChange={(e) => setTitleInput(e.target.value)}
          placeholder={t.parlamento.commissioni.sedutaFilterPlaceholder}
          aria-label={t.parlamento.commissioni.sedutaFilterPlaceholder}
          className="pl-9"
        />
      </form>

      {query.status === 'loading' ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {titleQuery
                ? t.parlamento.commissioni.sedutaNoMatch
                : t.parlamento.commissioni.emptySedute}
            </CardTitle>
          </CardHeader>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {total} {t.parlamento.commissioni.seduteCount}
          </p>
          <ul className="flex flex-col gap-3">
            {rows.map((s) => (
              <li key={s.id}>
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      <span>{formatDate(s.data)}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {t.parlamento.commissioni.sedutaLabel} {s.numero}
                      </span>
                      {kindLabel(s) ? (
                        <Badge variant="outline" className="text-xs">
                          {kindLabel(s)}
                        </Badge>
                      ) : null}
                    </div>
                    <CardTitle className="text-base leading-snug">
                      <Link
                        to={commissioneSedutaUrl(s.id) ?? '/parlamento/commissioni'}
                        className="hover:underline"
                      >
                        {s.titolo ?? `${t.parlamento.commissioni.sedutaLabel} ${s.numero}`}
                      </Link>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
                    {s.interventi_n ? (
                      <span>
                        {s.interventi_n} {t.parlamento.commissioni.interventiCount}
                      </span>
                    ) : (
                      <span className="italic">{t.parlamento.commissioni.notIngested}</span>
                    )}
                    {s.odg_n ? (
                      <span>
                        {s.odg_n} {t.parlamento.seduteList.odgCount}
                      </span>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
          <Pagination
            page={page}
            onPageChange={(next) => {
              const p = new URLSearchParams(searchParams)
              p.set('page', String(next))
              setSearchParams(p)
            }}
            totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
            total={total}
            isFetching={query.isFetching}
          />
        </>
      )}
    </div>
  )
}
