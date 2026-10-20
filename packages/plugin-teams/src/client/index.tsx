/**
 * @tentacle/teams — browser half.
 *
 * One admin-only global panel (design 10 §6): the `main` page carrying the
 * team management console, addressed by the `sidebar.panellist` icon of the
 * same id — the same official management-console shape the experts and
 * channels panels use. Teams are first-class operational resources (rosters,
 * contracts, workspaces, channel bindings), so they live in the global
 * navigation between 专家 and 频道, not inside Settings.
 *
 * Both seats register only while the resolved caller is an admin arriving
 * through the Tentacle gateway; direct loopback operators keep the stock
 * client untouched (fail-open, same policy as tenancy/persona/channels — the
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
import { TeamsConsoleView } from './console/teams-console.tsx'
import { TeamsPanelIcon } from './panel-icon.tsx'
import { ensureConsoleStyles } from './console/ui.ts'
import { zh, en } from './locales.ts'

/** The main-panel key and the sidebar list id — one id addresses both seats.
 * Order 25 keeps the team panel right below experts (20) in the sidebar. */
const PANEL_ID = 'tentacle-teams'
const PANEL_ORDER = 25

/** Cordis services this client entry waits for (see dsh.client.inject). */
export const inject = ['slots', 'locale', 'layout']

/**
 * Mount the plugin's browser surfaces.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ensureConsoleStyles()
  ctx.effect(() => ctx.locale.register('tentacle-teams', { zh, en }), 'tentacle-teams: dictionaries')

  const { source, stop } = createAdminSource(browserDeps)
  ctx.effect(() => stop, 'tentacle-teams: admin probe')

  type PanelProps = PropsRuntime<'main'> & PropsLocale<'tentacle-teams'>
  function TeamsPanelPage(props: PanelProps): ReactElement {
    return <TeamsConsoleView t={props.t} />
  }

  type IconProps = PropsRuntime<'sidebar.panellist'> & PropsLocale<'tentacle-teams'>
  function TeamsPanelEntry(props: IconProps): ReactElement {
    return <TeamsPanelIcon size={props.size} active={props.active} />
  }

  mountWhenAdmin(ctx.slots, 'main', source, () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: 'tentacle-teams' },
    TeamsPanelPage,
  ))
  mountWhenAdmin(ctx.slots, 'sidebar.panellist', source, () => ctx.slots.register(
    {
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: PANEL_ORDER,
      locale: 'tentacle-teams',
      label: () => ctx.locale.bind('tentacle-teams')('teams.panel'),
    },
    TeamsPanelEntry,
  ))
}
