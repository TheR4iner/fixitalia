import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import { t } from '@/i18n/it'
import { useBackendHealth } from '@/hooks/useBackendHealth'

type SectionKey = keyof typeof t.sections

// Editorial ordering: "parlamento" leads, followed by the data-rich sections,
// with the personal calculator ("leTueTasse") kept last.
const SECTION_ORDER: SectionKey[] = [
  'parlamento',
  'appalti',
  'fondiEuropei',
  'opereIncompiute',
  'spesaPubblica',
  'leTueTasse',
]

function HealthIndicator() {
  const health = useBackendHealth()

  const dotClass = cn(
    'inline-block size-2 rounded-full',
    health.state === 'loading' && 'bg-muted-foreground/50 animate-pulse',
    health.state === 'ok' && 'bg-success',
    health.state === 'error' && 'bg-destructive',
  )

  const label =
    health.state === 'loading'
      ? t.home.healthChecking
      : health.state === 'ok'
        ? t.home.healthOk
        : t.home.healthError

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-xs text-muted-foreground"
    >
      <span className={dotClass} />
      <span>
        {t.home.healthLabel}: {label}
      </span>
    </div>
  )
}

function SectionEntry({
  sectionKey,
  index,
}: {
  sectionKey: SectionKey
  index: number
}) {
  const section = t.sections[sectionKey]
  const lede = t.home.sectionLedes[sectionKey]
  const paddedIndex = String(index + 1).padStart(2, '0')

  return (
    <li>
      <Link
        to={section.route}
        className="group/entry block border-t border-border/80 py-6 outline-none transition-colors focus-visible:bg-muted/30 sm:py-8"
      >
        <div className="flex items-baseline gap-4 sm:gap-6">
          <span className="font-mono text-xs text-muted-foreground tabular-nums sm:text-sm">
            {paddedIndex}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h3 className="font-heading text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {section.title}
            </h3>
            <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
              {lede}
            </p>
          </div>
          <span
            aria-hidden="true"
            className="mt-1 hidden shrink-0 items-center gap-1 text-sm text-muted-foreground transition-transform group-hover/entry:translate-x-0.5 group-hover/entry:text-foreground group-focus-visible/entry:text-foreground sm:inline-flex"
          >
            {t.home.readMore}
            <ArrowRight className="size-4" />
          </span>
        </div>
      </Link>
    </li>
  )
}

export default function HomePage() {
  return (
    <div className="flex flex-col gap-10 sm:gap-14">
      <section className="flex max-w-3xl flex-col gap-5 pt-2 sm:pt-6">
        <h1 className="font-heading text-balance text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl md:text-5xl">
          {t.home.heroHeadline}
        </h1>
        <p className="max-w-2xl text-pretty text-base text-muted-foreground sm:text-lg">
          {t.home.heroSubheadline}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-heading text-lg font-semibold tracking-tight text-foreground sm:text-xl">
            {t.home.exploreTitle}
          </h2>
          <p className="hidden max-w-md text-right text-sm text-muted-foreground sm:block">
            {t.home.exploreSubtitle}
          </p>
        </div>
        <ul className="border-b border-border/80">
          {SECTION_ORDER.map((key, i) => (
            <SectionEntry key={key} sectionKey={key} index={i} />
          ))}
        </ul>
      </section>

      <HealthIndicator />
    </div>
  )
}
