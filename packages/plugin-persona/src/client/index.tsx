/**
 * @tentacle/persona — browser half.
 *
 * One admin-only global panel (design 09 §3): the `main` page carrying the
 * expert management console, addressed by the `sidebar.panellist` icon of the
 * same id — the same official management-console shape the channels panel
 * uses (`dsh-client-ui-schedule` is the reference). Experts are first-class
 * operational resources (instances, routing, workspaces, channels), so they
 * live in the global navigation next to 频道, not inside Settings.
 *
 * Both seats register only while the resolved caller is an admin arriving
 * through the Tentacle gateway; direct loopback operators keep the stock
 * client untouched (fail-open, same policy as tenancy and channels — the
 * gateway policy is the real boundary, these seats are the surface on top).
 */
import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Type-only merges: the slot registry service (ui-renderer), the locale
// service, and the `main` / `sidebar.panellist` slot keys.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { browserDeps, createAdminSource } from './identity.ts'
import { mountWhenAdmin } from './shadows.ts'
import { ExpertsConsoleView } from './console/experts-console.tsx'
import { CHANNELS_OPEN_STORAGE_KEY, CHANNELS_PANEL_ID, requestChannelsOpen } from './console/panel-events.ts'
import { ExpertsPanelIcon } from './panel-icon.tsx'
import { ensureConsoleStyles } from './console/ui.ts'
import { zh, en } from './locales.ts'

/** The main-panel key and the sidebar list id — one id addresses both seats. */
const PANEL_ID = 'tentacle-experts'
const PANEL_ORDER = 20

/** Cordis services this client entry waits for (see dsh.client.inject). */
export const inject = ['slots', 'locale', 'layout']

/**
 * Mount the plugin's browser surfaces.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ensureConsoleStyles()
  ctx.effect(() => ctx.locale.register('tentacle-persona', { zh, en }), 'tentacle-persona: dictionaries')

  const { source, stop } = createAdminSource(browserDeps)
  ctx.effect(() => stop, 'tentacle-persona: admin probe')

  /**
   * Cross-panel hop: record the expert intent, then select the channels main
   * panel. `selectPanel` throws when no channels panel is registered (the
   * channels plugin is optional in a persona-only install) — ignore it.
   */
  const openChannels = (expertId: string, create = false): void => {
    requestChannelsOpen(expertId, create)
    try {
      ctx.layout.selectPanel(CHANNELS_PANEL_ID as MainPanelId)
    } catch {
      // No channels panel in this composition: drop the hand-off so it cannot
      // fire on an unrelated later mount.
      window.sessionStorage.removeItem(CHANNELS_OPEN_STORAGE_KEY)
    }
  }

  type PanelProps = PropsRuntime<'main'> & PropsLocale<'tentacle-persona'>
  function ExpertsPanelPage(props: PanelProps): ReactElement {
    return <ExpertsConsoleView t={props.t} onOpenChannels={openChannels} />
  }

  type IconProps = PropsRuntime<'sidebar.panellist'> & PropsLocale<'tentacle-persona'>
  function ExpertsPanelEntry(props: IconProps): ReactElement {
    return <ExpertsPanelIcon size={props.size} active={props.active} />
  }

  mountWhenAdmin(ctx.slots, 'main', source, () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: 'tentacle-persona' },
    ExpertsPanelPage,
  ))
  mountWhenAdmin(ctx.slots, 'sidebar.panellist', source, () => ctx.slots.register(
    {
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: PANEL_ORDER,
      locale: 'tentacle-persona',
      label: () => ctx.locale.bind('tentacle-persona')('experts.panel'),
    },
    ExpertsPanelEntry,
  ))
}
