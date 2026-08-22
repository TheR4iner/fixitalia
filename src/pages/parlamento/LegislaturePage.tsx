import { Link, useParams } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'

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
import { fetchLegislatura, leggeUrl, leggeTipoLabel, personaUrl } from '@/services/parlamento'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n/it'

function formatDateRange(from: string | null, to: string | null): string {
  if (!from) return ''
  const f = formatDate(from)
  const toLabel = to ? formatDate(to) : 'oggi'
  return t.parlamento.legislatura.dateRange(f, toLabel)
}

export default function LegislaturePage() {
  const { n: nParam } = useParams<{ n: string }>()
  const leg = Number(nParam)

  const query = useQuery(
    ['parlamento/legislatura', leg] as const,
    () => fetchLegislatura(leg),
    { ttlMs: 10 * 60 * 1000 },
  )

  if (!Number.isFinite(leg) || leg <= 0) {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/parlamento" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
          {t.parlamento.legislatura.backToSedute}
        </Link>
        <p className="text-sm text-muted-foreground">{t.parlamento.legislatura.notFound}</p>
      </div>
    )
  }

  const data = query.data

  return (
    <div className="flex flex-col gap-8">
      <BetaNotice compact />

      <header className="flex flex-col gap-3">
        <Link
          to="/parlamento"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {t.parlamento.legislatura.backToSedute}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {t.parlamento.legislatura.title(leg)}
          </h1>
        </div>
      </header>

      {/* Quick-action links */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Link
          to={`/parlamento?leg=${leg}`}
          className="rounded-md border border-border px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          Sfoglia tutte le sedute →
        </Link>
        <Link
          to={`/parlamento/leggi-citate?leg=${leg}`}
          className="rounded-md border border-border px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          Leggi più citate →
        </Link>
        <Link
          to={`/parlamento/transfughi?leg=${leg}`}
          className="rounded-md border border-border px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          Cambi di gruppo →
        </Link>
        <Link
          to={`/parlamento/odg/cerca?leg=${leg}`}
          className="rounded-md border border-border px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          Cerca negli OdG →
        </Link>
      </div>

      {/* Chamber stat cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        {(['camera', 'senato'] as const).map((chamber) => {
          const stats = data?.[chamber]
          const label =
            chamber === 'camera'
              ? t.parlamento.legislatura.cameraLabel
              : t.parlamento.legislatura.senatoLabel
          return (
            <Card key={chamber}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              </CardHeader>
              <CardContent>
                {query.status === 'loading' ? (
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-7 w-32" />
                    <Skeleton className="h-4 w-48" />
                  </div>
                ) : stats ? (
                  <>
                    <p className="text-2xl font-semibold tabular-nums">
                      {t.parlamento.legislatura.seduteStat(stats.n)}
                    </p>
                    {stats.data_inizio ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatDateRange(stats.data_inizio, stats.data_fine)}
                      </p>
                    ) : null}
                    {stats.n > 0 ? (
                      <Link
                        to={`/parlamento?chamber=${chamber}&leg=${leg}`}
                        className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Sfoglia le sedute
                        <ArrowRight className="h-3 w-3" aria-hidden="true" />
                      </Link>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">—</p>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top speakers */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t.parlamento.legislatura.topSpeakersTitle}</CardTitle>
            <CardDescription>{t.parlamento.legislatura.topSpeakersSubtitle}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {query.status === 'loading' ? (
              <div className="flex flex-col gap-2 p-6">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : !data?.top_speakers.length ? (
              <p className="p-6 text-sm text-muted-foreground">
                {t.parlamento.legislatura.noSpeakers}
              </p>
            ) : (
              <ol className="divide-y divide-border">
                {data.top_speakers.map((sp, i) => {
                  const pUrl = personaUrl(sp.chamber, sp.id_persona)
                  return (
                    <li key={`${sp.chamber}-${sp.id_persona}`} className="flex items-center gap-3 px-6 py-2.5">
                      <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {i + 1}.
                      </span>
                      <Badge variant="outline" className="shrink-0 font-mono text-[10px] uppercase">
                        {sp.chamber === 'camera' ? 'CAM' : 'SEN'}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {pUrl ? (
                          <Link to={pUrl} className="font-medium hover:underline">
                            {sp.nome ?? '—'}
                          </Link>
                        ) : (
                          <span className="font-medium">{sp.nome ?? '—'}</span>
                        )}
                        {sp.gruppo_attuale ? (
                          <span className="ml-2 text-xs text-muted-foreground truncate">
                            {sp.gruppo_attuale}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {t.parlamento.legislatura.interventiLabel(sp.interventi_n)}
                      </span>
                    </li>
                  )
                })}
              </ol>
            )}
          </CardContent>
        </Card>

        {/* Top cited laws */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t.parlamento.legislatura.topLawsTitle}</CardTitle>
            <CardDescription>{t.parlamento.legislatura.topLawsSubtitle}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {query.status === 'loading' ? (
              <div className="flex flex-col gap-2 p-6">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : !data?.top_laws.length ? (
              <p className="p-6 text-sm text-muted-foreground">
                {t.parlamento.legislatura.noLaws}
              </p>
            ) : (
              <ol className="divide-y divide-border">
                {data.top_laws.map((law, i) => (
                  <li
                    key={`${law.tipo}-${law.anno}-${law.numero}`}
                    className="flex items-center gap-3 px-6 py-2.5"
                  >
                    <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {i + 1}.
                    </span>
                    <Badge variant="outline" className="shrink-0 font-mono text-[10px] uppercase">
                      {leggeTipoLabel(law.tipo)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {law.numero ? (
                        <Link
                          to={leggeUrl(law.tipo, law.anno, law.numero)}
                          className="font-medium hover:underline"
                        >
                          {law.numero}{law.anno ? `/${law.anno}` : ''}
                        </Link>
                      ) : (
                        <span>{law.numero ?? '—'}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {t.parlamento.legislatura.citazioniLabel(law.n)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
