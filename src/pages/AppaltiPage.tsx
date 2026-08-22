import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'

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
import { formatNumber } from '@/lib/format'
import { useQuery } from '@/hooks/useQuery'
import {
  fetchAppaltiByNatura,
  fetchAppaltiByRegione,
  fetchAppaltiKpis,
  fetchAppaltiTopCitta,
  type AppaltiCitta,
  type AppaltiKpis,
  type AppaltiNatura,
  type AppaltiRegione,
} from '@/services/appalti'

// -----------------------------------------------------------------------------
// Chart config -- all bars share one grey theme.
// -----------------------------------------------------------------------------

const chartConfig = {
  count: {
    label: t.appalti.chartSeriesLabel,
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
  kpis: AppaltiKpis | null
  loading: boolean
}) {
  const abitantiValue =
    kpis && kpis.abitantiPerStazione > 0
      ? `${formatNumber(kpis.abitantiPerStazione)} ${t.appalti.abitantiUnit}`
      : '--'
  return (
    <StatStrip ariaLabel={t.sections.appalti.title}>
      <Stat
        label={t.appalti.kpis.attiveTitle}
        value={kpis ? formatNumber(kpis.attive) : '--'}
        finding={t.appalti.kpis.attiveFinding}
        loading={loading}
      />
      <Stat
        label={t.appalti.kpis.abitantiTitle}
        value={abitantiValue}
        finding={t.appalti.kpis.abitantiFinding}
        loading={loading}
      />
      <Stat
        label={t.appalti.kpis.categorieTitle}
        value={kpis ? formatNumber(kpis.categorieGiuridiche) : '--'}
        finding={t.appalti.kpis.categorieFinding}
        loading={loading}
      />
      <Stat
        label={t.appalti.kpis.regioniTitle}
        value={kpis ? formatNumber(kpis.regioniCoperte) : '--'}
        finding={t.appalti.kpis.regioniFinding}
        loading={loading}
      />
    </StatStrip>
  )
}

// -----------------------------------------------------------------------------
// Horizontal bar chart shared by natura and regione
// -----------------------------------------------------------------------------

interface BarRow {
  label: string
  count: number
}

function truncate(raw: string | null, max = 44): string {
  if (!raw) return ''
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}...`
}

function HorizontalBarCard({
  title,
  subtitle,
  rows,
  loading,
  height,
  note,
}: {
  title: string
  subtitle: string
  rows: BarRow[]
  loading: boolean
  height: number
  /** Optional caveat rendered under the bars (e.g. rows excluded from them). */
  note?: string | null
}) {
  const isMobile = useIsMobile()
  const labelWidth = isMobile ? 110 : 200
  const truncMax = isMobile ? 22 : 46
  const mobileRows = isMobile
    ? rows.map((r) => ({ ...r, label: truncate(r.label, truncMax) }))
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
            config={chartConfig}
            className="aspect-auto w-full max-h-[80svh]"
            style={{ height: `${height}px` }}
          >
            <BarChart
              accessibilityLayer
              data={mobileRows}
              layout="vertical"
              margin={{ left: 12, right: 24, top: 8, bottom: 8 }}
            >
              <CartesianGrid horizontal={false} strokeDasharray="3 3" />
              <XAxis
                type="number"
                tickFormatter={(value) => formatNumber(value as number)}
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
                    formatter={(value) => (
                      <div className="flex w-full items-center justify-between gap-3">
                        <span className="text-muted-foreground">{t.appalti.chartSeriesLabel}</span>
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {formatNumber(Number(value))}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Bar dataKey="count" fill="var(--color-count)" radius={0} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
        {note ? <p>{note}</p> : null}
        <SourceLink label={t.appalti.source} url={t.appalti.sourceUrl} />
      </CardFooter>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Top cities table
// -----------------------------------------------------------------------------

function TopCittaCard({
  rows,
  loading,
}: {
  rows: AppaltiCitta[]
  loading: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.appalti.cittaTable.title}</CardTitle>
        <CardDescription>{t.appalti.cittaTable.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="px-0 sm:px-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">{t.appalti.cittaTable.columns.rank}</TableHead>
              <TableHead>{t.appalti.cittaTable.columns.citta}</TableHead>
              <TableHead className="hidden sm:table-cell">
                {t.appalti.cittaTable.columns.provincia}
              </TableHead>
              <TableHead className="hidden md:table-cell">
                {t.appalti.cittaTable.columns.regione}
              </TableHead>
              <TableHead className="text-right">
                {t.appalti.cittaTable.columns.count}
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
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : rows.map((row, i) => (
                  <TableRow key={`${row.citta}-${row.provincia}`}>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {i + 1}
                    </TableCell>
                    <TableCell className="font-medium text-foreground">
                      <div>{row.citta ?? '--'}</div>
                      <div className="text-xs text-muted-foreground sm:hidden">
                        {[row.provincia, row.regione].filter(Boolean).join(' · ') || '--'}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {row.provincia ?? '--'}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {row.regione ?? '--'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatNumber(row.count)}
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        <SourceLink label={t.appalti.source} url={t.appalti.sourceUrl} />
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
        <CardTitle>{t.appalti.errorTitle}</CardTitle>
        <CardDescription>{t.appalti.errorBody}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{error.message}</span>
        </p>
      </CardContent>
      <CardFooter>
        <Button size="sm" onClick={onRetry}>
          {t.appalti.retry}
        </Button>
      </CardFooter>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default function AppaltiPage() {
  const kpisQuery = useQuery(['appalti/kpis'], () => fetchAppaltiKpis())
  const naturaQuery = useQuery(['appalti/by-natura'], () => fetchAppaltiByNatura())
  const regioneQuery = useQuery(['appalti/by-regione'], () => fetchAppaltiByRegione())
  const cittaQuery = useQuery(['appalti/top-citta'], () => fetchAppaltiTopCitta(20))

  const pageHasFatalError =
    kpisQuery.status === 'error' &&
    naturaQuery.status === 'error' &&
    regioneQuery.status === 'error' &&
    cittaQuery.status === 'error'

  const naturaRows = useMemo<BarRow[]>(() => {
    const data = naturaQuery.data?.data ?? []
    return data.map((r: AppaltiNatura) => ({
      label: truncate(r.nome, 46),
      count: r.count,
    }))
  }, [naturaQuery.data])

  const regioneRows = useMemo<BarRow[]>(() => {
    const data = regioneQuery.data?.data ?? []
    return data.map((r: AppaltiRegione) => ({
      label: r.regione ?? '',
      count: r.count,
    }))
  }, [regioneQuery.data])

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {t.sections.appalti.title}
          </h1>
          <Badge variant="outline">{t.appalti.dataBadge}</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.appalti.pageSubtitle}
        </p>
      </header>

      {pageHasFatalError ? (
        <ErrorState
          error={kpisQuery.error ?? new Error('Unknown')}
          onRetry={() => {
            kpisQuery.refetch()
            naturaQuery.refetch()
            regioneQuery.refetch()
            cittaQuery.refetch()
          }}
        />
      ) : (
        <>
          <KpiSection
            kpis={kpisQuery.data?.data ?? null}
            loading={kpisQuery.status === 'loading'}
          />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <HorizontalBarCard
              title={t.appalti.naturaChart.title}
              subtitle={t.appalti.naturaChart.subtitle}
              rows={naturaRows}
              loading={naturaQuery.status === 'loading'}
              height={440}
              note={
                naturaQuery.data && naturaQuery.data.senzaNatura > 0
                  ? t.appalti.naturaChart.excludedNote(naturaQuery.data.senzaNatura)
                  : null
              }
            />
            <HorizontalBarCard
              title={t.appalti.regionalChart.title}
              subtitle={t.appalti.regionalChart.subtitle}
              rows={regioneRows}
              loading={regioneQuery.status === 'loading'}
              height={560}
              note={
                regioneQuery.data && regioneQuery.data.senzaRegione > 0
                  ? t.appalti.regionalChart.excludedNote(regioneQuery.data.senzaRegione)
                  : null
              }
            />
          </div>
          <TopCittaCard
            rows={cittaQuery.data?.data ?? []}
            loading={cittaQuery.status === 'loading'}
          />
        </>
      )}
    </div>
  )
}
