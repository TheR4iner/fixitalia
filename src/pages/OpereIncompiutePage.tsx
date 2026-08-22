import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ExternalLink, X } from 'lucide-react'

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
  fetchOpereIncompiute,
  fetchOpereIncompiuteByRegion,
  fetchOpereIncompiuteKpis,
  type OpereIncompiuteKpis,
  type OpereIncompiuteRegionAgg,
  type OperaIncompiuta,
} from '@/services/opereIncompiute'

const PAGE_SIZE = 10

const chartConfig = {
  count: {
    label: 'Opere incompiute',
    color: 'var(--chart-1)',
  },
} satisfies ChartConfig

function KpiSection({
  kpis,
  loading,
}: {
  kpis: OpereIncompiuteKpis | null
  loading: boolean
}) {
  return (
    <StatStrip ariaLabel={t.sections.opereIncompiute.title}>
      <Stat
        label={t.opereIncompiute.kpis.totalCountTitle}
        value={kpis ? formatNumber(kpis.totalCount) : '--'}
        finding={t.opereIncompiute.kpis.totalCountFinding}
        loading={loading}
      />
      <Stat
        label={t.opereIncompiute.kpis.totalInterventoTitle}
        value={kpis ? formatEUR(kpis.totalIntervento) : '--'}
        finding={t.opereIncompiute.kpis.totalInterventoFinding}
        loading={loading}
      />
      <Stat
        label={t.opereIncompiute.kpis.totalOneriTitle}
        value={kpis ? formatEUR(kpis.totalOneri) : '--'}
        finding={t.opereIncompiute.kpis.totalOneriFinding}
        loading={loading}
      />
      <Stat
        label={t.opereIncompiute.kpis.avgAvanzamentoTitle}
        value={kpis ? formatPercent(kpis.avgAvanzamento / 100) : '--'}
        finding={t.opereIncompiute.kpis.avgAvanzamentoFinding}
        loading={loading}
      />
    </StatStrip>
  )
}

// Borderless editorial section. We deliberately drop the Card chrome
// here so the page does not read as a uniform stack of card panels --
// the chart functions as a figure inside the page flow, the way a
// newspaper data desk would lay it out.
function RegionalChartFigure({
  rows,
  loading,
  selected,
  onSelect,
  senzaRegione,
}: {
  rows: OpereIncompiuteRegionAgg[]
  loading: boolean
  selected: string | null
  onSelect: (regione: string | null) => void
  /** Works the source file left without a region; excluded from the bars. */
  senzaRegione: number
}) {
  const isMobile = useIsMobile()
  // Sort descending by count so the regions with the most incomplete works
  // sit at the top of the horizontal bar chart.
  const sorted = useMemo(() => [...rows].sort((a, b) => b.count - a.count), [rows])

  return (
    <section className="flex flex-col gap-4 border-t border-border/70 pt-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-heading text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
          {t.opereIncompiute.regionalChart.title}
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t.opereIncompiute.regionalChart.subtitle}
          {senzaRegione > 0
            ? ` ${t.opereIncompiute.regionalChart.excludedNote(senzaRegione)}`
            : ''}
        </p>
      </header>
      <figure className="flex flex-col gap-3">
        {loading ? (
          <Skeleton className="h-[520px] w-full max-h-[80svh]" />
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[520px] w-full max-h-[80svh]">
            <BarChart
              accessibilityLayer
              data={sorted}
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
                dataKey="regione"
                type="category"
                width={isMobile ? 100 : 140}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: isMobile ? 11 : 12 }}
              />
              <ChartTooltip
                cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
                content={
                  <ChartTooltipContent
                    formatter={(value, _name, item) => {
                      const row = item.payload as OpereIncompiuteRegionAgg
                      return (
                        <div className="flex w-full flex-col gap-1">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Opere</span>
                            <span className="font-mono font-medium tabular-nums text-foreground">
                              {formatNumber(Number(value))}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Valore</span>
                            <span className="font-mono font-medium tabular-nums text-foreground">
                              {formatEUR(row.totalIntervento)}
                            </span>
                          </div>
                        </div>
                      )
                    }}
                  />
                }
              />
              <Bar
                dataKey="count"
                name="count"
                fill="var(--color-count)"
                radius={0}
                onClick={(data) => {
                  const row = data as unknown as OpereIncompiuteRegionAgg
                  onSelect(row.regione === selected ? null : row.regione)
                }}
                style={{ cursor: 'pointer' }}
              />
            </BarChart>
          </ChartContainer>
        )}
        <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
          <SourceLink
            label={t.opereIncompiute.source}
            url={t.opereIncompiute.sourceUrl}
          />
          {selected ? (
            <Button size="xs" variant="outline" onClick={() => onSelect(null)}>
              <X aria-hidden="true" />
              {t.opereIncompiute.table.clearFilter}
            </Button>
          ) : null}
        </figcaption>
      </figure>
    </section>
  )
}

function formatPercentValue(value: number | null): string {
  if (value == null) return '--'
  // The backend exposes perc_avanzamento on a 0-100 scale (matching the
  // source CSV), so we divide by 100 before passing it to formatPercent
  // which expects a 0-1 fraction.
  return formatPercent(value / 100)
}

function ListTableCard({
  rows,
  loading,
  total,
  page,
  onPageChange,
  selectedRegion,
  onSelectRegion,
  regionOptions,
}: {
  rows: OperaIncompiuta[]
  loading: boolean
  total: number
  page: number
  onPageChange: (page: number) => void
  selectedRegion: string | null
  onSelectRegion: (regione: string | null) => void
  regionOptions: string[]
}) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const start = (page - 1) * PAGE_SIZE
  const end = Math.min(start + PAGE_SIZE, total)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.opereIncompiute.table.title}</CardTitle>
        <CardDescription>{t.opereIncompiute.table.subtitle}</CardDescription>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label
            htmlFor="opere-region-filter"
            className="text-xs text-muted-foreground"
          >
            {t.opereIncompiute.table.regionFilterLabel}
          </label>
          <select
            id="opere-region-filter"
            value={selectedRegion ?? ''}
            onChange={(e) => onSelectRegion(e.target.value || null)}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm text-foreground transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:px-3"
          >
            <option value="">{t.opereIncompiute.table.allRegions}</option>
            {regionOptions.map((regione) => (
              <option key={regione} value={regione}>
                {regione}
              </option>
            ))}
          </select>
          {selectedRegion ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onSelectRegion(null)}
              className="pointer-coarse:h-11"
            >
              <X aria-hidden="true" />
              {t.opereIncompiute.table.clearFilter}
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="px-0 sm:px-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.opereIncompiute.table.columns.titolo}</TableHead>
              <TableHead className="hidden lg:table-cell">
                {t.opereIncompiute.table.columns.stazioneAppaltante}
              </TableHead>
              <TableHead className="hidden md:table-cell">
                {t.opereIncompiute.table.columns.provincia}
              </TableHead>
              <TableHead className="hidden sm:table-cell">
                {t.opereIncompiute.table.columns.regione}
              </TableHead>
              <TableHead className="text-right">
                {t.opereIncompiute.table.columns.importoIntervento}
              </TableHead>
              <TableHead className="hidden text-right md:table-cell">
                {t.opereIncompiute.table.columns.importoOneri}
              </TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                {t.opereIncompiute.table.columns.percAvanzamento}
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
                    <TableCell className="hidden lg:table-cell">
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
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
                    <TableCell className="hidden sm:table-cell">
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-sm">
                      <div className="font-medium text-foreground whitespace-normal">
                        {row.titolo ?? '--'}
                      </div>
                      <div className="text-xs text-muted-foreground sm:hidden">
                        {[row.regione, row.provincia].filter(Boolean).join(' · ') || ''}
                        {row.percAvanzamento != null ? (
                          <>
                            {' · '}
                            {formatPercentValue(row.percAvanzamento)} avanzamento
                          </>
                        ) : null}
                      </div>
                      {row.stato ? (
                        <div className="truncate text-xs text-muted-foreground">
                          {row.stato}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden max-w-xs truncate text-muted-foreground lg:table-cell">
                      {row.stazioneAppaltante ?? '--'}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {row.provincia ?? '--'}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {row.regione ?? '--'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatEUR(row.importoIntervento ?? 0)}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">
                      {formatEUR(row.importoOneri ?? 0)}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">
                      {formatPercentValue(row.percAvanzamento)}
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <a
            className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
            href="https://dati.mit.gov.it/catalog/dataset/opere-incompiute"
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
              ? `${formatNumber(start + 1)}-${formatNumber(end)} ${t.opereIncompiute.table.of} ${formatNumber(total)}`
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
              {t.opereIncompiute.table.previous}
            </Button>
            <span className="px-2">
              {t.opereIncompiute.table.pageLabel} {formatNumber(page)}{' '}
              {t.opereIncompiute.table.of} {formatNumber(pageCount)}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pageCount || loading}
              onClick={() => onPageChange(page + 1)}
              className="pointer-coarse:h-11 pointer-coarse:px-3"
            >
              {t.opereIncompiute.table.next}
            </Button>
          </div>
        </div>
      </CardFooter>
    </Card>
  )
}

function ErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.opereIncompiute.errorTitle}</CardTitle>
        <CardDescription>{t.opereIncompiute.errorBody}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{error.message}</span>
        </p>
      </CardContent>
      <CardFooter>
        <Button size="sm" onClick={onRetry}>
          {t.opereIncompiute.retry}
        </Button>
      </CardFooter>
    </Card>
  )
}

export default function OpereIncompiutePage() {
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const kpisQuery = useQuery(['opere/kpis'], () => fetchOpereIncompiuteKpis())
  const byRegionQuery = useQuery(['opere/by-region'], () => fetchOpereIncompiuteByRegion())
  const listQuery = useQuery(['opere/list', selectedRegion, page], () =>
    fetchOpereIncompiute({
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      regione: selectedRegion ?? undefined,
    }),
  )

  // Only show the hard error screen when no query has ever loaded any
  // data. As soon as any cached data is available the page renders and a
  // transient refetch failure stays silent (handled inside the hook).
  const pageHasFatalError =
    kpisQuery.status === 'error' &&
    byRegionQuery.status === 'error' &&
    listQuery.status === 'error'

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {t.sections.opereIncompiute.title}
          </h1>
          <Badge variant="outline">
            {kpisQuery.data?.data.annoRiferimento != null
              ? `${t.opereIncompiute.dataYearBadgePrefix} ${kpisQuery.data.data.annoRiferimento}`
              : t.opereIncompiute.dataYearBadgeFallback}
          </Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.opereIncompiute.pageSubtitle}
        </p>
      </header>

      {pageHasFatalError ? (
        <ErrorState
          error={kpisQuery.error ?? new Error('Unknown')}
          onRetry={() => {
            kpisQuery.refetch()
            byRegionQuery.refetch()
            listQuery.refetch()
          }}
        />
      ) : (
        <>
          <KpiSection
            kpis={kpisQuery.data?.data ?? null}
            loading={kpisQuery.status === 'loading'}
          />
          <RegionalChartFigure
            rows={byRegionQuery.data?.data ?? []}
            senzaRegione={byRegionQuery.data?.senzaRegione ?? 0}
            loading={byRegionQuery.status === 'loading'}
            selected={selectedRegion}
            onSelect={(regione) => {
              setSelectedRegion(regione)
              setPage(1)
            }}
          />
          <ListTableCard
            rows={listQuery.data?.data ?? []}
            loading={listQuery.status === 'loading'}
            total={listQuery.data?.pagination.total ?? 0}
            page={page}
            onPageChange={setPage}
            selectedRegion={selectedRegion}
            onSelectRegion={(regione) => {
              setSelectedRegion(regione)
              setPage(1)
            }}
            regionOptions={
              (byRegionQuery.data?.data ?? [])
                .map((r) => r.regione)
                .filter((r): r is string => typeof r === 'string' && r.length > 0)
                .sort((a, b) => a.localeCompare(b, 'it'))
            }
          />
        </>
      )}
    </div>
  )
}
