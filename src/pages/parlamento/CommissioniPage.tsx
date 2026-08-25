import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Search } from 'lucide-react'

import { BetaNotice } from '@/components/BetaNotice'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import { fetchCommissioni, type Commissione } from '@/services/parlamento'
import {
  LEGISLATURE_WITH_DATA,
  parseChamberParam,
  parseLegParam,
} from '@/lib/parlamento-params'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n/it'

// Committee roster.
//
// 151 committees is too many for a flat card grid to be navigable, so the
// page leads with a text filter. Filtering happens client-side on purpose:
// the whole roster is one small response, so matching is instant and does not
// re-query on every keystroke.

function periodo(c: Commissione): string | null {
  if (!c.prima || !c.ultima) return null
  return `${formatDate(c.prima)} - ${formatDate(c.ultima)}`
}

/** Fold accents so "attività" matches a typed "attivita". */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export default function CommissioniPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const chamber = parseChamberParam(searchParams.get('chamber'))
  const leg = parseLegParam(searchParams.get('leg'))
  const [filter, setFilter] = useState('')

  const query = useQuery(
    ['parlamento/commissioni', chamber, leg] as const,
    () => fetchCommissioni({ chamber, leg }),
    { ttlMs: 5 * 60 * 1000 },
  )

  const rows = useMemo(() => query.data?.data ?? [], [query.data])
  const shown = useMemo(() => {
    const n = norm(filter.trim())
    if (n.length === 0) return rows
    return rows.filter((c) => norm(`${c.organo_nome ?? ''} ${c.organo_cod ?? ''}`).includes(n))
  }, [rows, filter])

  function setParam(key: string, value: string | undefined) {
    const p = new URLSearchParams(searchParams)
    if (value) p.set(key, value)
    else p.delete(key)
    setSearchParams(p, { replace: true })
  }

  const chamberOptions = [
    [undefined, t.parlamento.chamberAll],
    ['camera', t.parlamento.cameraLabel],
    ['senato', t.parlamento.senatoLabel],
  ] as const

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link
          to="/parlamento"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t.parlamento.commissioni.backLabel}
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          {t.parlamento.commissioni.title}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.parlamento.commissioni.subtitle}
        </p>
      </header>

      <BetaNotice compact />

      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t.parlamento.commissioni.filterPlaceholder}
            aria-label={t.parlamento.commissioni.filterPlaceholder}
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">{t.parlamento.commissioni.chamberFilterLegend}</legend>
            {chamberOptions.map(([value, label]) => (
              <button
                key={label}
                type="button"
                onClick={() => setParam('chamber', value)}
                aria-pressed={chamber === value}
                className={
                  'rounded-md border px-3 py-1.5 text-sm transition-colors ' +
                  (chamber === value
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground')
                }
              >
                {label}
              </button>
            ))}
          </fieldset>

          <select
            value={leg == null ? '' : String(leg)}
            onChange={(e) => setParam('leg', e.target.value || undefined)}
            aria-label={t.parlamento.commissioni.legAll}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          >
            <option value="">{t.parlamento.commissioni.legAll}</option>
            {LEGISLATURE_WITH_DATA.map((n) => (
              <option key={n} value={n}>
                {t.parlamento.commissioni.legLabel(n)}
              </option>
            ))}
          </select>

          <span className="ml-auto text-sm text-muted-foreground">
            {t.parlamento.commissioni.showing(shown.length, rows.length)}
          </span>
        </div>
      </div>

      {query.status === 'loading' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t.parlamento.commissioni.empty}</CardTitle>
          </CardHeader>
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t.parlamento.commissioni.filterNoMatch}</CardTitle>
          </CardHeader>
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {shown.map((c) => (
            <li key={`${c.chamber}-${c.organo_slug}`}>
              <Card className="h-full">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {c.chamber === 'camera'
                        ? t.parlamento.cameraLabel
                        : t.parlamento.senatoLabel}
                    </Badge>
                    {/* Senato committee work is published as third-person
                        summaries, so the distinction is visible before the
                        reader ever opens a document. */}
                    <Badge
                      variant={c.tipo_resoconto === 'sommario' ? 'secondary' : 'outline'}
                      className="text-xs"
                    >
                      {c.tipo_resoconto === 'sommario'
                        ? t.parlamento.commissioni.sommarioBadge
                        : t.parlamento.commissioni.stenograficoBadge}
                    </Badge>
                  </div>
                  <CardTitle className="text-base leading-snug">
                    <Link
                      to={`/parlamento/commissioni/${encodeURIComponent(c.organo_slug)}`}
                      className="hover:underline"
                    >
                      {c.organo_nome ?? c.organo_slug}
                    </Link>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span>
                    {c.n} {t.parlamento.commissioni.seduteCount}
                  </span>
                  {c.interventi ? (
                    <span>
                      {c.interventi} {t.parlamento.commissioni.interventiCount}
                    </span>
                  ) : (
                    <span className="italic">{t.parlamento.commissioni.notIngested}</span>
                  )}
                  {periodo(c) ? <span>{periodo(c)}</span> : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
