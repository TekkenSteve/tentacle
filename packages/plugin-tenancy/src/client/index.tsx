/**
 * @tentacle/tenancy — browser half.
 *
 * Admin surfaces: the unified admin console as a GLOBAL panel (`main` +
 * `sidebar.panellist`, next to 频道/专家) for admin identities. User-side
 * narrowing: when a NORMAL USER reaches the official Web UI through the
 * Tentacle gateway, narrow the interface to their identity (design 02 §2:
 * the stock UI always speaks as the operator Peer, so per-user narrowing at
 * the display layer is a plugin's job — the gateway policy is the real
 * boundary, these shadows are the anti-misclick layer on top):
 *
 *  - `sidebar.workspaces` shadow: only the sessions cwd-bucketed into the
 *    user's fenced workspace root;
 *  - `sidebar.settings` shadow: renders nothing — the settings entry point
 *    disappears.
 *
 * Admins, anonymous visitors and DIRECT loopback connections (operator
 * bypassing the gateway) keep the stock UI untouched — `direct` resolution
 * registers nothing at all, so a bypassed gateway never locks an operator
 * out of their own UI.
 *
 * Shadows follow the official slot semantics (research §1.7): single-kind
 * cells render the LOWEST priority entry, so the shadows register at
 * priority -10 and dispose restores stock. Registration flips synchronously
 * with the identity publication (see ./shadows.ts).
 */
import { useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only merges: the slot registry service (ui-renderer), the locale
// service, the slot keys (ui-sidebar), the sessions standard-prop hook
// (ui-session), and the navigation service (ui-workspace).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { browserDeps, createIdentitySource, type IdentitySource, type IdentityState } from './identity.ts'
import { installShadows } from './shadows.ts'
import { RestrictedSettingsView, RestrictedWorkspacesView } from './restricted.tsx'
import { AdminConsoleView } from './admin-console.tsx'
import { AdminPanelIcon } from './panel-icon.tsx'
import { zh, en } from './locales.ts'

/** The main-panel key and the sidebar list id — one id addresses both seats. */
const ADMIN_PANEL_ID = 'tentacle-admin'
const ADMIN_PANEL_ORDER = 30

/** Cordis services this client entry waits for (see dsh.client.inject). */
export const inject = ['slots', 'locale', 'uiWorkspace']

export type { IdentityState, IdentitySource }

/** Subscribe a component to the shared identity resolution. */
function useIdentity(source: IdentitySource): IdentityState {
  return useSyncExternalStore(source.subscribe, source.get)
}

/**
 * Mount the plugin's browser surfaces.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('tentacle', { zh, en }), 'tentacle: dictionaries')

  const { source, stop } = createIdentitySource(browserDeps)
  ctx.effect(() => stop, 'tentacle: identity watcher')

  type WorkspacesProps = PropsRuntime<'sidebar.workspaces'> & PropsLocale<'tentacle'>
  function RestrictedWorkspacesEntry(props: WorkspacesProps): ReactElement | null {
    const state = useIdentity(source)
    if (state.kind !== 'user') return null
    return (
      <RestrictedWorkspacesView
        t={props.t}
        wide={props.wide}
        useSessions={(selector) => props.useSessions(selector)}
        openSession={(sessionId) => ctx.uiWorkspace.openSession(sessionId as SessionId)}
        workspaceRootDir={state.workspaceRootDir}
        handle={state.identity.handle}
      />
    )
  }

  type SettingsProps = PropsRuntime<'sidebar.settings'> & PropsLocale<'tentacle'>
  function RestrictedSettingsEntry(_props: SettingsProps): ReactElement | null {
    return <RestrictedSettingsView />
  }

  type AdminPanelProps = PropsRuntime<'main'> & PropsLocale<'tentacle'>
  function AdminPanelPage(props: AdminPanelProps): ReactElement | null {
    return <AdminConsoleView t={props.t} />
  }

  type AdminPanelIconProps = PropsRuntime<'sidebar.panellist'> & PropsLocale<'tentacle'>
  function AdminPanelEntry(props: AdminPanelIconProps): ReactElement | null {
    return <AdminPanelIcon size={props.size} active={props.active} />
  }

  installShadows(ctx.slots, source, [
    {
      seat: 'sidebar.workspaces',
      register: () => ctx.slots.register(
        { name: 'sidebar.workspaces', priority: -10, locale: 'tentacle' },
        RestrictedWorkspacesEntry,
      ),
    },
    {
      seat: 'sidebar.settings',
      register: () => ctx.slots.register(
        { name: 'sidebar.settings', priority: -10, locale: 'tentacle' },
        RestrictedSettingsEntry,
      ),
    },
    {
      // The unified admin console as a GLOBAL panel: user/role/invite/policy
      // management is an operational surface, not a personal preference, so it
      // sits beside 频道/专家 instead of inside Settings (the reference implementation's /admin).
      seat: 'main',
      when: (state) => state.kind === 'admin',
      register: () => ctx.slots.register({ name: 'main', key: ADMIN_PANEL_ID, locale: 'tentacle' }, AdminPanelPage),
    },
    {
      seat: 'sidebar.panellist',
      when: (state) => state.kind === 'admin',
      register: () => ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: ADMIN_PANEL_ID,
          order: ADMIN_PANEL_ORDER,
          locale: 'tentacle',
          label: () => ctx.locale.bind('tentacle')('admin.console'),
        },
        AdminPanelEntry,
      ),
    },
  ])
}
