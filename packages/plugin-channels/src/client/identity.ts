/**
 * Browser-side admin detection — a deliberately narrower port of
 * @tentacle/tenancy's identity resolution (packages/plugin-tenancy/src/
 * client/identity.ts), copied rather than imported because tenancy's client
 * half is not a public module. (Same rationale and shape as
 * @tentacle/persona's copy — see packages/plugin-persona/src/client/identity.ts.)
 *
 * This client needs one bit: "is the caller an admin through the Tentacle
 * gateway?" The probe hits /tentacle/api/whoami once. Admin flips only
 * happen across page loads (login/logout reload), so no watcher is needed.
 * Fail-open by design: any probe failure (stock DSH has no such route,
 * network error) resolves to 'other' and the settings section simply stays
 * unregistered — a broken plugin never degrades the stock client.
 */

/** Minimal fetch face — injectable so tests never touch the network. */
export interface FetchResponseLike {
  readonly ok: boolean
  json(): Promise<unknown>
}

export interface ClientDeps {
  fetch(input: string, init?: { method?: string }): Promise<FetchResponseLike>
}

export type AdminState = 'resolving' | 'admin' | 'other'

export const WHOAMI_PATH = '/tentacle/api/whoami'

export async function resolveAdmin(deps: ClientDeps): Promise<AdminState> {
  try {
    const res = await deps.fetch(WHOAMI_PATH, { method: 'GET' })
    if (!res.ok) return 'other'
    const who = (await res.json().catch(() => ({}))) as { authenticated?: boolean; identity?: { roles?: unknown } }
    const roles = who.identity?.roles
    if (who.authenticated === true && Array.isArray(roles) && roles.includes('admin')) return 'admin'
    return 'other'
  } catch {
    return 'other'
  }
}

/** A uSES-compatible one-bit source, matching tenancy's source shape. */
export interface AdminSource {
  subscribe(fn: () => void): () => void
  get(): AdminState
}

export function createAdminSource(deps: ClientDeps): { source: AdminSource; stop(): void } {
  let state: AdminState = 'resolving'
  let disposed = false
  const listeners = new Set<() => void>()
  void resolveAdmin(deps).then((next) => {
    if (disposed || next === state) return
    state = next
    for (const listener of [...listeners]) listener()
  })
  return {
    source: {
      subscribe(fn) {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
      get: () => state,
    },
    stop: () => { disposed = true },
  }
}

/** Production environment binding. */
export const browserDeps: ClientDeps = {
  fetch: (input, init) => window.fetch(input, init),
}
