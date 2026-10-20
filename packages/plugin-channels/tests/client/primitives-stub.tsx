/**
 * A real-DOM stand-in for `@deepseek-ai/dsh-client-ui-primitives`, used through
 * `vi.mock` by the client tests.
 *
 * Why a double is needed at all: the published package ships its source ESM
 * (not a bundle), so importing it under jsdom pulls in `clsx` and
 * `@deepseek-ai/dsh-util-workspace-path` — dev-dependencies it does not
 * install for consumers — plus `.module.css` files that only a bundler can
 * process. The failure is `Cannot find package 'clsx'`.
 *
 * The double is deliberately thin and renders the SAME semantics the real
 * atoms do — a `Button` is a native button, a `Switch` is a native button with
 * `role="switch"`/`aria-checked`, `Modal` an `aria-modal` `role="dialog"`
 * labelled by its title, `Toast` a `role="alert"` that reports completion
 * after its hold — so the console's behaviour assertions stay meaningful.
 * Visual styling is not reproduced; the console tests assert structure and
 * copy, never pixels.
 *
 * Overlays render in place rather than through `createPortal`: this workspace
 * installs no `@types/react-dom`, and every assertion goes through
 * `screen.*`/`within(dialog)`, which do not depend on the portal target.
 */
import { forwardRef, useEffect, useRef } from 'react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react'

// ---- icons ---------------------------------------------------------------

interface IconProps {
  size?: number
  className?: string
}

function glyph(name: string) {
  return function Icon({ size = 16, className }: IconProps): ReactElement {
    return <svg data-icon={name} width={size} height={size} className={className} aria-hidden="true" />
  }
}

export const IconRefreshOutlineRegular = glyph('IconRefreshOutlineRegular')
export const IconPlusOutlineRegular = glyph('IconPlusOutlineRegular')
export const IconEditOutlineRegular = glyph('IconEditOutlineRegular')
export const IconLinkOutlineRegular = glyph('IconLinkOutlineRegular')
export const IconTrashOutlineRegular = glyph('IconTrashOutlineRegular')
export const IconSendOutlineRegular = glyph('IconSendOutlineRegular')
export const IconWarningOutlineRegular = glyph('IconWarningOutlineRegular')
export const IconSearchOutlineRegular = glyph('IconSearchOutlineRegular')
export const IconPaperPlaneOutlineRegular = glyph('IconPaperPlaneOutlineRegular')
export const IconPaperPlaneOutlineMedium = glyph('IconPaperPlaneOutlineMedium')
export const IconShareOutlineRegular = glyph('IconShareOutlineRegular')
export const IconCopyOutlineRegular = glyph('IconCopyOutlineRegular')

/** Clipboard writes are recorded so tests can assert what was offered. */
export const clipboardWrites: string[] = []

export async function writeClipboard(text: string): Promise<boolean> {
  clipboardWrites.push(text)
  return true
}

// ---- controls ------------------------------------------------------------

export const Button = forwardRef<HTMLButtonElement, {
  variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
  size?: 'md' | 'sm'
  icon?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>>(function Button(
  { variant = 'ghost', size = 'md', icon, children, ...rest },
  ref,
): ReactElement {
  return (
    <button ref={ref} type="button" data-variant={variant} data-size={size} {...rest}>
      {icon}
      {children}
    </button>
  )
})

export function Tag({ tone = 'outline', children }: { tone?: string; children?: ReactNode }): ReactElement {
  return <span data-tone={tone}>{children}</span>
}

export function Switch({ checked, onChange, label, disabled, title }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export const Input = forwardRef<HTMLInputElement, { icon?: ReactNode } & InputHTMLAttributes<HTMLInputElement>>(
  function Input({ icon, ...rest }, ref): ReactElement {
    return (
      <span data-input="">
        {icon}
        <input ref={ref} {...rest} />
      </span>
    )
  },
)

export function Tooltip({ children }: { label: string | (() => string); children: ReactNode }): ReactElement {
  return <>{children}</>
}

export function StateDot({ state, size }: { state: string; size?: number }): ReactElement {
  return <span data-state={state} data-size={size} aria-hidden="true" />
}

// ---- overlays ------------------------------------------------------------

export function Modal({ open, onClose, title, closeLabel, description, children, footer }: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
}): ReactElement | null {
  if (!open) return null
  return (
    <div data-modal="">
      <div role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <button type="button" aria-label={closeLabel} onClick={onClose}>×</button>
        {description !== undefined && description !== '' && <p>{description}</p>}
        {children}
        {footer !== undefined && <div>{footer}</div>}
      </div>
    </div>
  )
}

export function Toast({ text, tone, holdMs = 3000, onDone }: {
  text: string
  tone?: 'success'
  holdMs?: number
  onDone: () => void
}): ReactElement {
  const latest = useRef(onDone)
  latest.current = onDone
  useEffect(() => {
    const timer = setTimeout(() => latest.current(), holdMs)
    return () => clearTimeout(timer)
  }, [holdMs])
  return <div role="alert" data-tone={tone}>{text}</div>
}

// ---- time ----------------------------------------------------------------

/**
 * The official bucketing, copied verbatim: the tests must not re-implement it
 * differently from the package the console renders with in production.
 */
export function relativeTime(at: number, now: number): { unit: string; n: number } {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - at)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}
