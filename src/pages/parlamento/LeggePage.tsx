import { Link, useParams, useSearchParams } from 'react-router-dom'

import { BetaNotice } from '@/components/BetaNotice'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Pagination } from '@/components/Pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import {
  fetchLegge,
  leggeTipoLabel,
  personaUrl,
  sedutaUrl,
  type Chamber,
} from '@/services/parlamento'
import {
  LEGISLATURE_WITH_DATA,
  parseChamberParam,
  parseLegParam,
  parsePositiveInt,
} from '@/lib/parlamento-params'
import { formatDate, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { t } from '@/i18n/it'

const PAGE_SIZE = 20

export default function LeggePage() {
  const { tipo = '', anno: annoParam = '0', numero = '' } = useParams<{
    tipo: string
    anno: string
    numero: string
  }>()

  const anno = Number(annoParam) || null
  const decodedNumero = decodeURIComponent(numero)

  // Filter + page state lives in the URL, like every other page in this
  // section. It used to be useState, which meant the back button walked out
  // of the page instead of back a page of citations, and a filtered view
  // could not be linked or reloaded.
  const [searchParams, setSearchParams] = useSearchParams()
  const page = parsePositiveInt(searchParams.get('page'), 1)
  const chamberFilter = parseChamberParam(searchParams.get('chamber'))
  const legFilter = parseLegParam(searchParams.get('leg'))

  function patchParams(next: Record<string, string | null>) {
    const np = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(next)) {
      if (value == null || value === '') np.delete(key)
      else np.set(key, value)
    }
    setSearchParams(np, { replace: false })
  }

  function setPage(next: number) {
    patchParams({ page: next <= 1 ? null : String(next) })
  }

  const query = useQuery(
    ['parlamento/legge', tipo, anno, decodedNumero, page, chamberFilter, legFilter] as const,
    () =>
      fetchLegge(tipo, anno, decodedNumero, {
        page,
        pageSize: PAGE_SIZE,
        chamber: chamberFilter,
        leg: legFilter,
      }),
    { ttlMs: 5 * 60 * 1000 },
  )

  const data = query.data
  const rows = data?.data ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const title = `${leggeTipoLabel(tipo)} ${decodedNumero}${anno ? `/${anno}` : ''}`

  function patchFilters(next: { chamber?: Chamber | undefined; leg?: number | undefined }) {
    const patch: Record<string, string | null> = { page: null }
    if ('chamber' in next) patch.chamber = next.chamber ?? null
    if ('leg' in next) patch.leg = next.leg == null ? null : String(next.leg)
    patchParams(patch)
  }

  if (query.status === 'success' && data?.total === 0 && page === 1 && !chamberFilter && !legFilter) {
    return (
      <div className="flex flex-col gap-8">
        <Link to="/parlamento/leggi-citate" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
          {t.parlamento.legge.backToLeaderboard}
        </Link>
        <p className="text-sm text-muted-foreground">{t.parlamento.legge.notFound}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <BetaNotice compact />

      <header className="flex flex-col gap-3">
        <Link
          to="/parlamento/leggi-citate"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {t.parlamento.legge.backToLeaderboard}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {title}
          </h1>
          <Badge variant="outline" className="font-mono text-xs uppercase">
            {leggeTipoLabel(tipo)}
          </Badge>
        </div>
        {data != null ? (
          <p className="text-sm text-muted-foreground">
            {t.parlamento.legge.citedBy(total)}
          </p>
        ) : null}
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <fieldset className="inline-flex rounded-md border border-border p-0.5">
          <legend className="sr-only">{t.parlamento.legge.filterChamber}</legend>
          {(
            [
              { value: undefined, label: t.parlamento.legge.filterAll },
              { value: 'camera' as Chamber, label: 'Camera' },
              { value: 'senato' as Chamber, label: 'Senato' },
            ] as const
          ).map((o) => (
            <button
              key={o.value ?? 'all'}
              type="button"
              onClick={() => patchFilters({ chamber: o.value })}
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
          <legend className="sr-only">{t.parlamento.legge.filterLeg}</legend>
          <button
            type="button"
            onClick={() => patchFilters({ leg: undefined })}
            aria-pressed={legFilter === undefined}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors min-h-8',
              legFilter === undefined
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {t.parlamento.legge.filterAll}
          </button>
          {LEGISLATURE_WITH_DATA.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => patchFilters({ leg: n })}
              aria-pressed={legFilter === n}
              className={cn(
                'rounded px-2 py-1 text-xs tabular-nums font-medium transition-colors min-h-8',
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
          <CardTitle className="text-base">
            {t.parlamento.legge.colSeduta} · {t.parlamento.legge.colOrator}
          </CardTitle>
          {data != null ? (
            <CardDescription>
              {formatNumber(total)}{' '}
              {total === 1
                ? t.parlamento.legge.interventoSingular
                : t.parlamento.legge.interventoPlural}
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {query.status === 'loading' ? (
            <div className="flex flex-col gap-2 p-6">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">{t.parlamento.legge.empty}</p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => {
                const url = sedutaUrl(
                  row.chamber,
                  row.legislatura,
                  row.numero_seduta,
                  row.anchor ?? undefined,
                )
                const pUrl = personaUrl(row.oratore_chamber, row.oratore_id_persona)
                return (
                  <li
                    // One row per citing intervento: (chamber, leg, seduta,
                    // anchor) identifies it without falling back to the array
                    // index, which changes meaning on every page turn.
                    key={`${row.chamber}-${row.legislatura}-${row.numero_seduta}-${row.anchor ?? row.oratore_nome ?? ''}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3"
                  >
                    <Badge variant="outline" className="shrink-0 font-mono text-xs uppercase">
                      {row.chamber === 'camera' ? 'Camera' : 'Senato'}
                    </Badge>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {row.legislatura}ª · n.{row.numero_seduta}
                    </span>
                    <span className="text-sm">{formatDate(row.data)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {pUrl ? (
                        <Link
                          to={pUrl}
                          className="font-medium hover:underline"
                        >
                          {row.oratore_nome ?? '—'}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{row.oratore_nome ?? '—'}</span>
                      )}
                      {row.gruppo ? (
                        <span className="ml-2 text-xs text-muted-foreground">({row.gruppo})</span>
                      ) : null}
                    </span>
                    <Link
                      to={url}
                      className="ml-auto shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted transition-colors"
                    >
                      {t.parlamento.legge.openInSeduta}
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>

        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          isFetching={query.isFetching}
          onPageChange={(next) => setPage(Math.min(totalPages, Math.max(1, next)))}
        />
      </Card>
    </div>
  )
}
