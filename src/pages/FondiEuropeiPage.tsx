import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from 'recharts'
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
import { formatBadgeDate, formatEUR, formatNumber, formatPercent } from '@/lib/format'
import { useQuery } from '@/hooks/useQuery'
import {
  fetchFondiEuropeiByRegione,
  fetchFondiEuropeiByStato,
  fetchFondiEuropeiByTema,
  fetchFondiEuropeiKpis,
  fetchFondiEuropeiYearly,
  type FondiEuropeiKpis,
  type FondiEuropeiRegione,
  type FondiEuropeiStato,
  type FondiEuropeiTema,
  type FondiEuropeiYearly,
} from '@/services/fondiEuropei'

// -----------------------------------------------------------------------------
// Chart configs
// -----------------------------------------------------------------------------

const barChartConfig = {
  value: {
    label: 'Valore',
    color: 'var(--chart-1)',
  },
} satisfies ChartConfig

// Two-series yearly chart: "Pagamenti" (actually paid) is the reference
// value rendered in the institutional olive primary; "Impegni" (the
// promise) is the comparison rendered in the warm ochre accent. The
// visual gap between olive and ochre reads as the gap between
// "promised" and "delivered" without any extra labelling.
const yearlyChartConfig = {
  impegni: {
    label: t.fondiEuropei.yearlyChart.impegniLabel,
    color: 'var(--chart-accent)',
  },
  pagamenti: {
    label: t.fondiEuropei.yearlyChart.pagamentiLabel,
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
  kpis: FondiEuropeiKpis | null
  loading: boolean
}) {
  return (
    <StatStrip ariaLabel={t.sections.fondiEuropei.title}>
      <Stat
        label={t.fondiEuropei.kpis.costoPubblicoTitle}
        value={kpis ? formatEUR(kpis.costoPubblico) : '--'}
        finding={t.fondiEuropei.kpis.costoPubblicoFinding}
        loading={loading}
      />
      <Stat
        label={t.fondiEuropei.kpis.pagamentiTitle}
        value={kpis ? formatEUR(kpis.pagamenti) : '--'}
        finding={t.fondiEuropei.kpis.pagamentiFinding}
        loading={loading}
      />
      <Stat
        label={t.fondiEuropei.kpis.quotaTitle}
        value={kpis ? formatPercent(kpis.quotaPagata) : '--'}
        finding={t.fondiEuropei.kpis.quotaFinding}
        loading={loading}
      />
      <Stat
        label={t.fondiEuropei.kpis.progettiTitle}
        value={kpis ? formatNumber(kpis.progetti) : '--'}
        finding={t.fondiEuropei.kpis.progettiFinding}
        loading={loading}
      />
    </StatStrip>
  )
}

// -----------------------------------------------------------------------------
// Project status breakdown card
// -----------------------------------------------------------------------------

function StatiCard({
  rows,
  total,
  loading,
}: {
  rows: FondiEuropeiStato[]
  total: number
  loading: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.fondiEuropei.statiChart.title}</CardTitle>
        <CardDescription>{t.fondiEuropei.statiChart.subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((row) => {
              const quota = row.quotaProgetti
              return (
                <div key={row.codice ?? row.nome ?? ''} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {row.nome ?? '--'}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatNumber(row.progetti)} progetti
                      </span>
                    </div>
                    <span className="font-mono text-sm font-medium tabular-nums text-foreground">
                      {formatPercent(quota)}
                    </span>
                  </div>
                  <div
                    className="h-2 w-full overflow-hidden rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(100, Math.max(0, quota * 100))}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatEUR(row.costoPubblico)} stanziati, {formatEUR(row.pagamenti)} pagati
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {total > 0 ? <span>{`${formatNumber(total)} progetti totali.`}</span> : null}
        <SourceLink label={t.fondiEuropei.source} url={t.fondiEuropei.sourceUrl} />
      </CardFooter>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Yearly timeline chart
// -----------------------------------------------------------------------------

function YearlyChartCard({
  rows,
  loading,
}: {
  rows: FondiEuropeiYearly[]
  loading: boolean
}) {
  // Filter out years before 2000 which are mostly noise from the legacy
  // pre-EU cycles; the useful signal is from 2000 onward when the
  // modern cohesion policy cycles began.
  const filtered = useMemo(
    () => rows.filter((r) => (r.anno ?? 0) >= 2000),
    [rows],
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.fondiEuropei.yearlyChart.title}</CardTitle>
        <CardDescription>{t.fondiEuropei.yearlyChart.subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[360px] w-full max-h-[80svh]" />
        ) : (
          <ChartContainer config={yearlyChartConfig} className="aspect-auto h-[360px] w-full max-h-[80svh]">
            <AreaChart
              accessibilityLayer
              data={filtered}
              margin={{ left: 12, right: 24, top: 8, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="anno"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11 }}
                tickFormatter={(value) => String(value)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11 }}
                tickFormatter={(value) => {
                  const n = value as number
                  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(0)} mld`
                  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)} mln`
                  return formatNumber(n)
                }}
                width={60}
              />
              <ChartTooltip
                cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
                content={
                  <ChartTooltipContent
                    labelFormatter={(label) => String(label)}
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-3">
                        <span className="text-muted-foreground">
                          {yearlyChartConfig[name as keyof typeof yearlyChartConfig]?.label ??
                            name}
                        </span>
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {formatEUR(Number(value))}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Area
                type="monotone"
                dataKey="impegni"
                stroke="var(--color-impegni)"
                fill="var(--color-impegni)"
                fillOpacity={0.15}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="pagamenti"
                stroke="var(--color-pagamenti)"
                fill="var(--color-pagamenti)"
                fillOpacity={0.25}
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        <SourceLink label={t.fondiEuropei.source} url={t.fondiEuropei.sourceUrl} />
      </CardFooter>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Horizontal bar chart (used for both temi and regioni)
// -----------------------------------------------------------------------------

interface HorizontalBarCardProps {
  title: string
  subtitle: string
  rows: Array<{
    label: string
    value: number
    quota?: number
    secondary?: number
  }>
  loading: boolean
  height?: number
}

function truncateLabel(raw: string, max: number): string {
  if (!raw) return ''
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}...`
}

function HorizontalBarCard({
  title,
  subtitle,
  rows,
  loading,
  height = 420,
}: HorizontalBarCardProps) {
  const isMobile = useIsMobile()
  const labelWidth = isMobile ? 110 : 180
  const displayRows = isMobile
    ? rows.map((r) => ({ ...r, label: truncateLabel(r.label, 20) }))
    : rows
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="w-full max-h-[80svh]" style={{ height: `${height}px` }} />
        ) : (
          <ChartContainer
            config={barChartConfig}
            className="aspect-auto w-full max-h-[80svh]"
            style={{ height: `${height}px` }}
          >
            <BarChart
              accessibilityLayer
              data={displayRows}
              layout="vertical"
              margin={{ left: 12, right: 24, top: 8, bottom: 8 }}
            >
              <CartesianGrid horizontal={false} strokeDasharray="3 3" />
              <XAxis
                type="number"
                tickFormatter={(value) => {
                  const n = value as number
                  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(0)} mld`
                  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)} mln`
                  return formatNumber(n)
                }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                dataKey="label"
                type="category"
                width={labelWidth}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11 }}
                interval={0}
              />
              <ChartTooltip
                cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
                content={
                  <ChartTooltipContent
                    labelFormatter={(label) => String(label)}
                    formatter={(value, _name, item) => {
                      const row = item.payload as {
                        value: number
                        secondary?: number
                        quota?: number
                      }
                      return (
                        <div className="flex w-full flex-col gap-1">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Valore</span>
                            <span className="font-mono font-medium tabular-nums text-foreground">
                              {formatEUR(Number(value))}
                            </span>
                          </div>
                          {row.secondary != null ? (
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">Erogato</span>
                              <span className="font-mono font-medium tabular-nums text-foreground">
                                {formatEUR(row.secondary)}
                              </span>
                            </div>
                          ) : null}
                          {row.quota != null ? (
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">{t.common.chartShare}</span>
                              <span className="font-mono font-medium tabular-nums text-foreground">
                                {formatPercent(row.quota)}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      )
                    }}
                  />
                }
              />
              <Bar dataKey="value" fill="var(--color-value)" radius={0} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        <SourceLink label={t.fondiEuropei.source} url={t.fondiEuropei.sourceUrl} />
      </CardFooter>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Regions table
// -----------------------------------------------------------------------------

function RegioniTable({
  rows,
  loading,
}: {
  rows: FondiEuropeiRegione[]
  loading: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.fondiEuropei.regioniTable.title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 sm:px-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.fondiEuropei.regioniTable.columns.nome}</TableHead>
              <TableHead className="text-right">
                {t.fondiEuropei.regioniTable.columns.costoPubblico}
              </TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                {t.fondiEuropei.regioniTable.columns.pagamenti}
              </TableHead>
              <TableHead className="text-right">
                {t.fondiEuropei.regioniTable.columns.quota}
              </TableHead>
              <TableHead className="hidden text-right md:table-cell">
                {t.fondiEuropei.regioniTable.columns.progetti}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0
              ? Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    <TableCell>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
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
              : rows.map((row) => (
                  <TableRow key={row.codice ?? row.nome ?? ''}>
                    <TableCell className="font-medium text-foreground">
                      {row.nome ?? '--'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatEUR(row.costoPubblico)}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
                      {formatEUR(row.pagamenti)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(row.quotaPagata)}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">
                      {formatNumber(row.progetti)}
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <a
          className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
          href="https://opencoesione.gov.it/it/opendata/"
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLink aria-hidden="true" className="size-3.5" />
          {t.common.viewSource}
        </a>
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
        <CardTitle>{t.fondiEuropei.errorTitle}</CardTitle>
        <CardDescription>{t.fondiEuropei.errorBody}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{error.message}</span>
        </p>
      </CardContent>
      <CardFooter>
        <Button size="sm" onClick={onRetry}>
          {t.fondiEuropei.retry}
        </Button>
      </CardFooter>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default function FondiEuropeiPage() {
  const kpisQuery = useQuery(['fondi/kpis'], () => fetchFondiEuropeiKpis())
  const regioniQuery = useQuery(['fondi/by-regione'], () => fetchFondiEuropeiByRegione())
  const temiQuery = useQuery(['fondi/by-tema'], () => fetchFondiEuropeiByTema())
  const yearlyQuery = useQuery(['fondi/yearly'], () => fetchFondiEuropeiYearly())
  const statiQuery = useQuery(['fondi/by-stato'], () => fetchFondiEuropeiByStato())

  const pageHasFatalError =
    kpisQuery.status === 'error' &&
    regioniQuery.status === 'error' &&
    temiQuery.status === 'error' &&
    yearlyQuery.status === 'error' &&
    statiQuery.status === 'error'

  const temiChartRows = useMemo(() => {
    const rows = temiQuery.data?.data ?? []
    return rows.map((r: FondiEuropeiTema) => ({
      label: r.nome ?? '',
      value: r.costoPubblico,
      secondary: r.pagamenti,
      quota: r.quotaPagata,
    }))
  }, [temiQuery.data])

  const regioniChartRows = useMemo(() => {
    const rows = regioniQuery.data?.data ?? []
    return rows.map((r: FondiEuropeiRegione) => ({
      label: r.nome ?? '',
      value: r.costoPubblico,
      secondary: r.pagamenti,
      quota: r.quotaPagata,
    }))
  }, [regioniQuery.data])

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {t.sections.fondiEuropei.title}
          </h1>
          <Badge variant="outline">
            {(() => {
              const formatted = formatBadgeDate(kpisQuery.data?.data.dataAggiornamento)
              return formatted
                ? `${t.fondiEuropei.dataBadgePrefix} ${formatted}`
                : t.fondiEuropei.dataBadgeFallback
            })()}
          </Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.fondiEuropei.pageSubtitle}
        </p>
      </header>

      {pageHasFatalError ? (
        <ErrorState
          error={kpisQuery.error ?? new Error('Unknown')}
          onRetry={() => {
            kpisQuery.refetch()
            regioniQuery.refetch()
            temiQuery.refetch()
            yearlyQuery.refetch()
            statiQuery.refetch()
          }}
        />
      ) : (
        <>
          <KpiSection
            kpis={kpisQuery.data?.data ?? null}
            loading={kpisQuery.status === 'loading'}
          />
          <StatiCard
            rows={statiQuery.data?.data ?? []}
            total={statiQuery.data?.totals.progetti ?? 0}
            loading={statiQuery.status === 'loading'}
          />
          <YearlyChartCard
            rows={yearlyQuery.data?.data ?? []}
            loading={yearlyQuery.status === 'loading'}
          />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <HorizontalBarCard
              title={t.fondiEuropei.temiChart.title}
              subtitle={t.fondiEuropei.temiChart.subtitle}
              rows={temiChartRows}
              loading={temiQuery.status === 'loading'}
              height={420}
            />
            <HorizontalBarCard
              title={t.fondiEuropei.regioniChart.title}
              subtitle={t.fondiEuropei.regioniChart.subtitle}
              rows={regioniChartRows}
              loading={regioniQuery.status === 'loading'}
              height={560}
            />
          </div>
          <RegioniTable
            rows={regioniQuery.data?.data ?? []}
            loading={regioniQuery.status === 'loading'}
          />
        </>
      )}
    </div>
  )
}
