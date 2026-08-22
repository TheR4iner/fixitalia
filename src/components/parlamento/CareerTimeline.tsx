import { useCallback } from 'react'

import { groupAccent } from './groupColors'
import type { Mandato } from '@/services/parlamento'
import { cn } from '@/lib/utils'
import { t } from '@/i18n/it'

interface CareerTimelineProps {
  mandati: Mandato[]
  activeLeg: number | null
  /** Called when the user clicks a legislature pill. Pass null to clear. */
  onSelectLeg: (leg: number | null) => void
}

/**
 * Horizontal scrollable timeline of all legislatures a parlamentare served in.
 * Clicking a pill sets it as the leg filter on the speeches list below.
 * Consecutive legislatures are connected by a line; gaps show a break.
 */
export function CareerTimeline({ mandati, activeLeg, onSelectLeg }: CareerTimelineProps) {
  // Sort ascending so the timeline reads left-to-right chronologically.
  const sorted = [...mandati].sort((a, b) => a.legislatura - b.legislatura)

  const handleClick = useCallback(
    (leg: number) => {
      onSelectLeg(activeLeg === leg ? null : leg)
    },
    [activeLeg, onSelectLeg],
  )

  if (sorted.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t.parlamento.careerTimeline.label}
      </span>
      <div
        className="flex items-center gap-0 overflow-x-auto pb-1"
        role="group"
        aria-label={t.parlamento.careerTimeline.label}
      >
        {sorted.map((m, i) => {
          const prev = sorted[i - 1]
          const isActive = activeLeg === m.legislatura
          const isConsecutive = prev && m.legislatura === prev.legislatura + 1
          const color = groupAccent(m.gruppo_attuale)

          return (
            <div key={m.legislatura} className="flex shrink-0 items-center">
              {/* Connector line — thinner and greyed when there's a gap */}
              {i > 0 ? (
                <div
                  className={cn(
                    'h-px w-4 shrink-0',
                    isConsecutive ? 'bg-border' : 'bg-border/30',
                  )}
                  aria-hidden="true"
                />
              ) : null}

              <button
                type="button"
                onClick={() => handleClick(m.legislatura)}
                title={t.parlamento.careerTimeline.clickToFilter}
                aria-pressed={isActive}
                className={cn(
                  'group relative flex flex-col items-center rounded-md border px-3 py-1.5 text-xs font-medium transition-all',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                  isActive
                    ? 'border-foreground bg-foreground text-background shadow-sm'
                    : 'border-border bg-background text-muted-foreground hover:border-foreground/50 hover:text-foreground',
                )}
                style={
                  isActive
                    ? undefined
                    : {
                        borderLeftColor: color,
                        borderLeftWidth: '3px',
                      }
                }
              >
                <span className="tabular-nums leading-none">
                  {t.parlamento.careerTimeline.legLabel(m.legislatura)}
                </span>
                {m.gruppo_attuale ? (
                  <span
                    className={cn(
                      'mt-0.5 max-w-[96px] truncate text-[9px] leading-none',
                      isActive ? 'text-background/70' : 'text-muted-foreground/70',
                    )}
                    title={m.gruppo_attuale}
                  >
                    {m.gruppo_attuale.split(/[–\-–]/)[0].trim()}
                  </span>
                ) : null}
              </button>
            </div>
          )
        })}

        {activeLeg != null ? (
          <button
            type="button"
            onClick={() => onSelectLeg(null)}
            className="ml-3 shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t.parlamento.careerTimeline.clearLegFilter}
          </button>
        ) : null}
      </div>
    </div>
  )
}
