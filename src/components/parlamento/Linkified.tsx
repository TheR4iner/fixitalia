import { Fragment, memo, useMemo, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import type { RefTipo, Riferimento } from '@/services/parlamento'

// Render the testo of an intervento as paragraphs with detected legal
// references rendered as inline links. The detection itself is done
// server-side at ingest time (server/lib/parlamento/refs/) and the
// resulting Riferimento[] is delivered alongside the testo in the API
// response. This component only does the offset arithmetic + DOM
// emission; no client-side regex, no raw HTML render path.
//
// Visual: inline anchors with a dotted underline so they read as part
// of the prose, not as call-out CTAs. Title attribute exposes the
// canonical form (e.g. "legge 2017/205") for hover.

interface Props {
  text: string
  refs: Riferimento[]
  className?: string
}

interface Paragraph {
  text: string
  // Absolute offset of the paragraph's first char in the original
  // testo, so we can subtract it from each ref's absolute offset to
  // get a paragraph-local one for slice().
  baseOffset: number
}

function splitParagraphs(text: string): Paragraph[] {
  const out: Paragraph[] = []
  let pos = 0
  while (pos <= text.length) {
    const next = text.indexOf('\n\n', pos)
    if (next === -1) {
      const tail = text.slice(pos)
      if (tail) out.push({ text: tail, baseOffset: pos })
      break
    }
    const chunk = text.slice(pos, next)
    if (chunk) out.push({ text: chunk, baseOffset: pos })
    pos = next + 2
  }
  return out
}

const TIPO_LABEL: Record<RefTipo, string> = {
  legge: 'Legge',
  'decreto.legge': 'Decreto-legge',
  'decreto.legislativo': 'Decreto legislativo',
  dpr: 'D.P.R.',
  costituzione: 'Costituzione',
  ac: 'Atto Camera',
  as: 'Atto Senato',
}

function refTitle(r: Riferimento): string {
  if (r.tipo === 'costituzione' && r.articolo !== null) {
    return `Costituzione, art. ${r.articolo}`
  }
  const label = TIPO_LABEL[r.tipo as RefTipo] ?? r.tipo
  if (r.numero !== null && r.anno !== null) {
    return `${label} ${r.anno}/${r.numero}`
  }
  if (r.numero !== null) {
    return `${label} ${r.numero}`
  }
  return label
}

// Slice a paragraph's text into a flat array of strings + anchor
// elements, in document order. Refs that do not have a usable URL are
// rendered as plain text (no anchor) so we never emit broken links.
function renderParagraph(text: string, refs: Riferimento[]): ReactNode[] {
  if (refs.length === 0) return [text]
  const sorted = [...refs].sort((a, b) => a.start - b.start)
  const out: ReactNode[] = []
  let cursor = 0
  for (const r of sorted) {
    if (r.start < cursor) {
      // Should not happen given server-side dedupe, but skip overlaps
      // defensively rather than render duplicate text.
      continue
    }
    if (cursor < r.start) {
      out.push(text.slice(cursor, r.start))
    }
    const linkText = text.slice(r.start, r.end_offset)
    if (r.url) {
      out.push(
        <a
          key={`${r.start}-${r.tipo}`}
          href={r.url}
          target="_blank"
          rel="noopener noreferrer"
          title={refTitle(r)}
          className="underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 transition-colors hover:decoration-foreground hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {linkText}
        </a>,
      )
    } else {
      out.push(linkText)
    }
    cursor = r.end_offset
  }
  if (cursor < text.length) {
    out.push(text.slice(cursor))
  }
  return out
}

function LinkifiedImpl({ text, refs, className }: Props) {
  const paragraphs = useMemo(() => splitParagraphs(text), [text])
  // Pre-bucket refs by paragraph so renderParagraph does not re-scan
  // the full ref list per paragraph. For a 30-paragraph intervento with
  // 8 refs this is a marginal win, but for an extreme outlier (200
  // paragraphs, 50 refs) it matters.
  const refsByParagraph = useMemo(() => {
    const buckets: Riferimento[][] = paragraphs.map(() => [])
    for (const r of refs) {
      // Find the paragraph whose [base, base+len] window contains the
      // ref. Linear scan is fine -- paragraph counts in this corpus
      // are bounded.
      for (let i = 0; i < paragraphs.length; i += 1) {
        const p = paragraphs[i]
        const end = p.baseOffset + p.text.length
        if (r.start >= p.baseOffset && r.end_offset <= end) {
          buckets[i].push({
            ...r,
            start: r.start - p.baseOffset,
            end_offset: r.end_offset - p.baseOffset,
          })
          break
        }
      }
    }
    return buckets
  }, [paragraphs, refs])

  return (
    <div className={cn('space-y-3', className)}>
      {paragraphs.map((p, i) => (
        <p key={i}>
          {renderParagraph(p.text, refsByParagraph[i]).map((node, j) => (
            <Fragment key={j}>{node}</Fragment>
          ))}
        </p>
      ))}
    </div>
  )
}

export const Linkified = memo(LinkifiedImpl)
