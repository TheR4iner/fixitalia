import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, User } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { searchPersone, personaUrl, type PersonaSearchResult } from '@/services/parlamento'
import { cn } from '@/lib/utils'
import { t } from '@/i18n/it'

const DEBOUNCE_MS = 280

interface SpeakerSearchProps {
  className?: string
}

export function SpeakerSearch({ className }: SpeakerSearchProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PersonaSearchResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)

  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const navigate = useNavigate()

  // Close on outside click.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  // Debounced fetch.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (query.trim().length < 2) {
      setResults([])
      setOpen(false)
      setLoading(false)
      return
    }
    setLoading(true)
    timerRef.current = setTimeout(async () => {
      try {
        const res = await searchPersone(query.trim())
        setResults(res.data)
        setOpen(true)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [query])

  function selectResult(r: PersonaSearchResult) {
    const url = personaUrl(r.chamber, r.id_persona)
    if (url) {
      setOpen(false)
      setQuery('')
      navigate(url)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault()
      selectResult(results[activeIdx])
    } else if (e.key === 'Escape') {
      setOpen(false)
      setActiveIdx(-1)
    }
  }

  const hasResults = results.length > 0

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <label htmlFor="speaker-search" className="sr-only">
        {t.parlamento.speakerSearch.label}
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={inputRef}
          id="speaker-search"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIdx(-1)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (results.length > 0) setOpen(true)
          }}
          placeholder={t.parlamento.speakerSearch.placeholder}
          className="pl-9"
          autoComplete="off"
          aria-autocomplete="list"
          aria-controls="speaker-search-results"
          aria-expanded={open}
          aria-activedescendant={activeIdx >= 0 ? `speaker-opt-${activeIdx}` : undefined}
          role="combobox"
        />
        {loading ? (
          <span className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-border border-t-foreground" aria-hidden="true" />
        ) : null}
      </div>

      {open ? (
        <ul
          id="speaker-search-results"
          role="listbox"
          className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-background shadow-lg"
          aria-label={t.parlamento.speakerSearch.label}
        >
          {!hasResults ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">
              {t.parlamento.speakerSearch.noResults}
            </li>
          ) : (
            results.map((r, i) => {
              const legLabel = t.parlamento.speakerSearch.legLabel(r.legs)
              return (
                <li
                  key={`${r.chamber}-${r.id_persona}`}
                  id={`speaker-opt-${i}`}
                  role="option"
                  aria-selected={i === activeIdx}
                  onMouseEnter={() => setActiveIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    selectResult(r)
                  }}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm transition-colors',
                    i === activeIdx ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                    i > 0 && 'border-t border-border',
                  )}
                >
                  <User className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-medium">{r.nome}</span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge variant="outline" className="font-mono text-[10px] uppercase py-0">
                      {r.chamber === 'camera' ? 'CAM' : 'SEN'}
                    </Badge>
                    {legLabel ? (
                      <span className="text-xs tabular-nums text-muted-foreground">{legLabel}</span>
                    ) : null}
                    {r.interventi_n > 0 ? (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {t.parlamento.speakerSearch.interventiLabel(r.interventi_n)}
                      </span>
                    ) : null}
                  </div>
                </li>
              )
            })
          )}
        </ul>
      ) : null}
    </div>
  )
}
