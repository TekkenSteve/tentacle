/**
 * The shadow controller (research §1.7 `shadowWhenUser`, JSX-free so the
 * registration semantics are unit-testable without the client runtime):
 *
 * While the resolved identity is a normal user, each seat registers its
 * shadow entry at a priority BELOW the stock entry (single-kind cells render
 * the lowest-priority registration); any other state disposes it and the
 * stock entry takes the cell back. Registration happens synchronously inside
 * the identity publication — subscribers run before React re-renders the
 * subscribed entries, so the restricted UI is in place in the same frame the
 * identity flips, never a tick later.
 *
 * Registration rides the slot declaration's lifecycle (`slots.inject`): if
 * the declaring shell reloads, the callback re-runs and the shadow follows.
 */
import type { IdentitySource, IdentityState } from './identity.ts'

/** The slot-registry face the controller needs (the real one is ctx.slots). */
export interface SlotsLike {
  inject(seat: string, callback: () => (() => void) | Iterable<() => void, void, void>): unknown
}

/** One shadowable seat: its slot key plus the real register call. */
export interface ShadowSeat {
  readonly seat: string
  readonly register: () => () => void
  /**
   * Which identity state installs the entry. Default: normal users only
   * (`state.kind === 'user'`). Admin-side entries (e.g. the console badge)
   * pass `state.kind === 'admin'`.
   */
  readonly when?: (state: IdentityState) => boolean
}

/** Install one shadow controller per seat, bound to the slot declarations. */
export function installShadows(slots: SlotsLike, source: IdentitySource, seats: readonly ShadowSeat[]): void {
  for (const { seat, register, when } of seats) {
    slots.inject(seat, () => {
      let disposeShadow: (() => void) | undefined
      const active = when ?? ((state: IdentityState) => state.kind === 'user')
      const sync = (state: IdentityState): void => {
        if (active(state)) {
          disposeShadow ??= register()
        } else {
          disposeShadow?.()
          disposeShadow = undefined
        }
      }
      sync(source.get())
      const off = source.subscribe(() => sync(source.get()))
      return () => {
        off()
        disposeShadow?.()
        disposeShadow = undefined
      }
    })
  }
}
