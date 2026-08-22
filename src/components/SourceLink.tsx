import { ExternalLink } from 'lucide-react'

import { cn } from '@/lib/utils'

// Small wrapper around an external-source anchor. Used inside Card
// footers so every "Fonte: ..." label is clickable and clearly marked
// as leading off-site. Consolidating the markup here keeps the styling
// consistent across sections and makes it cheap to tweak later (e.g.
// add tracking or a tooltip).

interface SourceLinkProps {
  label: string
  url: string
  className?: string
}

export function SourceLink({ label, url, className }: SourceLinkProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'inline-flex items-center gap-1 text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline',
        className,
      )}
    >
      {label}
      <ExternalLink aria-hidden="true" className="size-3" />
    </a>
  )
}
