/**
 * @tentacle/data — browser half.
 *
 * One admin-only global panel (design 11): the Data Studio page, addressed by
 * the `sidebar.panellist` icon of the same id — the same management-console
 * shape as channels/experts/teams.
 */
import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { browserDeps, createAdminSource } from './identity.ts'
import { mountWhenAdmin } from './shadows.ts'
import { DataStudioView } from './console/data-studio.tsx'
import { DataPanelIcon } from './panel-icon.tsx'
import { ensureConsoleStyles } from './console/ui.ts'
import { zh, en } from './locales.ts'

const PANEL_ID = 'tentacle-data'
const PANEL_ORDER = 28

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  ensureConsoleStyles()
  ctx.effect(() => ctx.locale.register('tentacle-data', { zh, en }), 'tentacle-data: dictionaries')

  const { source, stop } = createAdminSource(browserDeps)
  ctx.effect(() => stop, 'tentacle-data: admin probe')

  type PanelProps = PropsRuntime<'main'> & PropsLocale<'tentacle-data'>
  function DataPanelPage(props: PanelProps): ReactElement {
    return <DataStudioView t={props.t} />
  }

  type IconProps = PropsRuntime<'sidebar.panellist'> & PropsLocale<'tentacle-data'>
  function DataPanelEntry(props: IconProps): ReactElement {
    return <DataPanelIcon size={props.size} active={props.active} />
  }

  mountWhenAdmin(ctx.slots, 'main', source, () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: 'tentacle-data' },
    DataPanelPage,
  ))
  mountWhenAdmin(ctx.slots, 'sidebar.panellist', source, () => ctx.slots.register(
    {
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: PANEL_ORDER,
      locale: 'tentacle-data',
      label: () => ctx.locale.bind('tentacle-data')('data.panel'),
    },
    DataPanelEntry,
  ))
}
