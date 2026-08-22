import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  useNavigate,
  useParams,
  useLocation,
  useSearchParams,
  Link,
} from 'react-router-dom'
import {
  ArrowLeft,
  ExternalLink,
  RotateCcw,
  Search,
} from 'lucide-react'

import { BetaNotice } from '@/components/BetaNotice'
import { Pagination } from '@/components/Pagination'
import { CareerTimeline } from '@/components/parlamento/CareerTimeline'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@/hooks/useQuery'
import {
  fetchPersona,
  sedutaUrl,
  type Chamber,
  type Mandato,
  type PersonaIntervento,
} from '@/services/parlamento'
import { isChamber } from '@/lib/parlamento-params'
import { formatDate, formatNumber } from '@/lib/format'
import { t } from '@/i18n/it'

// Per-persona page. Three stacked sections:
//
//   1. Header  : canonical name + chamber + total interventi across all mandati.
//   2. Career  : one card per mandato, most-recent leg first, showing group,
//                circoscrizione, organi, etc. -- the union of what was
//                previously two endpoints (parlamento_oratori + the
//                parlamento_deputati lazy profile).
//   3. Speeches: searchable, paginated, optionally filtered to a single leg.
//
// All filter state is in the URL via useSearchParams so back-button and
// link-sharing work the same way as the rest of the parlamento section.

const PAGE_SIZE = 20

/**
 * Render a snippet that may contain literal <mark>...</mark> tokens from the
 * server-side BM25 highlighter. We split on the markers and rebuild as React
 * nodes rather than rendering raw HTML -- even if the snippet ever contained
 * hostile content, it could not break out of plain text.
 */
function HighlightedText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: Array<{ kind: 'plain' | 'mark'; text: string }> = []
    let rest = text
    while (rest) {
      const open = rest.indexOf('<mark>')
      if (open === -1) {
        out.push({ kind: 'plain', text: rest })
        break
      }
      if (open > 0) out.push({ kind: 'plain', text: rest.slice(0, open) })
      const close = rest.indexOf('</mark>', open)
      if (close === -1) {
        out.push({ kind: 'plain', text: rest.slice(open + 6) })
        break
      }
      out.push({ kind: 'mark', text: rest.slice(open + 6, close) })
      rest = rest.slice(close + 7)
    }
    return out
  }, [text])
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'mark' ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
    </>
  )
}

function InterventoRow({ iv }: { iv: PersonaIntervento }) {
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Badge variant="outline" className="font-mono uppercase tracking-wide text-[10px]">
          {iv.chamber === 'camera' ? 'Camera' : 'Senato'}
        </Badge>
        <Badge variant="outline" className="font-mono text-[10px]">
          {t.parlamento.persona.legislatureLabel} {iv.legislatura}
        </Badge>
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          n. {iv.numero}
        </span>
        <span className="text-sm text-muted-foreground">{formatDate(iv.data)}</span>
        {iv.odg_titolo ? (
          <span className="hidden text-xs text-muted-foreground/80 sm:inline">
            {iv.odg_titolo.length > 80 ? `${iv.odg_titolo.slice(0, 80)}...` : iv.odg_titolo}
          </span>
        ) : null}
        <Link
          to={sedutaUrl(iv.chamber, iv.legislatura, iv.numero, iv.anchor)}
          className="ml-auto rounded-md border border-border px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted"
        >
          {t.parlamento.persona.openInSeduta}
        </Link>
      </div>
      <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
        {iv.snippet ? <HighlightedText text={iv.snippet} /> : iv.testo.slice(0, 320)}
      </p>
    </li>
  )
}

/**
 * One mandato's profile block: per-leg badge plus the labelled fields that
 * were on the old "ID card" but scoped to a single legislature.
 */
function MandatoCard({ chamber, m }: { chamber: Chamber; m: Mandato }) {
  const fields: Array<{ label: string; value: string | null }> = [
    { label: t.parlamento.persona.district, value: m.circoscrizione },
    { label: t.parlamento.persona.collegio, value: m.collegio },
    { label: t.parlamento.persona.electionList, value: m.lista_elezione },
    {
      label: t.parlamento.persona.proclamation,
      value: m.data_proclamazione ? formatDate(m.data_proclamazione) : null,
    },
    { label: t.parlamento.persona.currentGroup, value: m.gruppo_attuale },
  ]
  return (
    <div className="space-y-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-heading text-sm font-semibold tracking-tight">
          {t.parlamento.persona.legislatureLabel} {m.legislatura}
        </h3>
        {m.gruppo_attuale ? (
          <Badge variant="secondary" className="text-xs">
            {m.gruppo_attuale}
          </Badge>
        ) : null}
        {m.ruolo ? (
          <Badge variant="outline" className="text-xs">
            {m.ruolo}
          </Badge>
        ) : null}
        {typeof m.interventi_n === 'number' && m.interventi_n > 0 ? (
          <span className="text-xs text-muted-foreground/80">
            {formatNumber(m.interventi_n)} {t.parlamento.persona.interventiInArchive}
          </span>
        ) : null}
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {fields
          .filter((f) => f.value)
          .map((f) => (
            <div key={f.label} className="flex flex-col">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">{f.label}</dt>
              <dd className="mt-0.5 text-foreground">{f.value}</dd>
            </div>
          ))}
      </dl>

      {m.formazione ? (
        <div>
          <h4 className="text-xs uppercase tracking-wide text-muted-foreground">
            {t.parlamento.persona.formation}
          </h4>
          <p className="mt-0.5 text-sm text-foreground">{m.formazione}</p>
        </div>
      ) : null}

      {(m.gruppo_storico?.length ?? 0) > 1 ? (
        <div>
          <h4 className="text-xs uppercase tracking-wide text-muted-foreground">
            {t.parlamento.persona.groupHistory}
          </h4>
          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
            {m.gruppo_storico.map((g, i) => (
              <li key={i}>
                <span className="text-foreground">{g.gruppo}</span>
                {g.dal ? (
                  <span className="ml-2 text-xs">
                    {t.parlamento.persona.from} {formatDate(g.dal)}
                    {g.al ? ` ${t.parlamento.persona.until} ${formatDate(g.al)}` : ''}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {(m.uffici?.length ?? 0) > 0 ? (
        <div>
          <h4 className="text-xs uppercase tracking-wide text-muted-foreground">
            {t.parlamento.persona.offices}
          </h4>
          <ul className="mt-1 space-y-1 text-sm">
            {m.uffici.map((u, i) => (
              <li key={i}>
                {u.ruolo ? (
                  <span className="font-medium text-foreground">{u.ruolo}</span>
                ) : null}{' '}
                <span className="text-foreground">{u.organo}</span>
                {u.dal ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t.parlamento.persona.from} {formatDate(u.dal)}
                    {u.al ? ` ${t.parlamento.persona.until} ${formatDate(u.al)}` : ''}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {(m.organi?.length ?? 0) > 0 ? (
        <div>
          <h4 className="text-xs uppercase tracking-wide text-muted-foreground">
            {t.parlamento.persona.organs}
          </h4>
          <ul className="mt-1 space-y-1 text-sm">
            {m.organi.map((o, i) => (
              <li key={i}>
                <span className="text-foreground">{o.organo}</span>
                {o.dal ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t.parlamento.persona.from} {formatDate(o.dal)}
                    {o.al ? ` ${t.parlamento.persona.until} ${formatDate(o.al)}` : ''}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Link
          to={`/parlamento/legislature/${m.legislatura}`}
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {t.parlamento.persona.legislatureLabel} {m.legislatura} →
        </Link>
        {m.source_url ? (
          <a
            href={m.source_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            {t.parlamento.persona.officialSite} ({chamber === 'camera' ? 'Camera' : 'Senato'})
          </a>
        ) : null}
      </div>
    </div>
  )
}

export default function PersonaPage() {
  const params = useParams<{ chamber: string; idPersona: string }>()
  const chamber = isChamber(params.chamber) ? params.chamber : null
  const idPersona = Number(params.idPersona)
  const validIdPersona = chamber && Number.isInteger(idPersona) && idPersona > 0

  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()

  // Filter state from URL.
  const q = searchParams.get('q') ?? ''
  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''
  const legParam = searchParams.get('leg') ?? ''
  const legFilter = legParam ? Number(legParam) : null
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)

  // Local-only state for the search input so the user can type without
  // every keystroke triggering a refetch.
  const [searchInput, setSearchInput] = useState(q)
  useEffect(() => setSearchInput(q), [q])

  const personaQuery = useQuery(
    ['parlamento/persona', chamber, idPersona, q, from, to, legFilter, page] as const,
    () => {
      if (!chamber || !validIdPersona) throw new Error('invalid persona url')
      return fetchPersona(chamber, idPersona, {
        q,
        from,
        to,
        leg: legFilter ?? undefined,
        page,
        pageSize: PAGE_SIZE,
      })
    },
    { ttlMs: 5 * 60 * 1000 },
  )

  useEffect(() => {
    if (personaQuery.status === 'error' && personaQuery.error) {
      console.error('[PersonaPage] failed to load persona:', { chamber, idPersona }, personaQuery.error)
    }
  }, [personaQuery.status, personaQuery.error, chamber, idPersona])

  function goBack() {
    if (location.key !== 'default') navigate(-1)
    else navigate('/parlamento')
  }

  function patchParams(next: Record<string, string | null>) {
    const np = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(next)) {
      if (value == null || value === '') np.delete(key)
      else np.set(key, value)
    }
    setSearchParams(np, { replace: false })
  }

  function onSubmitSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmed = searchInput.trim()
    patchParams({ q: trimmed || null, page: null })
  }

  function clearFilters() {
    setSearchInput('')
    setSearchParams(new URLSearchParams(), { replace: false })
  }

  const persona = personaQuery.data?.persona
  const mandati = personaQuery.data?.mandati ?? []
  const interventi = personaQuery.data?.interventi ?? []
  const total = personaQuery.data?.total ?? 0
  // When the BM25 search path runs, total is a lower-bound rather than an
  // exact count; rely on has_more for "is there a next page" instead of
  // dividing total by page size.
  const hasMore = personaQuery.data?.has_more ?? false
  const filtersActive = q !== '' || from !== '' || to !== '' || legFilter != null

  // Distinguish a real 404 from a transient backend failure so a network
  // blip doesn't surface "Parlamentare non trovato" on every refresh.
  const errMsg = personaQuery.error?.message ?? ''
  const is404 = /HTTP 404\b/.test(errMsg)
  const isLoadError = personaQuery.status === 'error' && !is404

  if (!validIdPersona) {
    return (
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-3">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {t.parlamento.persona.back}
          </button>
        </header>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t.parlamento.persona.notFoundTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{t.parlamento.persona.notFoundBody}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <button
          type="button"
          onClick={goBack}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t.parlamento.persona.back}
        </button>

        {personaQuery.status === 'loading' && !persona ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-72" />
            <Skeleton className="h-5 w-48" />
          </div>
        ) : !persona && isLoadError ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t.parlamento.persona.loadErrorTitle}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {t.parlamento.persona.loadErrorBody}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => personaQuery.refetch()}
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {t.parlamento.persona.retry}
              </Button>
            </CardContent>
          </Card>
        ) : !persona ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t.parlamento.persona.notFoundTitle}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {t.parlamento.persona.notFoundBody}
              </p>
              <p className="mt-2 break-all font-mono text-xs text-muted-foreground/70">
                {chamber}/{idPersona}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              {persona.nome}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono uppercase tracking-wide text-xs">
                {chamber === 'camera'
                  ? t.parlamento.cameraLabel
                  : t.parlamento.senatoLabel}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {t.parlamento.persona.mandatoCount(mandati.length)}
              </Badge>
              <span className="text-xs text-muted-foreground/70">
                {formatNumber(total)} {t.parlamento.persona.interventiInArchive}
              </span>
            </div>
          </div>
        )}
      </header>

      <BetaNotice compact />

      {/* Career: timeline + one block per mandato */}
      {persona && mandati.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t.parlamento.persona.careerTitle}</CardTitle>
            {mandati.length > 1 ? (
              <div className="mt-3">
                <CareerTimeline
                  mandati={mandati}
                  activeLeg={legFilter}
                  onSelectLeg={(leg) =>
                    patchParams({ leg: leg == null ? null : String(leg), page: null })
                  }
                />
              </div>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-6">
            {mandati
              .filter((m) => legFilter == null || m.legislatura === legFilter)
              .map((m) => (
                <MandatoCard key={m.legislatura} chamber={chamber!} m={m} />
              ))}
          </CardContent>
        </Card>
      ) : null}

      {/* Searchable interventi list */}
      {persona ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t.parlamento.persona.recentTitle}</CardTitle>
          </CardHeader>

          <div className="flex flex-col gap-3 px-4 pb-2 sm:px-6">
            <form onSubmit={onSubmitSearch} className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.currentTarget.value)}
                placeholder={t.parlamento.persona.searchPlaceholder}
                className="flex-1"
                minLength={2}
              />
              <Button type="submit" className="gap-2">
                <Search className="h-4 w-4" aria-hidden="true" />
                {t.parlamento.persona.searchSubmit}
              </Button>
            </form>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {mandati.length > 1 ? (
                <label className="inline-flex items-center gap-1.5">
                  {t.parlamento.persona.legFilterLabel}
                  <select
                    value={legParam}
                    onChange={(e) =>
                      patchParams({ leg: e.currentTarget.value || null, page: null })
                    }
                    className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="">{t.parlamento.persona.legFilterAll}</option>
                    {mandati.map((m) => (
                      <option key={m.legislatura} value={String(m.legislatura)}>
                        {m.legislatura}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="inline-flex items-center gap-1.5">
                {t.parlamento.persona.dateFrom}
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => patchParams({ from: e.currentTarget.value || null, page: null })}
                  className="h-7 w-auto px-2 py-0 text-xs"
                />
              </label>
              <label className="inline-flex items-center gap-1.5">
                {t.parlamento.persona.dateTo}
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => patchParams({ to: e.currentTarget.value || null, page: null })}
                  className="h-7 w-auto px-2 py-0 text-xs"
                />
              </label>
              {filtersActive ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="ml-auto h-7 gap-1 px-2 text-xs"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                  {t.parlamento.persona.clearFilters}
                </Button>
              ) : null}
            </div>
          </div>

          <CardContent>
            {personaQuery.data?.search_error ? (
              <div
                role="status"
                className="mb-3 rounded-md border border-warning-border bg-warning p-3 text-xs text-warning-foreground"
              >
                {t.parlamento.persona.searchUnavailable}
              </div>
            ) : null}
            {personaQuery.status === 'loading' && interventi.length === 0 ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : interventi.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {filtersActive
                  ? t.parlamento.persona.noInterventiFiltered
                  : t.parlamento.persona.noInterventi}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {interventi.map((iv, i) => (
                  <InterventoRow key={`${iv.chamber}-${iv.numero}-${iv.anchor}-${i}`} iv={iv} />
                ))}
              </ul>
            )}
          </CardContent>

          {/* The speeches list reports a lower-bound total when a search term
              is set, so pass hasMore rather than a page count. */}
          <Pagination
            page={page}
            hasMore={hasMore}
            total={total}
            isFetching={personaQuery.isFetching}
            onPageChange={(next) =>
              patchParams({ page: next <= 1 ? null : String(next) })
            }
          />
        </Card>
      ) : null}
    </div>
  )
}
