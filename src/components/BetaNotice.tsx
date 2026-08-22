import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

import { cn } from '@/lib/utils'
import { t } from '@/i18n/it'

// "This section is in beta, verify against the official source" banner.
// Rendered at the very top of a page, above its header, so it is the first
// thing a reader sees -- including readers who land on a deep page straight
// from a search engine.
//
// Two densities: the default one leads with a bold title and is used on the
// section landing page; `compact` drops the title and the heavier border,
// for the deep pages where the same warning repeats and should not dominate
// the content. The body copy is identical in both, so there is only ever one
// wording to review.
//
// Uses the --warning token family (defined in src/index.css with a dark
// variant) rather than raw amber utilities, so it inverts correctly with
// the theme.
//
// role="note" instead of role="alert": the content is static and present
// on first paint, so it should be part of the normal reading order rather
// than interrupting a screen reader mid-sentence.

interface BetaNoticeProps {
  // Optional trailing content, typically SourceLink elements pointing at
  // the official portals the page's data comes from.
  children?: ReactNode
  compact?: boolean
  className?: string
}

export function BetaNotice({ children, compact = false, className }: BetaNoticeProps) {
  return (
    <aside
      role="note"
      className={cn(
        'flex flex-col gap-2 rounded-lg border-warning-border bg-warning text-warning-foreground sm:flex-row sm:gap-3',
        compact ? 'border p-3' : 'border-2 p-4',
        className,
      )}
    >
      <TriangleAlert
        aria-hidden="true"
        className={cn('shrink-0 sm:mt-0.5', compact ? 'size-4' : 'size-5')}
      />
      <div className="flex flex-col gap-1.5">
        {compact ? null : (
          <p className="font-heading text-sm font-semibold sm:text-base">
            {t.common.beta.title}
          </p>
        )}
        <p className={cn('max-w-3xl', compact ? 'text-xs' : 'text-sm')}>
          {t.common.beta.body}
        </p>
        {children ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-medium">{t.common.beta.sourcesLabel}</span>
            {children}
          </p>
        ) : null}
      </div>
    </aside>
  )
}
