import { useMemo, useState } from 'react'
import { Cell, Pie, PieChart } from 'recharts'

import { Badge } from '@/components/ui/badge'
import { SourceLink } from '@/components/SourceLink'
import { Stat, StatStrip } from '@/components/PageStats'
import { CheckboxField, NumberField, SelectField } from '@/components/OptionField'
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
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { t } from '@/i18n/it'
import { formatEUR, formatNumber, formatPercent } from '@/lib/format'
import { useQuery } from '@/hooks/useQuery'
import {
  computeTaxBreakdown,
  totalIncomeTax,
  COEFFICIENTI_REDDITIVITA,
  DEFAULT_TAX_INPUT,
  FORFETTARIO_LIMITE_RICAVI,
  TAX_YEAR,
  type Regime,
  type TaxBreakdown,
  type TaxInput,
} from '@/lib/tax-calc'
import {
  ADDIZIONALE_COMUNALE_MAX,
  ADDIZIONALE_COMUNALE_MEDIA,
  findRegione,
  REGIONI,
} from '@/lib/tax-regions'
import {
  fetchSpesaPubblicaByMissione,
  type SpesaPubblicaMissioneAgg,
} from '@/services/spesaPubblica'

// Clamp the input so a user cannot crash the math with pathological
// values. Negative becomes zero (the calculator handles that anyway),
// and 10M is more than enough headroom for any realistic income.
const MIN_GROSS = 0
const MAX_GROSS = 10_000_000

// -----------------------------------------------------------------------------
// Chart config
// -----------------------------------------------------------------------------

// Donut slices mapped to the editorial palette:
//   netto       -- the reader's own income, the reference weight (deep olive)
//   irpef       -- taxes flowing to state spending, the emphasis slice (ochre)
//   inps        -- contributions, secondary weight (mid olive)
//   addizionali -- local levies, quiet tertiary (pale olive)
const donutConfig = {
  inps: { label: t.leTueTasse.donut.slices.inps, color: 'var(--chart-3)' },
  irpef: { label: t.leTueTasse.donut.slices.irpef, color: 'var(--chart-accent)' },
  addizionali: {
    label: t.leTueTasse.donut.slices.addizionali,
    color: 'var(--chart-5)',
  },
  netto: { label: t.leTueTasse.donut.slices.netto, color: 'var(--chart-1)' },
} satisfies ChartConfig

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Accepts "30000", "30.000", "30 000", "  30.000,00  " and returns a
// clean integer. Returns null when the input is empty; the caller can
// decide whether to fall back to the default.
function parseEuroInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const cleaned = trimmed.replace(/[^\d,.-]/g, '')
  if (!cleaned) return null
  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')
  let normalised = cleaned
  if (hasComma && hasDot) {
    const lastComma = cleaned.lastIndexOf(',')
    const lastDot = cleaned.lastIndexOf('.')
    normalised =
      lastDot > lastComma
        ? cleaned.replace(/,/g, '')
        : cleaned.replace(/\./g, '').replace(',', '.')
  } else if (hasComma) {
    const after = cleaned.length - cleaned.lastIndexOf(',') - 1
    normalised = after <= 2 ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '')
  } else if (hasDot) {
    const after = cleaned.length - cleaned.lastIndexOf('.') - 1
    normalised = after <= 2 ? cleaned : cleaned.replace(/\./g, '')
  }
  const n = Number(normalised)
  if (!Number.isFinite(n)) return null
  return Math.max(MIN_GROSS, Math.min(MAX_GROSS, Math.round(n)))
}

function grossLabel(regime: Regime): string {
  if (regime === 'pensionato') return t.leTueTasse.input.labelPensione
  if (regime === 'forfettario') return t.leTueTasse.input.labelForfettario
  return t.leTueTasse.input.label
}

// -----------------------------------------------------------------------------
// Gross input
// -----------------------------------------------------------------------------

function GrossInputCard({
  value,
  regime,
  onChange,
}: {
  value: number
  regime: Regime
  onChange: (next: number) => void
}) {
  // We keep a raw text mirror alongside the parsed numeric value so the
  // user can type freely (pause mid-word, paste "30.000,00") without
  // the input snapping to a normalised form on every keystroke.
  const [raw, setRaw] = useState<string>(formatNumber(value))

  function commit(next: string) {
    setRaw(next)
    const parsed = parseEuroInput(next)
    if (parsed != null) onChange(parsed)
  }

  const label = grossLabel(regime)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-heading text-base">{label}</CardTitle>
        <CardDescription>
          {regime === 'forfettario'
            ? t.leTueTasse.input.hintForfettario
            : t.leTueTasse.input.hint}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <span className="text-xl text-muted-foreground">EUR</span>
          <Input
            inputMode="decimal"
            type="text"
            className="h-11 max-w-48 text-lg tabular-nums"
            value={raw}
            onChange={(e) => commit(e.target.value)}
            onBlur={() => setRaw(formatNumber(value))}
            aria-label={label}
          />
        </div>
        {/* Above 85.000 EUR of revenue the regime forfettario does not apply at
            all, so every figure below it would be a 15% flat tax on an amount
            that legally cannot be in the regime. Say so instead of computing
            it silently. */}
        {regime === 'forfettario' && value > FORFETTARIO_LIMITE_RICAVI ? (
          <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground">
            {t.leTueTasse.input.oltreLimiteForfettario(FORFETTARIO_LIMITE_RICAVI)}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Options panel
// -----------------------------------------------------------------------------

const regimeOptions = [
  { value: 'dipendente', label: t.leTueTasse.opzioni.regimi.dipendente },
  { value: 'pensionato', label: t.leTueTasse.opzioni.regimi.pensionato },
  { value: 'forfettario', label: t.leTueTasse.opzioni.regimi.forfettario },
]

const regioneOptions = [
  { value: '', label: t.leTueTasse.opzioni.mediaNazionale },
  ...REGIONI.map((r) => ({ value: r.code, label: r.nome })),
]

const mensilitaOptions = [
  { value: '12', label: '12' },
  { value: '13', label: '13' },
  { value: '14', label: '14' },
]

const coefficienteOptions = COEFFICIENTI_REDDITIVITA.map((c) => ({
  value: String(c),
  label: t.leTueTasse.opzioni.coefficienti[
    String(c) as keyof typeof t.leTueTasse.opzioni.coefficienti
  ],
}))

const cassaOptions = [
  {
    value: 'gestione-separata',
    label: t.leTueTasse.opzioni.casse['gestione-separata'],
  },
  { value: 'artigiani', label: t.leTueTasse.opzioni.casse.artigiani },
  { value: 'commercianti', label: t.leTueTasse.opzioni.casse.commercianti },
]

function OptionsCard({
  input,
  onChange,
}: {
  input: TaxInput
  onChange: (next: TaxInput) => void
}) {
  const set = <K extends keyof TaxInput>(key: K, value: TaxInput[K]) =>
    onChange({ ...input, [key]: value })

  const setForfettario = <K extends keyof TaxInput['forfettario']>(
    key: K,
    value: TaxInput['forfettario'][K],
  ) => onChange({ ...input, forfettario: { ...input.forfettario, [key]: value } })

  const isForfettario = input.regime === 'forfettario'
  const isAutonomoConCassa =
    isForfettario && input.forfettario.cassa !== 'gestione-separata'

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.leTueTasse.opzioni.title}</CardTitle>
        <CardDescription>{t.leTueTasse.opzioni.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            label={t.leTueTasse.opzioni.regime}
            value={input.regime}
            options={regimeOptions}
            onChange={(v) => set('regime', v as Regime)}
          />

          {/* The forfettario pays an imposta sostitutiva that replaces
              IRPEF and both addizionali, so region and comune are
              irrelevant to it and would only mislead if shown. */}
          {!isForfettario ? (
            <>
              <SelectField
                label={t.leTueTasse.opzioni.regione}
                hint={t.leTueTasse.opzioni.regioneHint}
                value={input.regione ?? ''}
                options={regioneOptions}
                onChange={(v) => set('regione', v === '' ? null : v)}
              />
              <NumberField
                label={t.leTueTasse.opzioni.comunale}
                hint={t.leTueTasse.opzioni.comunaleHint}
                value={
                  Number(
                    (
                      (input.aliquotaComunale ?? ADDIZIONALE_COMUNALE_MEDIA) * 100
                    ).toFixed(2),
                  )
                }
                min={0}
                max={ADDIZIONALE_COMUNALE_MAX * 100}
                step={0.1}
                suffix="%"
                onChange={(v) => set('aliquotaComunale', v / 100)}
              />
              <SelectField
                label={t.leTueTasse.opzioni.mensilita}
                hint={t.leTueTasse.opzioni.mensilitaHint}
                value={String(input.mensilita)}
                options={mensilitaOptions}
                onChange={(v) => set('mensilita', Number(v) as TaxInput['mensilita'])}
              />
              <NumberField
                label={t.leTueTasse.opzioni.figli}
                hint={t.leTueTasse.opzioni.figliHint}
                value={input.figliACarico}
                min={0}
                max={10}
                step={1}
                onChange={(v) => set('figliACarico', Math.round(v))}
              />
            </>
          ) : (
            <>
              <SelectField
                label={t.leTueTasse.opzioni.coefficiente}
                value={String(input.forfettario.coefficiente)}
                options={coefficienteOptions}
                onChange={(v) => setForfettario('coefficiente', Number(v))}
              />
              <SelectField
                label={t.leTueTasse.opzioni.cassa}
                value={input.forfettario.cassa}
                options={cassaOptions}
                onChange={(v) =>
                  setForfettario('cassa', v as TaxInput['forfettario']['cassa'])
                }
              />
            </>
          )}
        </div>

        <div className="flex flex-col gap-4 border-t border-border/80 pt-5 sm:flex-row sm:flex-wrap sm:gap-8">
          {!isForfettario ? (
            <CheckboxField
              label={t.leTueTasse.opzioni.coniuge}
              hint={t.leTueTasse.opzioni.coniugeHint}
              checked={input.coniugeACarico}
              onChange={(v) => set('coniugeACarico', v)}
            />
          ) : (
            <>
              <CheckboxField
                label={t.leTueTasse.opzioni.startup}
                hint={t.leTueTasse.opzioni.startupHint}
                checked={input.forfettario.startup}
                onChange={(v) => setForfettario('startup', v)}
              />
              {isAutonomoConCassa ? (
                <CheckboxField
                  label={t.leTueTasse.opzioni.riduzione}
                  hint={t.leTueTasse.opzioni.riduzioneHint}
                  checked={input.forfettario.riduzioneContributiva}
                  onChange={(v) => setForfettario('riduzioneContributiva', v)}
                />
              ) : null}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Donut chart
// -----------------------------------------------------------------------------

interface DonutSlice {
  key: 'inps' | 'irpef' | 'addizionali' | 'netto'
  label: string
  value: number
  colorVar: string
}

/**
 * Split the gross into four non-negative slices that always sum back to
 * it. The bonus credits are netted against IRPEF first and then against
 * the addizionali, so a low earner sees their tax slices shrink rather
 * than a meaningless negative wedge.
 */
function buildSlices(b: TaxBreakdown): DonutSlice[] {
  const addizionali = b.addizionaleRegionale + b.addizionaleComunale
  const irpefSlice = Math.max(0, b.impostaNetta - b.bonus)
  const bonusResiduo = Math.max(0, b.bonus - b.impostaNetta)
  const addSlice = Math.max(0, addizionali - bonusResiduo)
  const nettoSlice = Math.max(0, b.lordo - b.contributi - irpefSlice - addSlice)

  const all: DonutSlice[] = [
    {
      key: 'inps',
      label: t.leTueTasse.donut.slices.inps,
      value: b.contributi,
      colorVar: 'var(--color-inps)',
    },
    {
      key: 'irpef',
      label: t.leTueTasse.donut.slices.irpef,
      value: irpefSlice,
      colorVar: 'var(--color-irpef)',
    },
    {
      key: 'addizionali',
      label: t.leTueTasse.donut.slices.addizionali,
      value: addSlice,
      colorVar: 'var(--color-addizionali)',
    },
    {
      key: 'netto',
      label: t.leTueTasse.donut.slices.netto,
      value: nettoSlice,
      colorVar: 'var(--color-netto)',
    },
  ]
  return all.filter((s) => s.value > 0)
}

function DonutCard({
  slices,
  lordo,
  creditoEccedente,
}: {
  slices: DonutSlice[]
  lordo: number
  /** True when the bonus credits exceed the tax due and so fall outside the ring. */
  creditoEccedente: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.leTueTasse.donut.title}</CardTitle>
        <CardDescription>{t.leTueTasse.donut.subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-5">
          <div className="md:col-span-3">
            <ChartContainer
              config={donutConfig}
              className="mx-auto aspect-square w-full max-w-[420px]"
            >
              <PieChart>
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      hideLabel
                      formatter={(value, _name, item) => {
                        const row = item.payload as DonutSlice
                        const quota = lordo > 0 ? row.value / lordo : 0
                        return (
                          <div className="flex w-full min-w-40 flex-col gap-1">
                            <span className="font-medium text-foreground">
                              {row.label}
                            </span>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">{t.common.chartAmount}</span>
                              <span className="font-mono font-medium tabular-nums text-foreground">
                                {formatEUR(Number(value))}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">{t.common.chartShare}</span>
                              <span className="font-mono font-medium tabular-nums text-foreground">
                                {formatPercent(quota)}
                              </span>
                            </div>
                          </div>
                        )
                      }}
                    />
                  }
                />
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="55%"
                  outerRadius="90%"
                  paddingAngle={1}
                  strokeWidth={1}
                >
                  {slices.map((s) => (
                    <Cell key={s.key} fill={s.colorVar} stroke="var(--background)" />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
          </div>
          <div className="flex flex-col gap-3 md:col-span-2">
            {slices.map((s) => {
              const quota = lordo > 0 ? s.value / lordo : 0
              return (
                <div key={s.key} className="flex items-start gap-3">
                  <span
                    className="mt-1.5 inline-block size-3 shrink-0 rounded-sm"
                    style={{ background: s.colorVar }}
                    aria-hidden="true"
                  />
                  <div className="flex flex-1 flex-col">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium text-foreground">
                        {s.label}
                      </span>
                      <span className="font-mono text-sm tabular-nums text-foreground">
                        {formatPercent(quota)}
                      </span>
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatEUR(s.value)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        {creditoEccedente ? (
          <p className="mt-4 text-xs text-muted-foreground">
            {t.leTueTasse.donut.notaCredito}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Line-by-line breakdown
// -----------------------------------------------------------------------------

interface DettaglioRow {
  label: string
  value: number
  /** Credits and detrazioni reduce the bill; shown with a minus sign. */
  negative?: boolean
}

function DettaglioCard({ b, input }: { b: TaxBreakdown; input: TaxInput }) {
  const d = t.leTueTasse.dettaglio
  const regione = findRegione(input.regione)

  const rows: DettaglioRow[] = []
  if (b.regime === 'forfettario') {
    rows.push(
      { label: d.contributi, value: b.contributi },
      { label: d.impostaSostitutiva, value: b.impostaNetta },
    )
  } else {
    rows.push({ label: d.contributi, value: b.contributi })
    rows.push({ label: d.impostaLorda, value: b.impostaLorda })
    rows.push({
      label:
        b.regime === 'pensionato' ? d.detrazioneRegimePensione : d.detrazioneRegime,
      value: b.dettaglio.detrazioneRegime,
      negative: true,
    })
    if (b.dettaglio.ulterioreDetrazione > 0) {
      rows.push({
        label: d.ulterioreDetrazione,
        value: b.dettaglio.ulterioreDetrazione,
        negative: true,
      })
    }
    if (b.dettaglio.detrazioneConiuge > 0) {
      rows.push({
        label: d.detrazioneConiuge,
        value: b.dettaglio.detrazioneConiuge,
        negative: true,
      })
    }
    if (b.dettaglio.detrazioneFigli > 0) {
      rows.push({
        label: d.detrazioneFigli,
        value: b.dettaglio.detrazioneFigli,
        negative: true,
      })
    }
    rows.push({ label: d.impostaNetta, value: b.impostaNetta })
    if (b.addizionaleRegionale > 0) {
      rows.push({ label: d.addizionaleRegionale, value: b.addizionaleRegionale })
    }
    if (b.addizionaleComunale > 0) {
      rows.push({ label: d.addizionaleComunale, value: b.addizionaleComunale })
    }
    if (b.dettaglio.bonusCuneo > 0) {
      rows.push({ label: d.bonusCuneo, value: b.dettaglio.bonusCuneo, negative: true })
    }
    if (b.dettaglio.trattamentoIntegrativo > 0) {
      rows.push({
        label: d.trattamentoIntegrativo,
        value: b.dettaglio.trattamentoIntegrativo,
        negative: true,
      })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{d.title}</CardTitle>
        <CardDescription>{d.subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col">
          {rows.map((row, i) => (
            <div
              key={i}
              className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2.5 last:border-b-0"
            >
              <dt className="text-sm text-muted-foreground">{row.label}</dt>
              <dd
                className={
                  'font-mono text-sm tabular-nums whitespace-nowrap ' +
                  (row.negative ? 'text-muted-foreground' : 'text-foreground')
                }
              >
                {row.negative ? '-' : ''}
                {formatEUR(row.value)}
              </dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3 mt-1">
            <dt className="text-sm font-medium text-foreground">{d.totale}</dt>
            <dd className="font-mono text-sm font-semibold tabular-nums whitespace-nowrap text-foreground">
              {formatEUR(Math.max(0, b.imposteNette))}
            </dd>
          </div>
        </dl>

        {b.imposteNette < 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">{d.creditoNetto}</p>
        ) : null}

        {b.regime !== 'forfettario' && regione.nota ? (
          <p className="mt-4 text-xs text-muted-foreground">{regione.nota}</p>
        ) : null}
      </CardContent>
      {b.regime !== 'forfettario' ? (
        <CardFooter className="text-xs text-muted-foreground">
          <SourceLink
            label={`${d.fonteRegione}: ${regione.nome}`}
            url={regione.fonte}
          />
        </CardFooter>
      ) : null}
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Missioni breakdown: "where does your income-tax slice go?"
// -----------------------------------------------------------------------------

function MissioniBreakdownCard({
  rows,
  totalIncomeTaxEuro,
  loading,
  error,
  anno,
}: {
  rows: SpesaPubblicaMissioneAgg[]
  totalIncomeTaxEuro: number
  loading: boolean
  error: Error | null
  /** Reference year of the BDAP snapshot the shares were computed from. */
  anno: number | null
}) {
  // Take top 10 missioni ordered by their quota (already sorted by backend).
  const top = rows.slice(0, 10)
  // Biggest single value drives the bar widths so the longest bar fills
  // the column and the others are proportional to it.
  const maxValue = top.length > 0 ? top[0]!.totalePagato : 1

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t.leTueTasse.missioni.title}</CardTitle>
          <CardDescription>{t.leTueTasse.missioni.subtitle(anno)}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t.leTueTasse.errorBody}</p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{error.message}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.leTueTasse.missioni.title}</CardTitle>
        <CardDescription>{t.leTueTasse.missioni.subtitle(anno)}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading && rows.length === 0 ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-muted-foreground">
              {t.leTueTasse.missioni.topMissioniPreamble}{' '}
              <span className="font-mono font-medium tabular-nums text-foreground">
                {formatEUR(totalIncomeTaxEuro)}
              </span>
            </p>
            <div className="flex flex-col gap-3">
              {top.map((row) => {
                const yourShare = totalIncomeTaxEuro * row.quota
                const widthPct = maxValue > 0 ? (row.totalePagato / maxValue) * 100 : 0
                return (
                  <div key={row.codice ?? row.missione ?? ''} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium text-foreground">
                        <span className="mr-2 font-mono text-xs text-muted-foreground">
                          {row.codice}
                        </span>
                        {row.missione}
                      </span>
                      <span className="font-mono text-sm font-medium tabular-nums whitespace-nowrap text-foreground">
                        {formatEUR(yourShare)}
                      </span>
                    </div>
                    <div
                      className="h-2 w-full overflow-hidden rounded-full bg-muted"
                      aria-hidden="true"
                    >
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, widthPct)}%` }}
                      />
                    </div>
                    <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                      <span>
                        {formatPercent(row.quota)} {t.leTueTasse.missioni.shareOfBudget}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        <SourceLink
          label={t.leTueTasse.sourceMissione}
          url={t.leTueTasse.sourceMissioneUrl}
        />
      </CardFooter>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Assunzioni card (honest disclaimer)
// -----------------------------------------------------------------------------

function AssunzioniCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.leTueTasse.assunzioni.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
          {t.leTueTasse.assunzioni.items(TAX_YEAR).map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default function LeTueTassePage() {
  const [taxInput, setTaxInput] = useState<TaxInput>(DEFAULT_TAX_INPUT)

  // Reuse the existing Spesa Pubblica endpoint we already built. No new
  // backend work is needed for this feature.
  const missioniQuery = useQuery(['spesa/by-missione'], () =>
    fetchSpesaPubblicaByMissione(),
  )

  // Pure math; no network, no effects.
  const breakdown = useMemo(() => computeTaxBreakdown(taxInput), [taxInput])
  const incomeTax = totalIncomeTax(breakdown)
  const slices = useMemo(() => buildSlices(breakdown), [breakdown])

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {t.sections.leTueTasse.title}
          </h1>
          <Badge variant="outline">{t.leTueTasse.dataBadge(TAX_YEAR)}</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.leTueTasse.pageSubtitle}
        </p>
      </header>

      <GrossInputCard
        value={taxInput.grossAnnual}
        regime={taxInput.regime}
        onChange={(grossAnnual) => setTaxInput({ ...taxInput, grossAnnual })}
      />

      <OptionsCard input={taxInput} onChange={setTaxInput} />

      <StatStrip ariaLabel={t.sections.leTueTasse.title}>
        <Stat
          label={t.leTueTasse.kpis.nettoTitle}
          value={formatEUR(breakdown.netto)}
          finding={t.leTueTasse.kpis.nettoFinding}
        />
        <Stat
          label={
            breakdown.regime === 'forfettario'
              ? t.leTueTasse.kpis.nettoMensileTitleForfettario
              : t.leTueTasse.kpis.nettoMensileTitle
          }
          value={formatEUR(breakdown.nettoMensile)}
          finding={
            breakdown.regime === 'forfettario'
              ? t.leTueTasse.kpis.nettoMensileFindingForfettario
              : t.leTueTasse.kpis.nettoMensileFinding
          }
        />
        <Stat
          label={t.leTueTasse.kpis.trattenuteTitle}
          value={formatEUR(breakdown.totaleTrattenute)}
          finding={t.leTueTasse.kpis.trattenuteFinding}
        />
        <Stat
          label={t.leTueTasse.kpis.aliquotaTitle}
          value={formatPercent(breakdown.aliquotaEffettiva)}
          finding={t.leTueTasse.kpis.aliquotaFinding}
        />
      </StatStrip>

      <DonutCard
        slices={slices}
        lordo={breakdown.lordo}
        creditoEccedente={breakdown.imposteNette < 0}
      />

      <DettaglioCard b={breakdown} input={taxInput} />

      <MissioniBreakdownCard
        rows={missioniQuery.data?.data ?? []}
        totalIncomeTaxEuro={incomeTax}
        loading={missioniQuery.status === 'loading'}
        error={missioniQuery.status === 'error' ? missioniQuery.error : null}
        anno={missioniQuery.data?.anno ?? null}
      />

      <AssunzioniCard />
    </div>
  )
}
