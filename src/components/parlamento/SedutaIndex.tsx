import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'

import { cn } from '@/lib/utils'
import { t } from '@/i18n/it'
import {
  personaUrl,
  type Chamber,
  type OdgEntry,
  type OratoreSummary,
} from '@/services/parlamento'
import { oratoreKey } from '@/lib/oratore-key'

// Sticky table of contents for the reader. Two tabs:
//   - Ordini del giorno (anchored to #odg-N-...)
//   - Parlamentari intervenuti (anchored to the first intervention of
//     each speaker via #int-... data attribute).
//
// On md+ this renders as a sticky right column; on small screens the
// page wraps it in a Sheet so it stays out of the way until requested.

interface Props {
  chamber: Chamber
  odg: OdgEntry[]
  oratori: OratoreSummary[]
  /** Map from oratore_nome to the first anchor where they spoke. */
  oratoreAnchors: Map<string, string>
  className?: string
}

type Tab = 'odg' | 'oratori'

export function SedutaIndex({ chamber, odg, oratori, oratoreAnchors, className }: Props) {
  const [tab, setTab] = useState<Tab>('odg')
  const [groupFilter, setGroupFilter] = useState<string | null>(null)

  const uniqueGroups = useMemo(() => {
    const groups = new Set<string>()
    for (const o of oratori) {
      if (o.gruppo) groups.add(o.gruppo)
    }
    return Array.from(groups).sort()
  }, [oratori])

  const filteredOratori = useMemo(() => {
    if (!groupFilter) return oratori
    return oratori.filter((o) => o.gruppo === groupFilter)
  }, [oratori, groupFilter])

  return (
    <nav
      aria-label={t.parlamento.seduta.indexTitle}
      className={cn('flex flex-col gap-3 text-sm', className)}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="font-heading text-base font-semibold tracking-tight text-foreground">
          {t.parlamento.seduta.indexTitle}
        </h2>
        <div className="ml-auto inline-flex rounded-full border border-border p-0.5 text-xs">
          {(['odg', 'oratori'] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'rounded-full px-2.5 py-1 transition-colors',
                tab === id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-pressed={tab === id}
            >
              {id === 'odg' ? t.parlamento.seduta.tabOdg : t.parlamento.seduta.tabOratori}
            </button>
          ))}
        </div>
      </header>
      {tab === 'odg' ? (
        <ol className="space-y-1">
          {odg.length === 0 ? (
            <li className="text-muted-foreground">--</li>
          ) : (
            odg.map((o) => (
              <li key={o.posizione}>
                <a
                  className="block rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  href={`#${o.anchor}`}
                >
                  <span className="mr-2 font-mono tabular-nums text-xs text-muted-foreground/80">
                    {o.posizione}
                  </span>
                  {o.titolo}
                </a>
              </li>
            ))
          )}
        </ol>
      ) : (
        <div className="flex flex-col gap-2">
          {uniqueGroups.length > 1 ? (
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setGroupFilter(null)}
                aria-pressed={groupFilter === null}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
                  groupFilter === null
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {t.parlamento.persona.allGroups}
              </button>
              {uniqueGroups.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGroupFilter(g === groupFilter ? null : g)}
                  aria-pressed={groupFilter === g}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
                    groupFilter === g
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {g}
                </button>
              ))}
            </div>
          ) : null}
          <ul className="space-y-1">
            {filteredOratori.length === 0 ? (
              <li className="text-muted-foreground">--</li>
            ) : (
              filteredOratori.map((o, i) => {
                const key = oratoreKey(o.nome, o.gruppo, o.ruolo)
                const anchor = oratoreAnchors.get(key)
                return (
                  <li
                    key={`${key}-${i}`}
                    className={cn(
                      'flex items-baseline gap-1.5 rounded-md px-2 py-1 transition-colors',
                      'hover:bg-muted',
                    )}
                  >
                    {(() => {
                      const href = personaUrl(chamber, o.id_persona)
                      return href ? (
                        <Link
                          to={href}
                          className="min-w-0 flex-1 truncate text-foreground underline decoration-muted-foreground/30 underline-offset-2 hover:decoration-foreground"
                        >
                          {o.nome}
                        </Link>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-foreground">{o.nome}</span>
                      )
                    })()}
                    {o.gruppo ? (
                      <span className="shrink-0 text-xs text-muted-foreground/80">({o.gruppo})</span>
                    ) : null}
                    <span className="shrink-0 font-mono tabular-nums text-xs text-muted-foreground/80">
                      {o.interventi}
                    </span>
                    {anchor ? (
                      <a
                        href={`#${anchor}`}
                        className="shrink-0 text-muted-foreground/60 hover:text-foreground"
                        title="Vai al primo intervento"
                        aria-label="Vai al primo intervento"
                      >
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                    ) : null}
                  </li>
                )
              })
            )}
          </ul>
        </div>
      )}
    </nav>
  )
}
