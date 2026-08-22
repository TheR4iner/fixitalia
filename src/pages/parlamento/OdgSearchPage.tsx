import { type FormEvent, useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Search } from 'lucide-react'

import { BetaNotice } from '@/components/BetaNotice'
import { Pagination } from '@/components/Pagination'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import { searchOdg, sedutaUrl } from '@/services/parlamento'
import {
  LEGISLATURE_WITH_DATA,
  parseChamberParam,
  parseLegParam,
  parsePositiveInt,
} from '@/lib/parlamento-params'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n/it'

const PAGE_SIZE = 20

export default function OdgSearchPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const committedQ = searchParams.get('q') ?? ''
  const leg = parseLegParam(searchParams.get('leg'))
  const chamber = parseChamberParam(searchParams.get('chamber'))
  const page = parsePositiveInt(searchParams.get('page'), 1)

  // Local-only input state; only committed to URL on form submit.
  const [inputValue, setInputValue] = useState(committedQ)
  useEffect(() => setInputValue(committedQ), [committedQ])

  const enabled = committedQ.trim().length >= 2

  const query = useQuery(
    ['parlamento/odg/search', committedQ, leg, chamber, page] as const,
    () => {
      if (!enabled) return Promise.resolve(null)
      return searchOdg(committedQ, { leg, chamber, page, pageSize: PAGE_SIZE })
    },
    { ttlMs: 5 * 60 * 1000 },
  )

  function setParam(key: string, value: string | null) {
    const np = new URLSearchParams(searchParams)
    if (value) np.set(key, value)
    else np.delete(key)
    np.delete('page')
    setSearchParams(np, { replace: false })
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const q = inputValue.trim()
    const np = new URLSearchParams(searchParams)
    if (q) np.set('q', q)
    else np.delete('q')
    np.delete('page')
    setSearchParams(np, { replace: false })
  }

  function setPage(p: number) {
    const np = new URLSearchParams(searchParams)
    if (p > 1) np.set('page', String(p))
    else np.delete('page')
    setSearchParams(np, { replace: false })
  }

  const hits = query.data?.data ?? []
  const total = query.data?.total ?? 0
  const hasMore = query.data?.has_more ?? false
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-8">
      <BetaNotice compact />

      <header className="flex flex-col gap-3">
        <Link
          to="/parlamento"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t.parlamento.seduteList.backLabel}
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          {t.parlamento.odgSearch.pageTitle}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t.parlamento.odgSearch.pageSubtitle}
        </p>
      </header>

      {/* Search form */}
      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Input
          type="search"
          value={inputValue}
          onChange={(e) => setInputValue(e.currentTarget.value)}
          placeholder={t.parlamento.odgSearch.placeholder}
          className="flex-1"
          minLength={2}
          aria-label={t.parlamento.odgSearch.pageTitle}
        />
        <Button type="submit" className="gap-2 sm:shrink-0">
          <Search className="h-4 w-4" aria-hidden="true" />
          {t.parlamento.odgSearch.submit}
        </Button>
      </form>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{t.parlamento.odgSearch.filterLeg}</span>
          <select
            value={leg ?? ''}
            onChange={(e) => setParam('leg', e.currentTarget.value || null)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">{t.parlamento.odgSearch.filterLegAll}</option>
            {LEGISLATURE_WITH_DATA.map((n) => (
              <option key={n} value={String(n)}>
                {n}ª
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{t.parlamento.odgSearch.filterChamber}</span>
          <select
            value={chamber ?? ''}
            onChange={(e) => setParam('chamber', e.currentTarget.value || null)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">{t.parlamento.odgSearch.filterChamberAll}</option>
            <option value="camera">{t.parlamento.cameraLabel}</option>
            <option value="senato">{t.parlamento.senatoLabel}</option>
          </select>
        </label>
        {query.data ? (
          <span className="text-xs text-muted-foreground">
            {t.parlamento.odgSearch.total(total)}
            {hasMore ? '+' : ''}
          </span>
        ) : null}
      </div>

      {/* Results */}
      {!enabled ? (
        <p className="text-sm text-muted-foreground">
          {t.parlamento.odgSearch.empty}
        </p>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t.parlamento.odgSearch.colTitolo}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {query.status === 'loading' ? (
              <div className="flex flex-col gap-3 p-6">
                {Array.from({ length: 10 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : hits.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">{t.parlamento.odgSearch.empty}</p>
            ) : (
              <ul className="divide-y divide-border">
                {hits.map((hit, i) => {
                  const sUrl = sedutaUrl(hit.chamber, hit.legislatura, hit.numero_seduta, hit.anchor)
                  return (
                    <li
                      key={`${hit.chamber}-${hit.legislatura}-${hit.numero_seduta}-${hit.posizione}-${i}`}
                      className="flex flex-col gap-1 px-6 py-3"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <Badge
                          variant="outline"
                          className="shrink-0 font-mono text-[10px] uppercase"
                        >
                          {hit.chamber === 'camera' ? 'CAM' : 'SEN'}
                        </Badge>
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          Leg. {hit.legislatura}
                        </Badge>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          Sed. {hit.numero_seduta}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(hit.data)}
                        </span>
                        <Link
                          to={sUrl}
                          className="ml-auto shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted"
                        >
                          {t.parlamento.odgSearch.openInSeduta}
                        </Link>
                      </div>
                      <p className="text-sm text-foreground">{hit.titolo}</p>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>

          {hits.length > 0 ? (
            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              isFetching={query.isFetching}
              onPageChange={setPage}
            />
          ) : null}
        </Card>
      )}
    </div>
  )
}
