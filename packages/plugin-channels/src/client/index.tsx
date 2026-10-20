/**
 * @tentacle/channels — browser half.
 *
 * One admin-only global panel (design 07 §5): the `main` page carrying the
 * channels console, addressed by the `sidebar.panellist` icon of the same id —
 * the official management-console shape (`dsh-client-ui-schedule` is the
 * reference). Both seats register only while the resolved caller is an admin
 * arriving through the Tentacle gateway; direct loopback operators keep the
 * stock client untouched (fail-open, same policy as tenancy and persona — the
 * gateway policy is the real boundary, these seats are the surface on top).
 */
import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Type-only merges: the slot registry service (ui-renderer), the locale
// service, and the `main` / `sidebar.panellist` slot keys.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { browserDeps, createAdminSource } from './identity.ts'
import { mountWhenAdmin } from './shadows.ts'
import { ChannelsConsoleView } from './console/channels-console.tsx'
import { ChannelsPanelIcon } from './panel-icon.tsx'
import { ensureConsoleStyles } from './console/ui.ts'
import { zh, en } from './locales.ts'

/** The main-panel key and the sidebar list id — one id addresses both seats. */
const PANEL_ID = 'tentacle-channels'
const PANEL_ORDER = 10

/** Cordis services this client entry waits for (see dsh.client.inject). */
export const inject = ['slots', 'locale']

/**
 * Mount the plugin's browser surfaces.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ensureConsoleStyles()
  ctx.effect(() => ctx.locale.register('tentacle-channels', { zh, en }), 'tentacle-channels: dictionaries')

  const { source, stop } = createAdminSource(browserDeps)
  ctx.effect(() => stop, 'tentacle-channels: admin probe')

  type PanelProps = PropsRuntime<'main'> & PropsLocale<'tentacle-channels'>
  function ChannelsPanelPage(props: PanelProps): ReactElement {
    return <ChannelsConsoleView t={props.t} />
  }

  type IconProps = PropsRuntime<'sidebar.panellist'> & PropsLocale<'tentacle-channels'>
  function ChannelsPanelEntry(props: IconProps): ReactElement {
    return <ChannelsPanelIcon size={props.size} active={props.active} />
  }

  mountWhenAdmin(ctx.slots, 'main', source, () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: 'tentacle-channels' },
    ChannelsPanelPage,
  ))
  mountWhenAdmin(ctx.slots, 'sidebar.panellist', source, () => ctx.slots.register(
    {
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: PANEL_ORDER,
      locale: 'tentacle-channels',
      label: () => ctx.locale.bind('tentacle-channels')('channels.panel'),
    },
    ChannelsPanelEntry,
  ))
}
