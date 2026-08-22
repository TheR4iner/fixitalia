import { ExternalLink } from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { t } from '@/i18n/it'

// Static about/contact page. No data fetching, no charts: it exists to
// say who is behind the project and how to reach them, so it stays a
// plain prose route rather than following the section-page shape
// (header + KPI strip + charts) used everywhere else.

export default function ContattiPage() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          {t.contatti.title}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.contatti.pageSubtitle}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{t.contatti.authorName}</CardTitle>
            <CardDescription>{t.contatti.authorRole}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {t.contatti.getInTouchBody}
            </p>
            <a
              href={t.contatti.linkedinUrl}
              target="_blank"
              rel="noreferrer me"
              className="inline-flex w-fit items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:py-2.5"
            >
              {t.contatti.linkedinLabel}
              <ExternalLink aria-hidden="true" className="size-4" />
            </a>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{t.contatti.aboutTitle}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>{t.contatti.aboutBody}</p>
            <p>{t.contatti.dataCaveat}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
