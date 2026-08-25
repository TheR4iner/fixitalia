import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { BetaNotice } from '@/components/BetaNotice'
import { SourceLink } from '@/components/SourceLink'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { useTheme } from '@/hooks/useTheme'
import { useReaderPrefs, readerFontFamily } from '@/hooks/useReaderPrefs'
import type { QueryResult } from '@/hooks/useQuery'
import type {
  Chamber,
  InterventiResponse,
  OdgEntry,
  SedutaDetailResponse,
} from '@/services/parlamento'
import { formatDate } from '@/lib/format'
import { t } from '@/i18n/it'
import { InterventoBlock } from '@/components/parlamento/InterventoBlock'
import { ReaderSettings } from '@/components/parlamento/ReaderSettings'
import { SedutaIndex } from '@/components/parlamento/SedutaIndex'
import { VideoEmbed } from '@/components/parlamento/VideoEmbed'
import { groupAccent } from '@/components/parlamento/groupColors'
import { oratoreKey } from '@/lib/oratore-key'

// The transcript reader, shared by the Aula and the committee routes.
//
// The two differ only in how a sitting is ADDRESSED -- chamber+legislatura+
// numero for the Aula, a document scope for a committee, because committee
// resoconti are numbered per-committee and a number does not identify one.
// Everything downstream of that (agenda markers, speaker index, reader
// typography, hash navigation, empty states) is identical, so the addressing
// stays in the page components and the rendering lives here.

export interface SedutaReaderProps {
  chamber: Chamber
  /** Null hides the legislature link (never the case today, but typed honestly). */
  legislatura: number | null
  /** Main heading, e.g. "Camera dei Deputati -- Seduta 243". */
  title: string
  detailQuery: QueryResult<SedutaDetailResponse>
  interventiQuery: QueryResult<InterventiResponse>
  onBack: () => void
  backLabel: string
  /** Location hash, so the reader can scroll to an intervento anchor. */
  hash: string
  /** Rendered between the header and the transcript (e.g. a sommario warning). */
  notice?: ReactNode
  /** Extra badges beside the reader controls. */
  badges?: ReactNode
  /** Overrides the heading shown when there is no transcript. */
  emptyTitle?: string
  /**
   * Show the "Senato temporarily unavailable" card instead of the plain empty
   * card when a sitting has no interventi.
   *
   * The Aula route sets this for Senato, where an empty sitting historically
   * meant the WAF had blocked the body pass. Committee sittings must NOT set
   * it: senato.it publishes genuinely empty stub sommari for procedural
   * sittings, and telling the reader the site is unavailable when it is
   * serving the document correctly would be a plain lie.
   */
  treatEmptyAsBlocked?: boolean
}

export function SedutaReader({
  chamber,
  legislatura,
  title,
  detailQuery,
  interventiQuery,
  onBack,
  backLabel,
  hash,
  notice,
  badges,
  emptyTitle,
  treatEmptyAsBlocked = false,
}: SedutaReaderProps) {
  const { resolved } = useTheme()
  const { prefs, setPrefs } = useReaderPrefs()

  const interventi = useMemo(
    () => interventiQuery.data?.data ?? [],
    [interventiQuery.data],
  )

  // Hash navigation: a link like .../243#int-86 (e.g. from a persona page)
  // asks the browser to scroll before the interventi have loaded, so the
  // target element does not exist yet and the browser gives up. Once the data
  // lands we scroll ourselves; the timeout gives React a paint cycle so
  // getElementById resolves instead of racing the commit.
  useEffect(() => {
    if (!hash || interventi.length === 0) return
    const id = hash.slice(1)
    const handle = window.setTimeout(() => {
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
    return () => window.clearTimeout(handle)
  }, [interventi.length, hash])

  // (oratore-name|gruppo|ruolo) -> first anchor, so the speaker tab links jump
  // to that speaker's first appearance.
  const oratoreAnchors = useMemo(() => {
    const out = new Map<string, string>()
    for (const i of interventi) {
      if (!i.oratore_nome) continue
      const k = oratoreKey(i.oratore_nome, i.gruppo, i.ruolo)
      if (!out.has(k)) out.set(k, i.anchor)
    }
    return out
  }, [interventi])

  // Index of the first intervento of each OdG, so the render pass can ask
  // "does the OdG heading go above THIS block?" in O(1). Answering it inline
  // with findIndex + indexOf was two full scans per item, i.e. O(n^2) over a
  // list that reaches 2,885 items on the largest seduta.
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

  const odgByPosizione = useMemo(() => {
    const out = new Map<number, OdgEntry>()
    for (const o of odg) out.set(o.posizione, o)
    return out
  }, [odg])

  // Reader typography travels as CSS custom properties on the <article>
  // rather than being prop-drilled into every InterventoBlock: the cascade
  // carries it for free, and React.memo on InterventoBlock then short-circuits
  // a re-render of the whole list when the user nudges a slider.
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
            onClick={onBack}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {backLabel}
          </button>
          {legislatura != null && Number.isFinite(legislatura) ? (
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
            {title}
          </h1>
          {seduta?.data ? (
            <span className="text-sm text-muted-foreground">{formatDate(seduta.data)}</span>
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
                  chamber={chamber}
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
          {badges}
          {seduta?.body_status === 'empty' ? (
            <Badge variant="outline" className="text-xs">
              {t.parlamento.seduta.empty}
            </Badge>
          ) : null}
        </div>
      </header>

      {notice}

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
            seduta?.body_status === 'waf_blocked' || treatEmptyAsBlocked ? (
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
                  <CardTitle>{emptyTitle ?? t.parlamento.seduta.empty}</CardTitle>
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
                // Insert an OdG marker before the first intervento of each
                // agenda item. Both lookups are O(1) against the maps above.
                const odgEntry =
                  it.odg_pos != null ? odgByPosizione.get(it.odg_pos) : undefined
                const isFirstOfOdg =
                  odgEntry != null &&
                  firstInterventoIndexByOdg.get(odgEntry.posizione) === idx
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
              chamber={chamber}
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
