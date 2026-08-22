import { useMemo, useRef, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  BookOpen,
  Layers,
  RotateCcw,
  Search,
} from 'lucide-react'

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
import { BetaNotice } from '@/components/BetaNotice'
import { Pagination } from '@/components/Pagination'
import { SourceLink } from '@/components/SourceLink'
import { SpeakerSearch } from '@/components/parlamento/SpeakerSearch'
import { useQuery } from '@/hooks/useQuery'
import {
  fetchParlamentoCalendar,
  fetchSedute,
  sedutaUrl,
  type Chamber,
  type SortOrder,
} from '@/services/parlamento'
import {
  LEGISLATURE_WITH_DATA,
  parseChamberFilter,
  parseLeg,
  parsePositiveInt,
  parseYear,
} from '@/lib/parlamento-params'
import { cn } from '@/lib/utils'
import { formatDate, formatNumber } from '@/lib/format'
import { t } from '@/i18n/it'

// Landing page for /parlamento.
//
// State lives in the URL via useSearchParams so a page reload, the back
// button, and link-sharing all preserve the current view. Recognised query
// params:
//   chamber  : 'camera' | 'senato'  (omit for both)
//   year     : 4-digit year         (sets from/to to that calendar year)
//   sort     : 'newest' | 'oldest'  (default 'newest')
//   page     : 1..N
//   q        : (only set when redirecting to /parlamento/cerca)
//
// Filters present:
//   - sort toggle (newest / chronological)
//   - chamber select (entrambe / Camera / Senato)
//   - year shortcut row (with counts), derived client-side from the
//     /calendar endpoint that already groups by month.

const PAGE_SIZE = 30

function parseSort(s: string | null): SortOrder {
  return s === 'oldest' ? 'oldest' : 'newest'
}

export default function ParlamentoPage() {
  const [params, setParams] = useSearchParams()
  const chamber = parseChamberFilter(params.get('chamber'))
  const sort = parseSort(params.get('sort'))
  const year = parseYear(params.get('year'))
  const leg = parseLeg(params.get('leg'))
  const page = parsePositiveInt(params.get('page'), 1)
  const navigate = useNavigate()
  const listRef = useRef<HTMLDivElement | null>(null)

  // Derive ISO from/to from the year filter so the API gets the right window.
  // When a legislature filter is active, year sub-filters still apply (the user
  // can narrow to "Camera leg 19 sessions in 2024").
  const fromMonth = year ? `${year}-01` : undefined
  const toMonth = year ? `${year}-12` : undefined

  const seduteQuery = useQuery(
    ['parlamento/sedute', chamber, year, leg, sort, page] as const,
    () =>
      fetchSedute({
        chamber: chamber === 'all' ? undefined : chamber,
        page,
        pageSize: PAGE_SIZE,
        from: fromMonth,
        to: toMonth,
        sort,
        leg: leg ?? undefined,
      }),
    { ttlMs: 5 * 60 * 1000 },
  )

  // Calendar drives the year shortcut row. We pull it once per chamber
  // and aggregate to year-level counts. This is cheap (one row per
  // year-month per chamber, ~36 rows for the legislature).
  //
  // It must carry the legislature filter too, otherwise the year row
  // offers years the current legislature never covered -- which reads as
  // "the legislature filter did nothing" and leads to empty result pages.
  const calendarQuery = useQuery(
    ['parlamento/calendar', chamber, leg] as const,
    () =>
      fetchParlamentoCalendar({
        chamber: chamber === 'all' ? undefined : chamber,
        leg: leg ?? undefined,
      }),
    { ttlMs: 10 * 60 * 1000 },
  )

  // Year buckets sorted descending so the most recent year appears first.
  const yearBuckets = useMemo(() => {
    const data = calendarQuery.data?.data ?? []
    const byYear = new Map<number, number>()
    for (const row of data) {
      const yr = Number(row.ym.slice(0, 4))
      if (!Number.isFinite(yr)) continue
      byYear.set(yr, (byYear.get(yr) ?? 0) + row.count)
    }
    const arr = Array.from(byYear.entries()).map(([yr, count]) => ({ yr, count }))
    arr.sort((a, b) => b.yr - a.yr)
    return arr
  }, [calendarQuery.data])

  const sedute = seduteQuery.data?.data ?? []
  const total = seduteQuery.data?.total ?? 0
  const pageSize = seduteQuery.data?.pageSize ?? PAGE_SIZE
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const isEmpty =
    seduteQuery.status === 'success' && sedute.length === 0 && total === 0
  const isFetching = seduteQuery.isFetching
  const filtersActive = chamber !== 'all' || year != null || leg != null || sort !== 'newest'

  function patchParams(next: Record<string, string | null>) {
    const np = new URLSearchParams(params)
    for (const [key, value] of Object.entries(next)) {
      if (value == null || value === '') np.delete(key)
      else np.set(key, value)
    }
    setParams(np, { replace: false })
  }

  function setChamber(next: Chamber | 'all') {
    patchParams({
      chamber: next === 'all' ? null : next,
      page: null, // reset pagination when filter changes
    })
  }
  function setSort(next: SortOrder) {
    patchParams({ sort: next === 'newest' ? null : next, page: null })
  }
  function setYear(next: number | null) {
    patchParams({ year: next == null ? null : String(next), page: null })
  }
  function resetFilters() {
    setParams(new URLSearchParams(), { replace: false })
  }
  function goToPage(next: number) {
    const clamped = Math.min(totalPages, Math.max(1, next))
    patchParams({ page: clamped === 1 ? null : String(clamped) })
    requestAnimationFrame(() => {
      listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  function onSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const q = (new FormData(form).get('q') as string | null)?.trim() ?? ''
    if (q.length < 2) return
    const np = new URLSearchParams({ q })
    if (chamber !== 'all') np.set('chamber', chamber)
    navigate(`/parlamento/cerca?${np.toString()}`)
  }

  return (
    <div className="flex flex-col gap-8">
      <BetaNotice>
        <SourceLink
          label={t.parlamento.cameraLabel}
          url={t.parlamento.sourceUrlCamera}
          className="text-warning-foreground/80 hover:text-warning-foreground"
        />
        <SourceLink
          label={t.parlamento.senatoLabel}
          url={t.parlamento.sourceUrlSenato}
          className="text-warning-foreground/80 hover:text-warning-foreground"
        />
      </BetaNotice>

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {t.sections.parlamento.title}
          </h1>
          <Badge variant="outline">
            {t.parlamento.cameraLabel} + {t.parlamento.senatoLabel}
          </Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.parlamento.pageSubtitle}
        </p>
      </header>

      {/* Legislature context banner — shown when browsing a specific legislature */}
      {leg != null ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3">
          <span className="text-sm font-medium">
            {t.parlamento.legislatura.title(leg)}
          </span>
          <Link
            to={`/parlamento/legislature/${leg}`}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {t.parlamento.quickNav.legislatureOverview}
          </Link>
          <button
            type="button"
            onClick={() => patchParams({ leg: null, page: null })}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t.parlamento.quickNav.removeLegFilter}
          </button>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.parlamento.searchHint}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={onSearch} className="flex flex-col gap-3 sm:flex-row">
            <label htmlFor="parlamento-search" className="sr-only">
              {t.parlamento.searchPlaceholder}
            </label>
            <Input
              id="parlamento-search"
              name="q"
              type="search"
              placeholder={t.parlamento.searchPlaceholder}
              className="flex-1"
              minLength={2}
            />
            <Button type="submit" className="gap-2">
              <Search className="h-4 w-4" aria-hidden="true" />
              {t.parlamento.searchSubmit}
            </Button>
          </form>

          <div className="border-t border-border pt-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {t.parlamento.speakerSearch.label}
            </p>
            <SpeakerSearch />
          </div>
        </CardContent>
      </Card>

      {/* Quick-nav: legislatures + thematic links */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-sm font-medium">
                {t.parlamento.quickNav.legislatureTitle}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5 pt-0">
            {LEGISLATURE_WITH_DATA.map((n) => (
              <Link
                key={n}
                to={`/parlamento/legislature/${n}`}
                className="rounded-full border border-border px-3 py-1 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:border-foreground hover:bg-muted hover:text-foreground"
              >
                {t.parlamento.quickNav.legShort(n)}
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-sm font-medium">
                {t.parlamento.quickNav.exploreTitle}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0">
            <Link
              to="/parlamento/leggi-citate"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {t.parlamento.quickNav.leggiCitate}
            </Link>
            <Link
              to="/parlamento/transfughi"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {t.parlamento.quickNav.transfughi}
            </Link>
            <Link
              to="/parlamento/odg/cerca"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {t.parlamento.quickNav.odgSearch}
            </Link>
          </CardContent>
        </Card>
      </div>

      <Card ref={listRef}>
        <CardHeader>
          <CardTitle>{t.parlamento.recentTitle}</CardTitle>
          <CardDescription>{t.parlamento.recentSubtitle}</CardDescription>
        </CardHeader>

        {/* Filter strip: chamber + sort + year shortcuts */}
        <div className="flex flex-col gap-4 px-4 pb-2 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <fieldset className="inline-flex rounded-md border border-border p-0.5">
              <legend className="sr-only">{t.parlamento.filters.chamberLegend}</legend>
              {(
                [
                  { value: 'all', label: t.parlamento.chamberAll },
                  { value: 'camera', label: 'Camera' },
                  { value: 'senato', label: 'Senato' },
                ] as const
              ).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setChamber(o.value)}
                  aria-pressed={chamber === o.value}
                  className={cn(
                    'rounded px-3 py-1 text-xs font-medium transition-colors min-h-8 pointer-coarse:min-h-11 pointer-coarse:px-4',
                    chamber === o.value
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </fieldset>

            <fieldset className="inline-flex rounded-md border border-border p-0.5">
              <legend className="sr-only">{t.parlamento.filters.sortLabel}</legend>
              <button
                type="button"
                onClick={() => setSort('newest')}
                aria-pressed={sort === 'newest'}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-3 py-1 text-xs font-medium transition-colors min-h-8 pointer-coarse:min-h-11 pointer-coarse:px-4',
                  sort === 'newest'
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <ArrowDownNarrowWide className="h-3.5 w-3.5" aria-hidden="true" />
                {t.parlamento.filters.sortNewest}
              </button>
              <button
                type="button"
                onClick={() => setSort('oldest')}
                aria-pressed={sort === 'oldest'}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-3 py-1 text-xs font-medium transition-colors min-h-8 pointer-coarse:min-h-11 pointer-coarse:px-4',
                  sort === 'oldest'
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <ArrowUpNarrowWide className="h-3.5 w-3.5" aria-hidden="true" />
                {t.parlamento.filters.sortOldest}
              </button>
            </fieldset>

            {filtersActive ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetFilters}
                className="ml-auto h-8 gap-1 text-xs text-muted-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {t.parlamento.filters.reset}
              </Button>
            ) : null}
          </div>

          {yearBuckets.length > 0 ? (
            <fieldset className="flex flex-wrap items-center gap-1.5 overflow-x-auto pb-1">
              <legend className="sr-only">{t.parlamento.filters.yearLegend}</legend>
              <button
                type="button"
                onClick={() => setYear(null)}
                aria-pressed={year == null}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors min-h-8 pointer-coarse:min-h-11 pointer-coarse:px-4',
                  year == null
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {t.parlamento.filters.yearAll}
              </button>
              {yearBuckets.map((y) => (
                <button
                  key={y.yr}
                  type="button"
                  onClick={() => setYear(y.yr)}
                  aria-pressed={year === y.yr}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs tabular-nums transition-colors min-h-8 pointer-coarse:min-h-11 pointer-coarse:px-4',
                    year === y.yr
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <span className="font-medium">{y.yr}</span>
                  <span className="ml-1.5 text-[10px] opacity-70">
                    {formatNumber(y.count)}
                  </span>
                </button>
              ))}
            </fieldset>
          ) : null}
        </div>

        <CardContent>
          {seduteQuery.status === 'loading' && sedute.length === 0 ? (
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : isEmpty ? (
            <p className="text-sm text-muted-foreground">{t.parlamento.seduteList.empty}</p>
          ) : (
            <ul className="divide-y divide-border">
              {sedute.map((s) => (
                <li
                  // A seduta is keyed by (chamber, legislatura, numero) --
                  // numero restarts at 1 each legislature, so omitting leg
                  // makes the key ambiguous across a legislature boundary.
                  key={`${s.chamber}-${s.legislatura}-${s.numero}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3"
                >
                  <Badge
                    variant="outline"
                    className="font-mono uppercase tracking-wide text-xs"
                  >
                    {s.chamber === 'camera' ? 'Camera' : 'Senato'}
                  </Badge>
                  <span className="font-mono text-sm tabular-nums text-muted-foreground">
                    n. {s.numero}
                  </span>
                  <span className="text-sm">{formatDate(s.data)}</span>
                  {s.titolo ? (
                    <span className="hidden text-sm text-muted-foreground sm:inline">
                      {s.titolo}
                    </span>
                  ) : null}
                  <span className="ml-auto inline-flex items-center gap-3 text-xs text-muted-foreground">
                    {s.odg_n != null ? (
                      <span>
                        {formatNumber(s.odg_n)} {t.parlamento.seduteList.odgCount}
                      </span>
                    ) : null}
                    {s.interventi_n != null ? (
                      <span>
                        {formatNumber(s.interventi_n)}{' '}
                        {t.parlamento.seduteList.interventiCount}
                      </span>
                    ) : null}
                    <Link
                      to={sedutaUrl(s.chamber as Chamber, s.legislatura, s.numero)}
                      className="rounded-md border border-border px-2 py-1 text-foreground transition-colors hover:bg-muted"
                    >
                      {t.parlamento.seduteList.open}
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>

        {!isEmpty ? (
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            isFetching={isFetching}
            onPageChange={goToPage}
          />
        ) : null}
      </Card>

      <footer className="text-xs text-muted-foreground">
        <SourceLink label="Camera dei Deputati" url={t.parlamento.sourceUrlCamera} />
        <span className="mx-2">·</span>
        <SourceLink label="Senato della Repubblica" url={t.parlamento.sourceUrlSenato} />
      </footer>
    </div>
  )
}
