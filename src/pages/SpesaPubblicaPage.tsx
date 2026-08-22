import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ExternalLink } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SourceLink } from '@/components/SourceLink'
import { Stat, StatStrip } from '@/components/PageStats'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { t } from '@/i18n/it'
import { formatEUR, formatNumber, formatPercent } from '@/lib/format'
import { useQuery } from '@/hooks/useQuery'
import {
  fetchSpesaPubblica,
  fetchSpesaPubblicaByMissione,
  fetchSpesaPubblicaKpis,
  type SpesaPubblicaKpis,
  type SpesaPubblicaMissioneAgg,
  type SpesaPubblicaRow,
} from '@/services/spesaPubblica'

const PAGE_SIZE = 10

const chartConfig = {
  quota: {
    label: 'Quota sul totale',
    color: 'var(--chart-1)',
  },
} satisfies ChartConfig

// -----------------------------------------------------------------------------
// Page stats strip
// -----------------------------------------------------------------------------

function KpiSection({
  kpis,
  loading,
}: {
  kpis: SpesaPubblicaKpis | null
  loading: boolean
}) {
  // Top mission is the single biggest functional spending category. We
  // show the name + its share of the total as a combined KPI.
  const topValue =
    kpis?.topMissione != null && kpis.totalePagato > 0
      ? `${formatPercent(kpis.topMissione.totale / kpis.totalePagato)}`
      : '--'
  const topName = kpis?.topMissione?.nome ?? ''
  const averageValue =
    kpis != null && kpis.totalCount > 0
      ? formatEUR(kpis.totalePagato / kpis.totalCount)
      : '--'
  // The year-to-date snapshot only exists while a year is in progress: when
  // BDAP's newest package is a December, annual and YTD are the same file and
  // the backend reports `progressivo: null`.
  const ytd = kpis?.progressivo ?? null

  return (
    <StatStrip ariaLabel={t.sections.spesaPubblica.title}>
      <Stat
        label={t.spesaPubblica.kpis.totalePagatoTitle}
        value={kpis ? formatEUR(kpis.totalePagato) : '--'}
        finding={t.spesaPubblica.kpis.totalePagatoFinding(
          kpis?.anno ?? null,
          kpis?.totalCount ?? 0,
        )}
        loading={loading}
      />
      {ytd ? (
        <Stat
          label={t.spesaPubblica.kpis.progressivoTitle}
          value={formatEUR(ytd.totalePagato)}
          finding={t.spesaPubblica.kpis.progressivoFinding(ytd.anno, ytd.meseContabile)}
          loading={loading}
        />
      ) : null}
      <Stat
        label={t.spesaPubblica.kpis.topMissioneTitle}
        value={topValue}
        finding={topName ? `${topName}. ${t.spesaPubblica.kpis.topMissioneFinding}` : t.spesaPubblica.kpis.topMissioneFinding}
        loading={loading}
      />
      <Stat
        label={t.spesaPubblica.kpis.totalCountTitle}
        value={kpis ? formatNumber(kpis.totalCount) : '--'}
        finding={t.spesaPubblica.kpis.totalCountFinding}
        loading={loading}
      />
      <Stat
        label={t.spesaPubblica.kpis.averageTitle}
        value={averageValue}
        finding={t.spesaPubblica.kpis.averageFinding}
        loading={loading}
      />
    </StatStrip>
  )
}

// -----------------------------------------------------------------------------
// Missioni bar chart
// -----------------------------------------------------------------------------

function truncateLabel(raw: string | null, max = 38): string {
  if (!raw) return ''
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}...`
}

function MissioniChartCard({
  rows,
  loading,
  anno,
}: {
  rows: SpesaPubblicaMissioneAgg[]
  loading: boolean
  anno: number | null
}) {
  const isMobile = useIsMobile()
  // Prepare chart rows: one per mission in the snapshot (usually 34, fewer in
  // an early-year one), use truncated labels so the YAxis stays readable, keep
  // the full name in the tooltip. Quota is already a 0-1 fraction so we pass
  // it through to the bar dataKey.
  const chartRows = rows.map((r) => ({
    label: truncateLabel(r.missione, isMobile ? 20 : 42),
    fullMissione: r.missione,
    codice: r.codice,
    quota: r.quota,
    totalePagato: r.totalePagato,
  }))

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.spesaPubblica.missioniChart.title(anno)}</CardTitle>
        <CardDescription>
          {t.spesaPubblica.missioniChart.subtitle(rows.length)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[620px] w-full max-h-[80svh] sm:h-[780px]" />
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[620px] w-full max-h-[80svh] sm:h-[780px]">
            <BarChart
              accessibilityLayer
              data={chartRows}
              layout="vertical"
              margin={{ left: 12, right: 24, top: 8, bottom: 8 }}
            >
              <CartesianGrid horizontal={false} strokeDasharray="3 3" />
              <XAxis
                type="number"
                domain={[0, 'dataMax']}
                tickFormatter={(value) => formatPercent(value as number)}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                dataKey="label"
                type="category"
                width={isMobile ? 130 : 280}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: isMobile ? 10 : 11 }}
                interval={0}
              />
              <ChartTooltip
                cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
                content={
                  <ChartTooltipContent
                    labelFormatter={(_label, payload) => {
                      const p = payload?.[0]?.payload as
                        | {
                            fullMissione: string | null
                            codice: string | null
                          }
                        | undefined
                      if (!p) return ''
                      return `${p.codice ?? ''} -- ${p.fullMissione ?? ''}`
                    }}
                    formatter={(value, _name, item) => {
                      const row = item.payload as (typeof chartRows)[number]
                      return (
                        <div className="flex w-full flex-col gap-1">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Totale</span>
                            <span className="font-mono font-medium tabular-nums text-foreground">
                              {formatEUR(row.totalePagato)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">{t.common.chartShare}</span>
                            <span className="font-mono font-medium tabular-nums text-foreground">
                              {formatPercent(Number(value))}
                            </span>
                          </div>
                        </div>
                      )
                    }}
                  />
                }
              />
              <Bar
                dataKey="quota"
                name="quota"
                fill="var(--color-quota)"
                radius={0}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        <SourceLink label={t.spesaPubblica.source} url={t.spesaPubblica.sourceUrl} />
      </CardFooter>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Paginated table
// -----------------------------------------------------------------------------

function ListTableCard({
  rows,
  loading,
  total,
  page,
  onPageChange,
  grandTotal,
  anno,
}: {
  rows: SpesaPubblicaRow[]
  loading: boolean
  total: number
  page: number
  onPageChange: (page: number) => void
  grandTotal: number
  anno: number | null
}) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const start = (page - 1) * PAGE_SIZE
  const end = Math.min(start + PAGE_SIZE, total)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.spesaPubblica.table.title}</CardTitle>
        <CardDescription>{t.spesaPubblica.table.subtitle(anno)}</CardDescription>
      </CardHeader>
      <CardContent className="px-0 sm:px-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="hidden w-16 sm:table-cell">
                {t.spesaPubblica.table.columns.codice}
              </TableHead>
              <TableHead>{t.spesaPubblica.table.columns.missione}</TableHead>
              <TableHead className="text-right">
                {t.spesaPubblica.table.columns.totalePagato}
              </TableHead>
              <TableHead className="hidden text-right md:table-cell">
                {t.spesaPubblica.table.columns.quota}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0
              ? Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    <TableCell className="hidden sm:table-cell">
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : rows.map((row) => {
                  const quota =
                    grandTotal > 0 && row.totalePagato != null
                      ? row.totalePagato / grandTotal
                      : 0
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                        {row.codice ?? '--'}
                      </TableCell>
                      <TableCell className="max-w-xl">
                        <div className="font-medium text-foreground whitespace-normal">
                          {row.missione ?? '--'}
                        </div>
                        <div className="text-xs text-muted-foreground md:hidden">
                          {formatPercent(quota)} del totale
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatEUR(row.totalePagato ?? 0)}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">
                        {formatPercent(quota)}
                      </TableCell>
                    </TableRow>
                  )
                })}
          </TableBody>
        </Table>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <a
            className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
            href={t.spesaPubblica.sourceUrl}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
            {t.common.viewSource}
          </a>
        </div>
        <div className="flex items-center gap-3">
          <span>
            {total > 0
              ? `${formatNumber(start + 1)}-${formatNumber(end)} ${t.spesaPubblica.table.of} ${formatNumber(total)}`
              : t.common.noData}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || loading}
              onClick={() => onPageChange(page - 1)}
              className="pointer-coarse:h-11 pointer-coarse:px-3"
            >
              {t.spesaPubblica.table.previous}
            </Button>
            <span className="px-2">
              {t.spesaPubblica.table.pageLabel} {formatNumber(page)}{' '}
              {t.spesaPubblica.table.of} {formatNumber(pageCount)}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pageCount || loading}
              onClick={() => onPageChange(page + 1)}
              className="pointer-coarse:h-11 pointer-coarse:px-3"
            >
              {t.spesaPubblica.table.next}
            </Button>
          </div>
        </div>
      </CardFooter>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Error state
// -----------------------------------------------------------------------------

function ErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.spesaPubblica.errorTitle}</CardTitle>
        <CardDescription>{t.spesaPubblica.errorBody}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{error.message}</span>
        </p>
      </CardContent>
      <CardFooter>
        <Button size="sm" onClick={onRetry}>
          {t.spesaPubblica.retry}
        </Button>
      </CardFooter>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default function SpesaPubblicaPage() {
  const [page, setPage] = useState(1)

  const kpisQuery = useQuery(['spesa/kpis'], () => fetchSpesaPubblicaKpis())
  const byMissioneQuery = useQuery(['spesa/by-missione'], () => fetchSpesaPubblicaByMissione())
  const listQuery = useQuery(['spesa/list', page], () =>
    fetchSpesaPubblica({
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  )

  const pageHasFatalError =
    kpisQuery.status === 'error' &&
    byMissioneQuery.status === 'error' &&
    listQuery.status === 'error'

  // Coverage of the annual snapshot, resolved server-side from the BDAP
  // package name. Every caption on this page derives its year from here.
  const anno = kpisQuery.data?.data.anno ?? null
  const ytd = kpisQuery.data?.data.progressivo ?? null

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {t.sections.spesaPubblica.title}
          </h1>
          {/* The headline figures are a full calendar year, so the badge must
              read as a year. Showing "dicembre 2025" here (the accounting
              month of the snapshot that happens to carry the yearly total)
              reads as a monthly figure and is exactly the kind of label that
              made the earlier wrong number look plausible. */}
          <Badge variant="outline">
            {anno != null ? String(anno) : t.spesaPubblica.dataYearBadgeFallback}
          </Badge>
          {ytd?.anno != null && ytd.meseContabile ? (
            <Badge variant="secondary">
              {t.spesaPubblica.ytdBadge(ytd.anno, ytd.meseContabile)}
            </Badge>
          ) : null}
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.spesaPubblica.pageSubtitle}
        </p>
      </header>

      {pageHasFatalError ? (
        <ErrorState
          error={kpisQuery.error ?? new Error('Unknown')}
          onRetry={() => {
            kpisQuery.refetch()
            byMissioneQuery.refetch()
            listQuery.refetch()
          }}
        />
      ) : (
        <>
          {/* Page-level structural variation: this page leads with the
              missioni chart -- the headline finding -- and treats the
              KPI strip as the *summary* of that picture rather than a
              teaser above it. The other data pages put the strip first;
              here it functions as a caption. */}
          <MissioniChartCard
            rows={byMissioneQuery.data?.data ?? []}
            loading={byMissioneQuery.status === 'loading'}
            anno={byMissioneQuery.data?.anno ?? anno}
          />
          <KpiSection
            kpis={kpisQuery.data?.data ?? null}
            loading={kpisQuery.status === 'loading'}
          />
          <ListTableCard
            rows={listQuery.data?.data ?? []}
            loading={listQuery.status === 'loading'}
            total={listQuery.data?.pagination.total ?? 0}
            page={page}
            onPageChange={setPage}
            grandTotal={kpisQuery.data?.data.totalePagato ?? 0}
            anno={listQuery.data?.anno ?? anno}
          />
        </>
      )}
    </div>
  )
}
