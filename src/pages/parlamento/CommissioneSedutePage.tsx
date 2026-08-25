import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { BetaNotice } from '@/components/BetaNotice'
import { Pagination } from '@/components/Pagination'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import {
  commissioneSedutaUrl,
  fetchCommissioneSedute,
  type Seduta,
} from '@/services/parlamento'
import { parsePositiveInt } from '@/lib/parlamento-params'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n/it'

const PAGE_SIZE = 30

// One committee's sittings, newest first.
//
// Rows link by document scope (the record-id suffix carried in `id`) rather
// than by numero: committee resoconti are numbered per-committee AND per
// inquiry, so the same number recurs many times within one committee.


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

  const query = useQuery(
    ['parlamento/commissione/sedute', slug, page] as const,
    () => fetchCommissioneSedute(slug, { page, pageSize: PAGE_SIZE }),
    { ttlMs: 5 * 60 * 1000 },
  )

  const rows = query.data?.data ?? []
  const total = query.data?.total ?? 0
  const nome = rows[0]?.organo_nome ?? slug
  const isSommario = rows[0]?.tipo_resoconto === 'sommario'

  function goToPage(next: number) {
    const p = new URLSearchParams(searchParams)
    p.set('page', String(next))
    setSearchParams(p)
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

      {query.status === 'loading' ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t.parlamento.commissioni.emptySedute}</CardTitle>
          </CardHeader>
        </Card>
      ) : (
        <>
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
                    ) : null}
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
            onPageChange={goToPage}
            totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
            total={total}
            isFetching={query.isFetching}
          />
        </>
      )}
    </div>
  )
}
