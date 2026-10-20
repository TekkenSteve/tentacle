/**
 * Cross-panel protocol: from an expert card, open the channels console with
 * that expert already selected (or with its "new channel" form opened).
 *
 * The main-panel selection rides the official `ctx.layout.selectPanel`; the
 * *intent* travels on a window event plus a sessionStorage hand-off, because
 * the channels panel may still be unmounted when the click happens (the event
 * covers an already-mounted panel, the storage key the mount-after-select
 * path). The channels console mirrors these constants in its own source —
 * the two client bundles cannot import each other.
 */
export const CHANNELS_PANEL_ID = 'tentacle-channels'
export const CHANNELS_OPEN_EVENT = 'tentacle:channels/open'
export const CHANNELS_OPEN_STORAGE_KEY = 'tentacle:channels:open'

export interface ChannelsOpenRequest {
  readonly expertId: string
  readonly create: boolean
}

/** Record the intent for the channels console and announce it if it is live. */
export function requestChannelsOpen(expertId: string, create = false): void {
  const request: ChannelsOpenRequest = { expertId, create }
  try {
    window.sessionStorage.setItem(CHANNELS_OPEN_STORAGE_KEY, JSON.stringify(request))
  } catch {
    // Private-mode storage failures must not block navigation.
  }
  window.dispatchEvent(new CustomEvent<ChannelsOpenRequest>(CHANNELS_OPEN_EVENT, { detail: request }))
}
