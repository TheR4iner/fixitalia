import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { BetaNotice } from '@/components/BetaNotice'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import { fetchCommissioni, type Commissione } from '@/services/parlamento'
import { parseChamberParam, parseLegParam } from '@/lib/parlamento-params'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n/it'

// Committee roster. One card per committee, ordered by how much of its work
// we hold, because a committee with 300 ingested sittings is far more useful
// to open than one with two.

function periodo(c: Commissione): string | null {
  if (!c.prima || !c.ultima) return null
  return `${formatDate(c.prima)} - ${formatDate(c.ultima)}`
}

export default function CommissioniPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const chamber = parseChamberParam(searchParams.get('chamber'))
  const leg = parseLegParam(searchParams.get('leg'))

  const query = useQuery(
    ['parlamento/commissioni', chamber, leg] as const,
    () => fetchCommissioni({ chamber, leg }),
    { ttlMs: 5 * 60 * 1000 },
  )

  const rows = query.data?.data ?? []

  function setChamber(next: 'camera' | 'senato' | undefined) {
    const params = new URLSearchParams(searchParams)
    if (next) params.set('chamber', next)
    else params.delete('chamber')
    setSearchParams(params, { replace: true })
  }

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

      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">{t.parlamento.commissioni.chamberFilterLegend}</legend>
        {(
          [
            [undefined, t.parlamento.chamberAll],
            ['camera', t.parlamento.cameraLabel],
            ['senato', t.parlamento.senatoLabel],
          ] as const
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            onClick={() => setChamber(value)}
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
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {rows.map((c) => (
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
                        summaries, so the distinction is surfaced before the
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
                  ) : null}
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
