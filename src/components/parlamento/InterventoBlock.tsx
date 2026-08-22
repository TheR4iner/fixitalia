import { memo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Link2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { t } from '@/i18n/it'
import { personaUrl, type Intervento } from '@/services/parlamento'
import { Linkified } from './Linkified'

// One speaker turn in the reader. The visual cue separating turns is the
// speaker name (set in the heading face), with a thin coloured spine on
// the left tinted by the parliamentary group via groupAccent. The body
// is split on `\n\n` paragraph markers and rendered as React text nodes,
// so no raw-HTML render path exists and no sanitiser is required.
//
// Reader typography (font, size, line height) is consumed via the
// CSS custom properties --reader-size, --reader-line, --reader-family
// set on the parent <article> in SedutaPage. Reading them through the
// cascade rather than as React props means a 1000-intervento seduta
// does not trigger 1000 re-renders when the user nudges a slider; only
// the wrapping inline-style on the parent updates and the browser
// re-resolves the variable in one pass. The component is memo'd so
// React confirms prop-stability and skips reconciliation entirely.

interface Props {
  intervento: Intervento
  groupAccent?: string
}

function InterventoBlockImpl({ intervento, groupAccent }: Props) {
  const [copied, setCopied] = useState(false)

  function copyAnchor() {
    const url = `${window.location.origin}${window.location.pathname}#${intervento.anchor}`
    navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      },
      () => {
        // best-effort; if clipboard fails, ignore
      },
    )
  }

  const accent = groupAccent ?? 'var(--border)'

  return (
    <article
      id={intervento.anchor}
      className={cn(
        'group scroll-mt-24 border-l-2 pl-4 sm:pl-6',
        'transition-colors target:bg-muted/40 hover:bg-muted/20',
      )}
      style={{ borderLeftColor: accent }}
    >
      <header className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-heading text-base font-semibold tracking-tight text-foreground sm:text-lg">
          {(() => {
            const href = personaUrl(intervento.oratore_chamber, intervento.oratore_id_persona)
            const label = intervento.oratore_nome ?? 'Intervento anonimo'
            return href ? (
              <Link
                to={href}
                className="underline decoration-muted-foreground/30 underline-offset-4 hover:decoration-foreground"
              >
                {label}
              </Link>
            ) : (
              label
            )
          })()}
        </h3>
        {intervento.ruolo ? (
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {intervento.ruolo}
          </span>
        ) : null}
        {intervento.gruppo ? (
          <span className="text-xs text-muted-foreground">{intervento.gruppo}</span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={copyAnchor}
          className="ml-auto h-7 px-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:h-9 pointer-coarse:opacity-100"
          aria-label={t.parlamento.seduta.copyLink}
          title={t.parlamento.seduta.copyLink}
        >
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="ml-1 hidden sm:inline">
            {copied ? t.parlamento.seduta.linkCopied : t.parlamento.seduta.copyLink}
          </span>
        </Button>
      </header>
      <Linkified
        text={intervento.testo}
        refs={intervento.riferimenti ?? []}
        className="text-foreground/90 [font-family:var(--reader-family,inherit)] [font-size:var(--reader-size,1rem)] [line-height:var(--reader-line,1.6)]"
      />
    </article>
  )
}

export const InterventoBlock = memo(InterventoBlockImpl)
