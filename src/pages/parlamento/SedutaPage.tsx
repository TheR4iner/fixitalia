import { useEffect, useMemo, type CSSProperties } from 'react'
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { BetaNotice } from '@/components/BetaNotice'
import { SourceLink } from '@/components/SourceLink'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { useQuery } from '@/hooks/useQuery'
import { useTheme } from '@/hooks/useTheme'
import { useReaderPrefs, readerFontFamily } from '@/hooks/useReaderPrefs'
import {
  fetchInterventi,
  fetchSedutaDetail,
  type Chamber,
  type OdgEntry,
} from '@/services/parlamento'
import { isChamber } from '@/lib/parlamento-params'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n/it'
import { InterventoBlock } from '@/components/parlamento/InterventoBlock'
import { ReaderSettings } from '@/components/parlamento/ReaderSettings'
import { SedutaIndex } from '@/components/parlamento/SedutaIndex'
import { VideoEmbed } from '@/components/parlamento/VideoEmbed'
import { groupAccent } from '@/components/parlamento/groupColors'
import { oratoreKey } from '@/lib/oratore-key'

// Per-seduta reader. Fetches the seduta header + OdG/oratori in one call,
// then the interventi (paginated). Renders interventi inline because the
// reader UX wants the full transcript as one continuous document with
// anchor jumps, not infinite-scroll. We accept the cost of a longer DOM
// for sedute with many interventi (a few thousand at the upper bound)
// because the per-block markup is small (no media, no charts).

// The reader renders the whole transcript as a single continuous document, so
// it fetches every intervento in one request. 5000 clears the current largest
// seduta (2885 interventi) with headroom; it matches the backend's page-size
// ceiling. (A previous 1000 here silently truncated the 57 sedute above that.)
const READER_FETCH_LIMIT = 5000

export default function SedutaPage() {
  const params = useParams<{ chamber: string; leg: string; numero: string }>()
  const chamber = isChamber(params.chamber) ? params.chamber : null
  const legislatura = Number(params.leg)
  const numero = Number(params.numero)
  const { resolved } = useTheme()
  const { prefs, setPrefs } = useReaderPrefs()
  const navigate = useNavigate()
  const location = useLocation()

  function goBack() {
    if (location.key !== 'default') {
      navigate(-1)
    } else {
      navigate('/parlamento')
    }
  }

  const detailKey = ['parlamento/seduta', chamber, legislatura, numero] as const
  const interventiKey = ['parlamento/interventi', chamber, legislatura, numero] as const

  // 5-minute TTL: a re-run of the body pass should show new content
  // promptly without forcing the operator to clear localStorage.
  const detailQuery = useQuery(
    detailKey,
    () => fetchSedutaDetail(chamber as Chamber, legislatura, numero),
    { ttlMs: 5 * 60 * 1000 },
  )
  const interventiQuery = useQuery(
    interventiKey,
    () => fetchInterventi(chamber as Chamber, legislatura, numero, 1, READER_FETCH_LIMIT),
    { ttlMs: 5 * 60 * 1000 },
  )

  const interventi = useMemo(
    () => interventiQuery.data?.data ?? [],
    [interventiQuery.data],
  )

  // Hash navigation: when the user follows a link like /parlamento/sedute/camera/19/243#int-86
  // (e.g. from the OratorePage "Apri nella seduta" button), the browser tries
  // to scroll to the anchor BEFORE the interventi data has loaded -- the
  // matching <InterventoBlock id="int-86"> doesn't exist yet, so the browser
  // gives up. Once data lands and the elements exist, we have to scroll
  // ourselves. The setTimeout gives React a paint cycle so getElementById
  // resolves; otherwise we'd race the commit.
  useEffect(() => {
    if (!location.hash || interventi.length === 0) return
    const id = location.hash.slice(1)
    const handle = window.setTimeout(() => {
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
    return () => window.clearTimeout(handle)
  }, [interventi.length, location.hash])

  // Build (oratore-name|gruppo|ruolo) -> first anchor map so the speaker
  // tab links jump to the speaker's first appearance.
  const oratoreAnchors = useMemo(() => {
    const out = new Map<string, string>()
    for (const i of interventi) {
      if (!i.oratore_nome) continue
      const k = oratoreKey(i.oratore_nome, i.gruppo, i.ruolo)
      if (!out.has(k)) out.set(k, i.anchor)
    }
    return out
  }, [interventi])

  // Index of the first intervento belonging to each OdG position, so the
  // render pass can ask "does the OdG heading go above THIS block?" in O(1).
  //
  // The render loop used to answer that with `interventi.findIndex(...)` plus
  // `interventi.indexOf(it)` per item, i.e. two full scans of the list for
  // every element -- O(n^2) over a list that reaches 2,885 items on the
  // largest seduta (~16.6M array steps per render, ~2.8M on a typical large
  // one). Precomputing it here makes the whole pass linear, and keeps the
  // work out of the render path entirely when the data has not changed.
  const firstInterventoIndexByOdg = useMemo(() => {
    const out = new Map<number, number>()
    interventi.forEach((it, idx) => {
      if (it.odg_pos == null) return
      if (!out.has(it.odg_pos)) out.set(it.odg_pos, idx)
    })
    return out
  }, [interventi])

  const seduta = detailQuery.data?.seduta
  const odg = useMemo(() => detailQuery.data?.odg ?? [], [detailQuery.data])
  const oratori = detailQuery.data?.oratori ?? []

  // Same idea for the OdG lookup itself: `odg.find(...)` per intervento was
  // a scan of the agenda list for every block.
  const odgByPosizione = useMemo(() => {
    const out = new Map<number, OdgEntry>()
    for (const o of odg) out.set(o.posizione, o)
    return out
  }, [odg])

  if (!chamber || !Number.isFinite(legislatura) || !Number.isFinite(numero)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t.parlamento.invalidPage}</CardTitle>
        </CardHeader>
      </Card>
    )
  }

  // Reader typography is published through CSS custom properties on the
  // <article> wrapper instead of being prop-drilled into every
  // InterventoBlock. The cascade carries the values to descendants for
  // free; React.memo on InterventoBlock then short-circuits the
  // re-render of the (potentially 1000-strong) intervento list when the
  // user nudges the size or line-height sliders.
  const readerStyle = {
    '--reader-family': readerFontFamily(prefs.font),
    '--reader-size': `${prefs.size}px`,
    '--reader-line': String(prefs.line),
  } as CSSProperties

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {t.parlamento.seduta.back}
          </button>
          {Number.isFinite(legislatura) ? (
            <>
              <span className="text-muted-foreground/30" aria-hidden="true">·</span>
              <Link
                to={`/parlamento/legislature/${legislatura}`}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t.parlamento.seduta.legislaturaLink(legislatura)}
              </Link>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {chamber === 'camera' ? t.parlamento.cameraLabel : t.parlamento.senatoLabel}
            {' -- '}
            {t.parlamento.seduteList.seduta} {numero}
          </h1>
          {seduta?.data ? (
            <span className="text-sm text-muted-foreground">
              {formatDate(seduta.data)}
            </span>
          ) : null}
        </div>
        {seduta?.titolo ? (
          <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
            {seduta.titolo}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <ReaderSettings prefs={prefs} onChange={setPrefs} />
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="lg:hidden">
                {t.parlamento.seduta.indexTitle}
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="sm:max-w-md">
              <div className="px-4 py-2">
                <SedutaIndex
                  chamber={chamber as Chamber}
                  odg={odg}
                  oratori={oratori}
                  oratoreAnchors={oratoreAnchors}
                />
              </div>
            </SheetContent>
          </Sheet>
          {seduta?.video_url ? (
            <VideoEmbed url={seduta.video_url} fallbackUrl={seduta.source_url} />
          ) : seduta?.source_url ? (
            <a
              href={seduta.source_url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              {t.parlamento.seduta.videoOpen}
            </a>
          ) : null}
          {seduta?.body_status === 'empty' ? (
            <Badge variant="outline" className="text-xs">
              {t.parlamento.seduta.empty}
            </Badge>
          ) : null}
        </div>
      </header>

      <BetaNotice compact>
        {seduta?.source_url ? (
          <SourceLink
            label={t.parlamento.seduta.sourceOfficial}
            url={seduta.source_url}
            className="text-warning-foreground/80 hover:text-warning-foreground"
          />
        ) : null}
      </BetaNotice>

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <main className="min-w-0">
          {interventiQuery.status === 'loading' ? (
            <div className="space-y-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-32 w-full" />
              ))}
            </div>
          ) : interventi.length === 0 ? (
            seduta?.body_status === 'waf_blocked' || chamber === 'senato' ? (
              <Card>
                <CardHeader>
                  <CardTitle>{t.parlamento.senatoUnavailable.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>{t.parlamento.senatoUnavailable.body}</p>
                  <p>{t.parlamento.senatoUnavailable.bodyDetail}</p>
                </CardContent>
                <CardFooter className="flex flex-wrap items-center gap-3">
                  {seduta?.html_url ? (
                    <a
                      href={seduta.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      {t.parlamento.senatoUnavailable.openOfficial}
                    </a>
                  ) : null}
                  {seduta?.source_url ? (
                    <SourceLink label={t.parlamento.source} url={seduta.source_url} />
                  ) : null}
                </CardFooter>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>{t.parlamento.seduta.empty}</CardTitle>
                </CardHeader>
                <CardContent />
                <CardFooter>
                  {seduta?.source_url ? (
                    <SourceLink label={t.parlamento.source} url={seduta.source_url} />
                  ) : null}
                </CardFooter>
              </Card>
            )
          ) : (
            <article className="flex flex-col gap-8" style={readerStyle}>
              {interventi.map((it, idx) => {
                // Insert an OdG marker before the first intervento of each OdG.
                // Both lookups are O(1) against the maps built above.
                const odgEntry =
                  it.odg_pos != null ? odgByPosizione.get(it.odg_pos) : undefined
                const isFirstOfOdg =
                  odgEntry != null && firstInterventoIndexByOdg.get(odgEntry.posizione) === idx
                return (
                  <div key={it.posizione} className="flex flex-col gap-4">
                    {odgEntry && isFirstOfOdg ? (
                      <h2
                        id={odgEntry.anchor}
                        className="scroll-mt-24 border-t border-border pt-6 font-heading text-xl font-semibold tracking-tight text-foreground"
                      >
                        <span className="mr-2 font-mono text-base text-muted-foreground">
                          {odgEntry.posizione}.
                        </span>
                        {odgEntry.titolo}
                      </h2>
                    ) : null}
                    <InterventoBlock
                      intervento={it}
                      groupAccent={groupAccent(it.gruppo, resolved)}
                    />
                  </div>
                )
              })}
            </article>
          )}
        </main>

        <aside className="hidden lg:block">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2">
            <SedutaIndex
              chamber={chamber as Chamber}
              odg={odg}
              oratori={oratori}
              oratoreAnchors={oratoreAnchors}
            />
          </div>
        </aside>
      </div>

      {seduta?.source_url ? (
        <footer className="text-xs text-muted-foreground">
          <SourceLink
            label={`${t.parlamento.sourcePrefix}: ${
              chamber === 'camera' ? t.parlamento.cameraLabel : t.parlamento.senatoLabel
            }`}
            url={seduta.source_url}
          />
        </footer>
      ) : null}
    </div>
  )
}
