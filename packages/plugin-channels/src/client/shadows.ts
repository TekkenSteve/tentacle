/**
 * Minimal port of @tentacle/tenancy's shadow controller
 * (packages/plugin-tenancy/src/client/shadows.ts), copied rather than
 * imported because tenancy's client half is not a public module. (Same
 * rationale and shape as @tentacle/persona's copy — see
 * packages/plugin-persona/src/client/shadows.ts.)
 *
 * Semantics preserved: registration rides the slot declaration's lifecycle
 * (`slots.inject`) — if the declaring shell reloads, the callback re-runs
 * and the entry follows — and flips synchronously with the admin-state
 * publication, so the section appears in the same frame the probe resolves.
 */
import type { AdminSource } from './identity.ts'

/** The slot-registry face the controller needs (the real one is ctx.slots). */
export interface SlotsLike {
  inject(seat: string, callback: () => (() => void) | Iterable<() => void, void, void>): unknown
}

/**
 * Register `entry` into `seat` while the resolved caller is an admin;
 * dispose it in any other state so non-admins never see the section.
 */
export function mountWhenAdmin(slots: SlotsLike, seat: string, source: AdminSource, register: () => () => void): void {
  slots.inject(seat, () => {
    let disposeEntry: (() => void) | undefined
    const sync = (): void => {
      if (source.get() === 'admin') {
        disposeEntry ??= register()
      } else {
        disposeEntry?.()
        disposeEntry = undefined
      }
    }
    sync()
    const off = source.subscribe(sync)
    return () => {
      off()
      disposeEntry?.()
      disposeEntry = undefined
    }
  })
}
