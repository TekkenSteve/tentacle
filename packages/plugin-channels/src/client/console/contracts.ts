/**
 * Shared vocabulary of the console's sub-views. Kept in one module so the
 * page shell, the editor and the section components can pass callbacks
 * without importing each other.
 */
import type { ChannelInstanceView } from '../api.ts'

/** What the editor edits: a brand-new instance, or an existing row. */
export type EditTarget =
  | { readonly mode: 'create'; readonly channelType?: string }
  | { readonly mode: 'edit'; readonly instance: ChannelInstanceView }

/** Report one transient outcome; `success` also picks the toast's own glyph. */
export type ToastFn = (message: string, tone?: 'success') => void

/** True when `target` is the editor already open — re-opening is a no-op. */
export function sameTarget(a: EditTarget, b: EditTarget): boolean {
  if (a.mode !== b.mode) return false
  if (a.mode === 'create') return b.mode === 'create' && a.channelType === b.channelType
  return b.mode === 'edit' && a.instance.id === b.instance.id
}
