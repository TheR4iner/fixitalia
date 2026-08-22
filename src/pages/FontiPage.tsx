import { ExternalLink } from 'lucide-react'

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { t } from '@/i18n/it'

// Attribution surface for the open-data licences the ingested sources
// carry. CC BY 4.0 and IODL 2.0 both require crediting the originating
// body, and per-datapoint SourceLink footers satisfy that only for the
// figure a reader happens to be looking at. This page is the
// consolidated statement: every source, what it feeds, its licence, and
// a link to the portal whose terms actually bind.
//
// Static prose route, so it follows ContattiPage's shape rather than the
// section-page shape (header + KPI strip + charts).

export default function FontiPage() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          {t.fonti.title}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.fonti.pageSubtitle}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{t.fonti.attributionTitle}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>{t.fonti.attributionBody}</p>
          <p>{t.fonti.attributionCaveat}</p>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-4">
        <h2 className="font-heading text-xl font-semibold tracking-tight">
          {t.fonti.sourcesTitle}
        </h2>

        <ul className="grid gap-4 md:grid-cols-2">
          {t.fonti.sources.map((source) => (
            <li key={source.url}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle className="text-base leading-snug">
                    {source.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
                  <p>{source.usedFor}</p>
                  <p>
                    <span className="font-medium text-foreground">
                      {t.fonti.sourceLicenceLabel}:
                    </span>{' '}
                    {source.licence}
                  </p>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex w-fit items-center gap-1 underline-offset-4 transition-colors hover:text-foreground hover:underline"
                  >
                    {t.common.viewSource}
                    <ExternalLink aria-hidden="true" className="size-3" />
                  </a>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{t.fonti.codeTitle}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm text-muted-foreground">
            <p>{t.fonti.codeBody}</p>
            <a
              href={t.fonti.codeUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:py-2.5"
            >
              {t.fonti.codeLinkLabel}
              <ExternalLink aria-hidden="true" className="size-4" />
            </a>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{t.fonti.reuseTitle}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>{t.fonti.reuseBody}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
