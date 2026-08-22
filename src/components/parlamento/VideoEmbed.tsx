import { useState } from 'react'
import { Play } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { t } from '@/i18n/it'

// Lazy-mount video embed. The official webtv hosts (webtv.camera.it,
// webtv.senato.it) are loaded only when the user clicks Play, so the
// initial reader render does not pay third-party network or layout
// costs. CSP allowing these hosts in frame-src is configured in
// server/server.ts.

interface Props {
  url: string | null
  fallbackUrl?: string | null
}

export function VideoEmbed({ url, fallbackUrl }: Props) {
  const [active, setActive] = useState(false)

  if (!url) {
    if (fallbackUrl) {
      return (
        <a
          href={fallbackUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {t.parlamento.seduta.videoOpen}
        </a>
      )
    }
    return <p className="text-sm text-muted-foreground">{t.parlamento.seduta.videoNotAvailable}</p>
  }

  if (!active) {
    return (
      <Button type="button" variant="default" size="sm" onClick={() => setActive(true)} className="gap-2">
        <Play className="h-4 w-4" aria-hidden="true" />
        {t.parlamento.seduta.videoOpen}
      </Button>
    )
  }

  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
      <iframe
        src={url}
        title={t.parlamento.seduta.videoEmbedTitle}
        loading="lazy"
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
        className="h-full w-full border-0"
      />
    </div>
  )
}
