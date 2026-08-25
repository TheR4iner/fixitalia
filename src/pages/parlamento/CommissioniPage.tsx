import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Search } from 'lucide-react'

import { BetaNotice } from '@/components/BetaNotice'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import {
  fetchCommissioni,
  ricercaUrl,
  type Commissione,
  type CommissioniSort,
  type TipoResoconto,
} from '@/services/parlamento'
import { parseChamberParam, parseLegParam } from '@/lib/parlamento-params'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n/it'

// Committee roster.
//
// 151 committees is too many for a flat card grid to be navigable, so the
// page leads with a text filter. Filtering happens client-side on purpose:
// the whole roster is one small response, so matching is instant and does not
// re-query on every keystroke.

function periodo(c: Commissione): string | null {
  if (!c.prima || !c.ultima) return null
  return `${formatDate(c.prima)} - ${formatDate(c.ultima)}`
}

/** Fold accents so "attività" matches a typed "attivita". */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export default function CommissioniPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const chamber = parseChamberParam(searchParams.get('chamber'))
  const leg = parseLegParam(searchParams.get('leg'))
  const year = searchParams.get('year')
  const tipo = searchParams.get('tipo') as TipoResoconto | null
  const conTesto = searchParams.get('conTesto') === 'true'
  const sort = (searchParams.get('sort') ?? 'sedute') as CommissioniSort
  const [filter, setFilter] = useState('')
  const hasFilters =
    Boolean(chamber || year || tipo || conTesto) || leg != null || sort !== 'sedute'

  const query = useQuery(
    ['parlamento/commissioni', chamber, leg, year, tipo, conTesto, sort] as const,
    () =>
      fetchCommissioni({
        chamber,
        leg,
        year: year ? Number(year) : undefined,
        tipo: tipo ?? undefined,
        conTesto,
        sort,
      }),
    { ttlMs: 5 * 60 * 1000 },
  )

  const rows = useMemo(() => query.data?.data ?? [], [query.data])
  const facets = query.data?.facets ?? { anni: [], legislature: [] }
  const shown = useMemo(() => {
    // Match every typed word independently rather than the phrase as one
    // substring. Committee names are long and formal, so the words a person
    // remembers are rarely adjacent in them: "inchiesta emergenza" appears in
    // "Commissione parlamentare di inchiesta sulla gestione dell'emergenza
    // sanitaria", but not next to each other, and a substring match returns
    // nothing.
    const terms = norm(filter.trim()).split(/\s+/).filter(Boolean)
    if (terms.length === 0) return rows
    return rows.filter((c) => {
      const hay = norm(`${c.organo_nome ?? ''} ${c.organo_cod ?? ''}`)
      return terms.every((term) => hay.includes(term))
    })
  }, [rows, filter])

  function setParam(key: string, value: string | undefined) {
    const p = new URLSearchParams(searchParams)
    if (value) p.set(key, value)
    else p.delete(key)
    setSearchParams(p, { replace: true })
  }

  const chamberOptions = [
    [undefined, t.parlamento.chamberAll],
    ['camera', t.parlamento.cameraLabel],
    ['senato', t.parlamento.senatoLabel],
  ] as const

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link
          to="/parlamento"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t.parlamento.commissioni.backLabel}
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          {t.parlamento.commissioni.title}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.parlamento.commissioni.subtitle}
        </p>
      </header>

      <BetaNotice compact />

      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t.parlamento.commissioni.filterPlaceholder}
            aria-label={t.parlamento.commissioni.filterPlaceholder}
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">{t.parlamento.commissioni.chamberFilterLegend}</legend>
            {chamberOptions.map(([value, label]) => (
              <button
                key={label}
                type="button"
                onClick={() => setParam('chamber', value)}
                aria-pressed={chamber === value}
                className={
                  'rounded-md border px-3 py-1.5 text-sm transition-colors ' +
                  (chamber === value
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground')
                }
              >
                {label}
              </button>
            ))}
          </fieldset>

          <select
            value={leg == null ? '' : String(leg)}
            onChange={(e) => setParam('leg', e.target.value || undefined)}
            aria-label={t.parlamento.commissioni.legAll}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          >
            <option value="">{t.parlamento.commissioni.legAll}</option>
            {facets.legislature.map((n) => (
              <option key={n} value={n}>
                {t.parlamento.commissioni.legLabel(n)}
              </option>
            ))}
          </select>

          <select
            value={year ?? ''}
            onChange={(e) => setParam('year', e.target.value || undefined)}
            aria-label={t.parlamento.commissioni.yearAll}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          >
            <option value="">{t.parlamento.commissioni.yearAll}</option>
            {facets.anni.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>

          <select
            value={tipo ?? ''}
            onChange={(e) => setParam('tipo', e.target.value || undefined)}
            aria-label={t.parlamento.commissioni.typeAll}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          >
            <option value="">{t.parlamento.commissioni.typeAll}</option>
            <option value="stenografico">{t.parlamento.commissioni.typeSteno}</option>
            <option value="sommario">{t.parlamento.commissioni.typeSommario}</option>
          </select>

          <select
            value={sort}
            onChange={(e) => setParam('sort', e.target.value === 'sedute' ? undefined : e.target.value)}
            aria-label={t.parlamento.commissioni.sortBy}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          >
            <option value="sedute">{t.parlamento.commissioni.sortSedute}</option>
            <option value="recenti">{t.parlamento.commissioni.sortRecenti}</option>
            <option value="interventi">{t.parlamento.commissioni.sortInterventi}</option>
            <option value="nome">{t.parlamento.commissioni.sortNome}</option>
          </select>

          <button
            type="button"
            onClick={() => setParam('conTesto', conTesto ? undefined : 'true')}
            aria-pressed={conTesto}
            className={
              'rounded-md border px-3 py-1.5 text-sm transition-colors ' +
              (conTesto
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground')
            }
          >
            {t.parlamento.commissioni.onlyWithTextRoster}
          </button>

          {hasFilters ? (
            <button
              type="button"
              onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              {t.parlamento.commissioni.resetFilters}
            </button>
          ) : null}

          <span className="ml-auto text-sm text-muted-foreground">
            {t.parlamento.commissioni.showing(shown.length, rows.length)}
          </span>
        </div>
      </div>

      {query.status === 'loading' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t.parlamento.commissioni.empty}</CardTitle>
          </CardHeader>
        </Card>
      ) : shown.length === 0 ? (
        // A committee's OFFICIAL name often omits the word people search by:
        // the Covid inquiry is formally "...emergenza sanitaria epidemiologica
        // da SARS-CoV-2", which no amount of name matching will find from
        // "covid". Rather than maintain a synonym list that will always be
        // incomplete, point at the search that does work -- the transcripts
        // themselves say Covid constantly.
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t.parlamento.commissioni.filterNoMatch}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <Link
              to={ricercaUrl(filter.trim(), { organo: 'commissione' })}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {t.parlamento.commissioni.tryFullText(filter.trim())}
            </Link>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {shown.map((c) => (
            <li key={`${c.chamber}-${c.organo_slug}`}>
              <Card className="h-full">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {c.chamber === 'camera'
                        ? t.parlamento.cameraLabel
                        : t.parlamento.senatoLabel}
                    </Badge>
                    {/* Senato committee work is published as third-person
                        summaries, so the distinction is visible before the
                        reader ever opens a document. */}
                    <Badge
                      variant={c.tipo_resoconto === 'sommario' ? 'secondary' : 'outline'}
                      className="text-xs"
                    >
                      {c.tipo_resoconto === 'sommario'
                        ? t.parlamento.commissioni.sommarioBadge
                        : t.parlamento.commissioni.stenograficoBadge}
                    </Badge>
                  </div>
                  <CardTitle className="text-base leading-snug">
                    <Link
                      to={`/parlamento/commissioni/${encodeURIComponent(c.organo_slug)}`}
                      className="hover:underline"
                    >
                      {c.organo_nome ?? c.organo_slug}
                    </Link>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span>
                    {c.n} {t.parlamento.commissioni.seduteCount}
                  </span>
                  {c.interventi ? (
                    <span>
                      {c.interventi} {t.parlamento.commissioni.interventiCount}
                    </span>
                  ) : (
                    <span className="italic">{t.parlamento.commissioni.notIngested}</span>
                  )}
                  {periodo(c) ? <span>{periodo(c)}</span> : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
