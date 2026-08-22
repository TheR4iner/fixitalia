import { Settings2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { t } from '@/i18n/it'
import type {
  ReaderFont,
  ReaderLine,
  ReaderPrefs,
  ReaderSize,
} from '@/hooks/useReaderPrefs'

// Reader settings popover (Sheet on small screens). Exposes the three
// dimensions the user can tune: typeface family, font size, line height.
// Persistence is handled by the parent via useReaderPrefs.

interface Props {
  prefs: ReaderPrefs
  onChange: (next: Partial<ReaderPrefs>) => void
}

const FONT_OPTIONS: Array<{ value: ReaderFont; label: string }> = [
  { value: 'serif', label: t.parlamento.reader.fontSerif },
  { value: 'sans', label: t.parlamento.reader.fontSans },
  { value: 'mono', label: t.parlamento.reader.fontMono },
]

const SIZE_OPTIONS: ReaderSize[] = [16, 18, 20, 22]
const LINE_OPTIONS: ReaderLine[] = [1.5, 1.7, 1.9]

function PillRow<T extends string | number>({
  options,
  value,
  onSelect,
  formatLabel,
}: {
  options: Array<{ value: T; label: string }> | T[]
  value: T
  onSelect: (next: T) => void
  formatLabel?: (v: T) => string
}) {
  const opts: Array<{ value: T; label: string }> = Array.isArray(options)
    ? typeof options[0] === 'object'
      ? (options as Array<{ value: T; label: string }>)
      : (options as T[]).map((v) => ({
          value: v,
          label: formatLabel ? formatLabel(v) : String(v),
        }))
    : []
  return (
    <div className="flex flex-wrap gap-2">
      {opts.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onSelect(o.value)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-sm transition-colors',
              selected
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            aria-pressed={selected}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function ReaderSettings({ prefs, onChange }: Props) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Settings2 className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">{t.parlamento.seduta.readerSettings}</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t.parlamento.seduta.readerSettings}</SheetTitle>
          <SheetDescription>{t.parlamento.reader.prefsHint}</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 py-2">
          <section>
            <h3 className="mb-2 text-sm font-medium text-foreground">
              {t.parlamento.reader.fontLabel}
            </h3>
            <PillRow
              options={FONT_OPTIONS}
              value={prefs.font}
              onSelect={(font) => onChange({ font: font as ReaderFont })}
            />
          </section>
          <section>
            <h3 className="mb-2 text-sm font-medium text-foreground">
              {t.parlamento.reader.sizeLabel}
            </h3>
            <PillRow
              options={SIZE_OPTIONS}
              value={prefs.size}
              onSelect={(size) => onChange({ size: size as ReaderSize })}
              formatLabel={(v) => `${v}px`}
            />
          </section>
          <section>
            <h3 className="mb-2 text-sm font-medium text-foreground">
              {t.parlamento.reader.lineLabel}
            </h3>
            <PillRow
              options={LINE_OPTIONS}
              value={prefs.line}
              onSelect={(line) => onChange({ line: line as ReaderLine })}
              formatLabel={(v) => String(v)}
            />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
