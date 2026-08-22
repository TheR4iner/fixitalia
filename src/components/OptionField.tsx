import { useId, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

// Form controls for the tax simulator's options panel.
//
// These wrap the native <select> and <input> rather than a headless UI
// library on purpose: the sandbox cannot reach the shadcn registry, the
// page needs no custom popover behaviour, and on touch devices the native
// pickers are genuinely better than a rebuilt listbox. Everything is
// styled from the same design tokens the rest of the site uses.
//
// The shell handles the label/hint/aria wiring once so that adding an
// option is a one-liner rather than another copy of the same markup.

interface FieldShellProps {
  label: string
  hint?: string
  controlId: string
  hintId: string
  className?: string
  children: ReactNode
}

function FieldShell({
  label,
  hint,
  controlId,
  hintId,
  className,
  children,
}: FieldShellProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label
        htmlFor={controlId}
        className="text-xs font-medium tracking-wide uppercase text-muted-foreground"
      >
        {label}
      </label>
      {children}
      {hint ? (
        <span id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  )
}

const controlClasses =
  'h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'

export interface SelectOption {
  value: string
  label: string
}

interface SelectFieldProps {
  label: string
  hint?: string
  value: string
  options: ReadonlyArray<SelectOption>
  onChange: (value: string) => void
  className?: string
}

export function SelectField({
  label,
  hint,
  value,
  options,
  onChange,
  className,
}: SelectFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <FieldShell
      label={label}
      hint={hint}
      controlId={id}
      hintId={hintId}
      className={className}
    >
      <select
        id={id}
        value={value}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={controlClasses}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  )
}

interface NumberFieldProps {
  label: string
  hint?: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** Rendered inside the control, e.g. "%" or "EUR". */
  suffix?: string
  className?: string
}

export function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  className,
}: NumberFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <FieldShell
      label={label}
      hint={hint}
      controlId={id}
      hintId={hintId}
      className={className}
    >
      <div className="relative">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          value={Number.isFinite(value) ? value : ''}
          min={min}
          max={max}
          step={step}
          aria-describedby={hint ? hintId : undefined}
          onChange={(e) => {
            const next = Number(e.target.value)
            if (!Number.isFinite(next)) return
            const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next))
            onChange(clamped)
          }}
          className={cn(controlClasses, 'tabular-nums', suffix && 'pr-9')}
        />
        {suffix ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground"
          >
            {suffix}
          </span>
        ) : null}
      </div>
    </FieldShell>
  )
}

interface CheckboxFieldProps {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  className?: string
}

export function CheckboxField({
  label,
  hint,
  checked,
  onChange,
  className,
}: CheckboxFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {/* Hit target stays comfortably above the 36px touch minimum. */}
      <label htmlFor={id} className="flex min-h-9 items-center gap-2.5">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={hint ? hintId : undefined}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 shrink-0 rounded-sm border-input accent-primary outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <span className="text-sm text-foreground">{label}</span>
      </label>
      {hint ? (
        <span id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  )
}
