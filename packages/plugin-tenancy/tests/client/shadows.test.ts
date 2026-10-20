/**
 * Shadow registration semantics (research §1.7): a shadow registers only
 * while the resolved identity is a normal user, synchronously with the
 * identity publication; any other state disposes it (stock UI restored);
 * the slot-declaration teardown disposes it too.
 */
import { describe, expect, it } from 'vitest'
import { installShadows, type SlotsLike } from '../../src/client/shadows.ts'
import type { IdentitySource, IdentityState } from '../../src/client/identity.ts'

/** A manually driven identity source. */
function manualSource(initial: IdentityState): IdentitySource & { set(state: IdentityState): void } {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(next) { state = next; for (const fn of [...listeners]) fn() },
    refresh() {},
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
}

/** A fake slot registry: inject() activates the callback immediately. */
function fakeSlots() {
  const injections: Array<{ seat: string; dispose: () => void }> = []
  const slots: SlotsLike = {
    inject(seat, callback) {
      const effect = callback()
      const dispose = typeof effect === 'function' ? effect : () => {}
      injections.push({ seat, dispose })
      return dispose
    },
  }
  return { slots, injections }
}

const USER: IdentityState = {
  kind: 'user',
  identity: { subjectId: 'did:key:z6MkAlice', handle: 'alice', roles: ['user'] },
  workspaceRootDir: '/ws/alice',
}
const ADMIN: IdentityState = {
  kind: 'admin',
  identity: { subjectId: 'did:key:z6MkAdmin', handle: 'admin', roles: ['admin'] },
}

describe('installShadows', () => {
  it('registers the shadow when the identity is already a user at inject time', () => {
    const { slots } = fakeSlots()
    let registered = 0
    let disposed = 0
    installShadows(slots, manualSource(USER), [
      { seat: 'sidebar.workspaces', register: () => { registered += 1; return () => { disposed += 1 } } },
    ])
    expect(registered).toBe(1)
    expect(disposed).toBe(0)
  })

  it('never registers for resolving/anonymous/direct/admin', () => {
    for (const state of [{ kind: 'resolving' }, { kind: 'anonymous' }, { kind: 'direct' }, ADMIN] as IdentityState[]) {
      const { slots } = fakeSlots()
      let registered = 0
      installShadows(slots, manualSource(state), [
        { seat: 'sidebar.settings', register: () => { registered += 1; return () => {} } },
      ])
      expect(registered, `state ${state.kind}`).toBe(0)
    }
  })

  it('registers synchronously with the identity publication (same tick)', () => {
    const { slots } = fakeSlots()
    const source = manualSource({ kind: 'resolving' })
    let registered = 0
    installShadows(slots, source, [
      { seat: 'sidebar.workspaces', register: () => { registered += 1; return () => {} } },
    ])
    expect(registered).toBe(0)
    source.set(USER)
    // no await, no microtask: the shadow is in place inside the publication
    expect(registered).toBe(1)
  })

  it('disposes on identity flip away from user and re-registers on return', () => {
    const { slots } = fakeSlots()
    const source = manualSource(USER)
    let live = 0
    installShadows(slots, source, [
      { seat: 'sidebar.workspaces', register: () => { live += 1; return () => { live -= 1 } } },
    ])
    expect(live).toBe(1)
    source.set(ADMIN)
    expect(live).toBe(0)
    source.set(USER)
    expect(live).toBe(1)
  })

  it('does not double-register on repeat publications of the user state', () => {
    const { slots } = fakeSlots()
    const source = manualSource(USER)
    let registered = 0
    installShadows(slots, source, [
      { seat: 'sidebar.settings', register: () => { registered += 1; return () => {} } },
    ])
    source.set(USER)
    source.set(USER)
    expect(registered).toBe(1)
  })

  it('slot-declaration teardown disposes a live shadow', () => {
    const { slots, injections } = fakeSlots()
    let live = 0
    installShadows(slots, manualSource(USER), [
      { seat: 'sidebar.settings', register: () => { live += 1; return () => { live -= 1 } } },
    ])
    expect(live).toBe(1)
    injections[0]!.dispose()
    expect(live).toBe(0)
  })

  it('controls every seat independently', () => {
    const { slots, injections } = fakeSlots()
    const live: Record<string, number> = { 'sidebar.workspaces': 0, 'sidebar.settings': 0 }
    installShadows(slots, manualSource(USER), [
      { seat: 'sidebar.workspaces', register: () => { live['sidebar.workspaces']! += 1; return () => { live['sidebar.workspaces']! -= 1 } } },
      { seat: 'sidebar.settings', register: () => { live['sidebar.settings']! += 1; return () => { live['sidebar.settings']! -= 1 } } },
    ])
    expect(injections.map((i) => i.seat)).toEqual(['sidebar.workspaces', 'sidebar.settings'])
    expect(live).toEqual({ 'sidebar.workspaces': 1, 'sidebar.settings': 1 })
  })
})

describe('installShadows with a custom when predicate', () => {
  it('installs for the admin state and leaves user/anonymous untouched', () => {
    const { slots } = fakeSlots()
    const source = manualSource(ADMIN)
    let registrations = 0
    installShadows(slots, source, [
      {
        seat: 'sidebar.footer.action',
        when: (state) => state.kind === 'admin',
        register: () => { registrations++; return () => { registrations-- } },
      },
    ])
    expect(registrations).toBe(1)
    source.set(USER)
    expect(registrations).toBe(0)
    source.set(ADMIN)
    expect(registrations).toBe(1)
  })

  it('default predicate still targets only the user state', () => {
    const { slots } = fakeSlots()
    const source = manualSource(ADMIN)
    let registrations = 0
    installShadows(slots, source, [
      { seat: 'sidebar.settings', register: () => { registrations++; return () => { registrations-- } } },
    ])
    expect(registrations).toBe(0)
    source.set(USER)
    expect(registrations).toBe(1)
  })
})
