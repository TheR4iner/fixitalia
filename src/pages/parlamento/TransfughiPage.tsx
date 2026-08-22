import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { BetaNotice } from '@/components/BetaNotice'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import {
  fetchTransfughi,
  personaUrl,
  type GruppoStorico,
} from '@/services/parlamento'
import {
  LEGISLATURE_WITH_DATA,
  parseChamberParam,
  parseLegParam,
} from '@/lib/parlamento-params'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n/it'


/** Summarise a group-history: show first and last group if they differ. */
function GroupTransitions({ storico }: { storico: GruppoStorico[] }) {
  if (storico.length < 2) return null
  return (
    <div className="mt-1.5 flex flex-col gap-0.5">
      {storico.map((g, i) => (
        <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{g.gruppo}</span>
          {g.dal ? (
            <span>
              {t.parlamento.transfughi.on} {formatDate(g.dal)}
              {g.al ? ` → ${formatDate(g.al)}` : ''}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export default function TransfughiPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const leg = parseLegParam(searchParams.get('leg'))
  const chamber = parseChamberParam(searchParams.get('chamber'))

  const query = useQuery(
    ['parlamento/transfughi', leg, chamber] as const,
    () => fetchTransfughi({ leg, chamber }),
    { ttlMs: 10 * 60 * 1000 },
  )

  function setParam(key: string, value: string | null) {
    const np = new URLSearchParams(searchParams)
    if (value) np.set(key, value)
    else np.delete(key)
    setSearchParams(np, { replace: false })
  }

  const data = query.data?.data ?? []

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
          {t.parlamento.transfughi.pageTitle}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t.parlamento.transfughi.pageSubtitle}
        </p>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{t.parlamento.transfughi.filterLeg}</span>
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
          <span className="text-muted-foreground">{t.parlamento.transfughi.filterChamber}</span>
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
            {t.parlamento.transfughi.nSwitches(data.length)}
          </span>
        ) : null}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t.parlamento.transfughi.colNome}</CardTitle>
          <CardDescription>{t.parlamento.transfughi.pageSubtitle}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {query.status === 'loading' ? (
            <div className="flex flex-col gap-3 p-6">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : data.length === 0 ? (
            <div className="flex flex-col gap-2 p-6">
              <p className="text-sm text-muted-foreground">{t.parlamento.transfughi.noData}</p>
              <p className="text-xs text-muted-foreground/70">
                {t.parlamento.transfughi.noDataHint}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.map((tf) => {
                const url = personaUrl(tf.chamber, tf.id_persona)
                return (
                  <li
                    key={`${tf.chamber}-${tf.id_persona}`}
                    className="flex flex-col gap-1 px-6 py-3"
                  >
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <Badge
                        variant="outline"
                        className="shrink-0 font-mono text-[10px] uppercase"
                      >
                        {tf.chamber === 'camera' ? 'CAM' : 'SEN'}
                      </Badge>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        Leg. {tf.legislatura}
                      </Badge>
                      <span className="text-sm font-medium">
                        {url ? (
                          <Link to={url} className="hover:underline">
                            {tf.nome ?? '—'}
                          </Link>
                        ) : (
                          tf.nome ?? '—'
                        )}
                      </span>
                      {typeof tf.interventi_n === 'number' && tf.interventi_n > 0 ? (
                        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                          {tf.interventi_n.toLocaleString('it-IT')} int.
                        </span>
                      ) : null}
                    </div>
                    <GroupTransitions storico={tf.gruppo_storico} />
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
