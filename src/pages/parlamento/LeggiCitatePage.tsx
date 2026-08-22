import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'

import { BetaNotice } from '@/components/BetaNotice'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import { fetchLeggiPiuCitate, leggeUrl, leggeTipoLabel, type Chamber } from '@/services/parlamento'
import { LEGISLATURE_WITH_DATA } from '@/lib/parlamento-params'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { t } from '@/i18n/it'


export default function LeggiCitatePage() {
  const [legFilter, setLegFilter] = useState<number | undefined>(undefined)
  const [chamberFilter, setChamberFilter] = useState<Chamber | undefined>(undefined)

  const query = useQuery(
    ['parlamento/leggi-citate', legFilter, chamberFilter] as const,
    () => fetchLeggiPiuCitate({ leg: legFilter, chamber: chamberFilter }),
    { ttlMs: 5 * 60 * 1000 },
  )

  const rows = query.data?.data ?? []

  return (
    <div className="flex flex-col gap-8">
      <BetaNotice compact />

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/parlamento"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Parlamento
          </Link>
        </div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          {t.parlamento.leggiCitate.pageTitle}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.parlamento.leggiCitate.pageSubtitle}
        </p>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <fieldset className="inline-flex rounded-md border border-border p-0.5">
          <legend className="sr-only">{t.parlamento.leggiCitate.filterChamber}</legend>
          {(
            [
              { value: undefined, label: t.parlamento.leggiCitate.filterChamberAll },
              { value: 'camera' as Chamber, label: 'Camera' },
            ] as const
          ).map((o) => (
            <button
              key={o.value ?? 'all'}
              type="button"
              onClick={() => setChamberFilter(o.value)}
              aria-pressed={chamberFilter === o.value}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium transition-colors min-h-8',
                chamberFilter === o.value
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          ))}
        </fieldset>

        <fieldset className="flex flex-wrap items-center gap-1 rounded-md border border-border p-0.5">
          <legend className="sr-only">{t.parlamento.leggiCitate.filterLeg}</legend>
          <button
            type="button"
            onClick={() => setLegFilter(undefined)}
            aria-pressed={legFilter === undefined}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors min-h-8',
              legFilter === undefined
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {t.parlamento.leggiCitate.filterLegAll}
          </button>
          {LEGISLATURE_WITH_DATA.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setLegFilter(n)}
              aria-pressed={legFilter === n}
              className={cn(
                'rounded px-2 py-1 text-xs font-medium tabular-nums transition-colors min-h-8',
                legFilter === n
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {n}ª
            </button>
          ))}
        </fieldset>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.parlamento.leggiCitate.colNorma}</CardTitle>
          <CardDescription>{t.parlamento.leggiCitate.colCitazioni}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {query.status === 'loading' ? (
            <div className="flex flex-col gap-2 p-6">
              {Array.from({ length: 12 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">{t.parlamento.leggiCitate.empty}</p>
          ) : (
            <ol className="divide-y divide-border">
              {rows.map((row, i) => (
                <li
                  key={`${row.tipo}-${row.anno}-${row.numero}`}
                  className="flex items-center gap-4 px-6 py-3 hover:bg-muted/40 transition-colors"
                >
                  <span className="w-7 shrink-0 text-right text-sm tabular-nums text-muted-foreground font-mono">
                    {i + 1}.
                  </span>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                    <Badge variant="outline" className="shrink-0 font-mono text-xs uppercase">
                      {leggeTipoLabel(row.tipo)}
                    </Badge>
                    <span className="truncate font-medium text-sm">
                      {row.numero}
                      {row.anno ? `/${row.anno}` : ''}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular-nums text-sm font-semibold">
                      {formatNumber(row.n)}
                    </span>
                    {row.numero ? (
                      <Link
                        to={leggeUrl(row.tipo, row.anno, row.numero)}
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted transition-colors"
                        aria-label={`${t.parlamento.leggiCitate.viewCitations}: ${leggeTipoLabel(row.tipo)} ${row.numero}/${row.anno}`}
                      >
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        {t.parlamento.leggiCitate.viewCitations}
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
