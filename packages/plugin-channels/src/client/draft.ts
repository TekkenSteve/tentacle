/**
 * Draft persistence for the channel form (design 07 §5).
 *
 * A draft survives an accidental panel switch but not a save: it lives in
 * `sessionStorage` under `tentacle:channel-draft:{scope}`, where the scope is
 * one instance (`instance:{id}`) or one not-yet-created type (`new:{type}`).
 *
 * Secrets never enter a draft — the form stores only the name and the
 * non-secret config block, so the credential is absent by construction rather
 * than by a filter someone could forget to update.
 *
 * Storage is a port: production binds `sessionStorage`, tests may bind a stub,
 * and a missing/blocked storage degrades to "no draft" instead of throwing.
 */
export type DraftScope =
  | { readonly kind: 'instance'; readonly id: string }
  | { readonly kind: 'new'; readonly channelType: string }

export interface ChannelDraft {
  readonly name: string
  readonly config: Record<string, unknown>
}

/** The slice of the Storage API a draft needs. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const DRAFT_PREFIX = 'tentacle:channel-draft:'

export function draftKey(scope: DraftScope): string {
  return scope.kind === 'instance'
    ? `${DRAFT_PREFIX}instance:${scope.id}`
    : `${DRAFT_PREFIX}new:${scope.channelType}`
}

function defaultStorage(): DraftStorage | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    // A hardened/SSR context without sessionStorage simply has no drafts.
    return undefined
  }
}

/**
 * Read one draft. Malformed JSON, a non-object payload or a missing config
 * block counts as "no draft" — an unreadable draft must never break the form.
 */
export function loadDraft(scope: DraftScope, storage: DraftStorage | undefined = defaultStorage()): ChannelDraft | undefined {
  if (storage === undefined) return undefined
  let raw: string | null
  try {
    raw = storage.getItem(draftKey(scope))
  } catch {
    return undefined
  }
  if (raw === null) return undefined

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  const record = value as Record<string, unknown>
  const name = typeof record['name'] === 'string' ? record['name'] : ''
  const config = record['config']
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return name === '' ? undefined : { name, config: {} }
  }
  return { name, config: config as Record<string, unknown> }
}

export function saveDraft(scope: DraftScope, draft: ChannelDraft, storage: DraftStorage | undefined = defaultStorage()): void {
  if (storage === undefined) return
  try {
    storage.setItem(draftKey(scope), JSON.stringify(draft))
  } catch {
    // Quota or private mode: a draft is a convenience, never a hard failure.
  }
}

export function clearDraft(scope: DraftScope, storage: DraftStorage | undefined = defaultStorage()): void {
  if (storage === undefined) return
  try {
    storage.removeItem(draftKey(scope))
  } catch {
    // Nothing to do — the caller already moved on.
  }
}
