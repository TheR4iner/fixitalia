import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

// Lightweight "stat strip" used at the top of each data page in place of the
// copy-pasted 4-card hero-metric grid. One horizontal row of numbers, each
// with a muted label and an optional one-line finding underneath. Reads as
// a data-desk standfirst instead of a dashboard.
//
// - No Card chrome, no big rounded boxes. The page header + this strip is
//   the entire "top of fold" now.
// - Values use tabular-nums so columns align even when digit count differs.
// - Finding text is secondary -- collapses to a single line on mobile, but
//   stays visible.
//
// SIZING THIS FOR REAL NUMBERS -- do not narrow the breakpoints again.
//
// The widest value the site renders is the state budget total,
// "1.154.165.459.884 €". Measured in the browser at text-2xl (24px) in this
// heading face, it needs **219px** on one line. A number has no spaces, so it
// has no break opportunity: before this it simply overflowed its grid cell and
// ran over the neighbouring stat, printing the total payments figure on top of
// the top-mission percentage on a phone.
//
// Measured cell widths against the max-w-6xl / xl:max-w-7xl page container:
//
//   viewport  cols  cell    219px value
//   375px     1     343px   1 line          <- new mobile
//   414px     1     382px   1 line
//   375px     2     156px   wraps to 2      <- old mobile, the bug
//   640px     2     280px   1 line
//   1024px    4     220px   1 line by 1px   <- why this is xl, not lg
//   1280px    4     284px   1 line
//
// Four columns at `lg` does technically fit today, with one pixel to spare.
// That is not headroom: a slightly longer figure, a font fallback or a locale
// change breaks it silently. Hence `xl:grid-cols-4`, which leaves ~30%.
//
// The value also stays at text-2xl -- the old `sm:text-3xl` bump would need
// ~274px and wrap at every breakpoint below xl -- and `overflow-wrap: anywhere`
// is kept as a last-resort net so anything unforeseen wraps rather than
// collides.

interface StatProps {
  label: string
  value: ReactNode
  finding?: ReactNode
  loading?: boolean
  className?: string
}

export function Stat({ label, value, finding, loading, className }: StatProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-xs font-medium tracking-wide uppercase text-muted-foreground">
        {label}
      </span>
      <span className="font-heading text-2xl font-semibold tabular-nums text-foreground [overflow-wrap:anywhere]">
        {loading ? <Skeleton className="h-8 w-28" /> : value}
      </span>
      {finding ? (
        <span className="text-xs text-muted-foreground sm:text-sm">{finding}</span>
      ) : null}
    </div>
  )
}

interface StatStripProps {
  children: ReactNode
  ariaLabel?: string
  className?: string
}

export function StatStrip({ children, ariaLabel, className }: StatStripProps) {
  return (
    <section
      aria-label={ariaLabel}
      className={cn(
        'grid grid-cols-1 gap-x-6 gap-y-5 border-y border-border/80 py-5 sm:grid-cols-2 sm:gap-x-8 sm:py-6 xl:grid-cols-4',
        className,
      )}
    >
      {children}
    </section>
  )
}
