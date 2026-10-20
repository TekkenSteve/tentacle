/**
 * Browser-side identity resolution: one shared answer to "who is at this
 * browser, and did they arrive through the Tentacle gateway?" that drives
 * every restricted seat (design 02 §2 推论 + research §1.7).
 *
 * Five states:
 *  - `resolving` — probe in flight (initial; entries render nothing yet).
 *  - `direct`    — the page was NOT served through the gateway: `/tentacle/
 *    api/whoami` 404s (stock DSH webserver has no such route) or the request
 *    failed outright. This is the operator/admin loopback path — the plugin
 *    must NEVER intervene here, so every shadow stays off (fail-open).
 *  - `anonymous` — gateway reached, no Tentacle session. The gateway itself
 *    gates traffic in required mode; the client adds nothing.
 *  - `user`      — authenticated non-admin. The restricted UI shadows apply.
 *  - `admin`     — authenticated admin. Stock UI, untouched.
 *
 * Fail-open by design: a broken plugin API never degrades the stock client
 * (king-bcolor's policy, kept verbatim). The hard boundary lives in the
 * gateway policy; the shadows are the anti-misclick layer on top.
 */

/** Minimal fetch face — injectable so tests never touch the network. */
export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export interface ClientDeps {
  fetch(input: string, init?: { method?: string }): Promise<FetchResponseLike>
}

/** The identity payload both gateway `/whoami` and tenancy `/me` return. */
export interface CallerIdentity {
  subjectId: string
  handle: string
  displayName?: string
  roles: string[]
}

/** One identity resolution. */
export type IdentityState =
  | { kind: 'resolving' }
  | { kind: 'anonymous' }
  | { kind: 'direct' }
  | { kind: 'admin'; identity: CallerIdentity }
  | { kind: 'user'; identity: CallerIdentity; workspaceRootDir: string | undefined }

export const WHOAMI_PATH = '/tentacle/api/whoami'
export const ME_PATH = '/tentacle/api/me'

function parseIdentity(value: unknown): CallerIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.subjectId !== 'string' || typeof raw.handle !== 'string') return undefined
  if (!Array.isArray(raw.roles) || raw.roles.some((r) => typeof r !== 'string')) return undefined
  return {
    subjectId: raw.subjectId,
    handle: raw.handle,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
    roles: raw.roles as string[],
  }
}

/**
 * Resolve once: whoami → (non-admin) /me for the workspace fence.
 *
 * Any non-OK whoami (404 from stock DSH, 5xx, network throw) maps to
 * `direct`: the only deployment where whoami answers 200 is behind the
 * gateway, so anything else is treated as "no gateway, no intervention".
 */
export async function resolveIdentity(deps: ClientDeps): Promise<IdentityState> {
  let who: { authenticated?: boolean; identity?: unknown }
  try {
    const res = await deps.fetch(WHOAMI_PATH, { method: 'GET' })
    if (!res.ok) return { kind: 'direct' }
    who = (await res.json().catch(() => ({}))) as typeof who
  } catch {
    return { kind: 'direct' }
  }
  if (who.authenticated !== true) return { kind: 'anonymous' }
  const identity = parseIdentity(who.identity)
  if (!identity) return { kind: 'anonymous' }
  if (identity.roles.includes('admin')) return { kind: 'admin', identity }

  // Normal user: fetch their workspace fence for the sidebar filter. A /me
  // failure leaves the root undefined — the shadow then shows the full feed
  // rather than hiding everything (fail-open display; the gateway fence is
  // the real boundary, this list is a convenience projection).
  let workspaceRootDir: string | undefined
  try {
    const res = await deps.fetch(ME_PATH, { method: 'GET' })
    if (res.ok) {
      const me = (await res.json().catch(() => ({}))) as { workspaceRootDir?: unknown }
      if (typeof me.workspaceRootDir === 'string') workspaceRootDir = me.workspaceRootDir
    }
  } catch {
    // see above — the fence value is a display input, not a gate
  }
  return { kind: 'user', identity, workspaceRootDir }
}

/** Only normal users get the restricted (shadowed) UI. */
export function shouldRestrictUi(state: IdentityState): boolean {
  return state.kind === 'user'
}

/**
 * A uSES-compatible identity source: one shared resolution republished on
 * demand (`refresh`). Shadow controllers subscribe imperatively; entries use
 * it through useSyncExternalStore.
 */
export interface IdentitySource {
  subscribe(fn: () => void): () => void
  get(): IdentityState
  /** Re-run resolution (login/logout land on a fresh page load, so this is
   *  primarily for tests and future in-page auth flips). */
  refresh(): void
}

function sameIdentity(a: CallerIdentity | undefined, b: CallerIdentity | undefined): boolean {
  return a?.subjectId === b?.subjectId && a?.handle === b?.handle && a?.roles.join() === b?.roles.join()
}

function sameState(a: IdentityState, b: IdentityState): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'user' && b.kind === 'user') {
    return sameIdentity(a.identity, b.identity) && a.workspaceRootDir === b.workspaceRootDir
  }
  if (a.kind === 'admin' && b.kind === 'admin') return sameIdentity(a.identity, b.identity)
  return true
}

/**
 * Build the source + its watcher stopper (one per plugin lifetime). Publishes
 * 'resolving' synchronously, then the resolved state; repeat publications of
 * an equal state are swallowed so subscribers are not stormed.
 */
export function createIdentitySource(deps: ClientDeps): { source: IdentitySource; stop(): void } {
  let state: IdentityState = { kind: 'resolving' }
  let disposed = false
  const listeners = new Set<() => void>()
  const publish = (next: IdentityState): void => {
    if (disposed || sameState(next, state)) return
    state = next
    for (const listener of [...listeners]) listener()
  }
  const run = (): void => {
    void resolveIdentity(deps).then(publish)
  }
  run()
  return {
    source: {
      subscribe(fn) {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
      get: () => state,
      refresh: run,
    },
    stop: () => { disposed = true },
  }
}

/** Production environment binding. */
export const browserDeps: ClientDeps = {
  fetch: (input, init) => window.fetch(input, init),
}
