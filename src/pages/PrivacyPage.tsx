import { Link } from 'react-router-dom'

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { t } from '@/i18n/it'

// Privacy notice. Required once a controller is named and the site
// publishes attendance, votes and speech records for named individuals:
// that is personal data processing under the GDPR even though every
// figure was already public.
//
// The copy is deliberately specific about what the site does NOT do
// (no cookies, no analytics, no accounts), because a boilerplate notice
// claiming otherwise would be inaccurate here and inaccuracy is the one
// thing a privacy notice cannot afford.

export default function PrivacyPage() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          {t.privacy.title}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          {t.privacy.pageSubtitle}
        </p>
        <p className="text-xs text-muted-foreground">
          {t.privacy.updatedLabel}: {t.privacy.updatedDate}
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {t.privacy.sections.map((section) => (
          <Card key={section.title} className="h-full">
            <CardHeader>
              <CardTitle className="text-base leading-snug">
                {section.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <p>{section.body}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{t.privacy.contactTitle}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm text-muted-foreground">
          <p>{t.privacy.contactBody}</p>
          <Link
            to={t.contatti.route}
            className="inline-flex w-fit items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:py-2.5"
          >
            {t.privacy.contactLinkLabel}
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
