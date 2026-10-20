/**
 * The sidebar icon that addresses the admin main panel
 * (`sidebar.panellist`, same shape as channels/experts).
 */
import type { ReactElement } from 'react'
import { IconUsersOutlineMedium, IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

export type AdminPanelIconProps = SidebarPanelIconOwnerProps

export function AdminPanelIcon({ size, active }: AdminPanelIconProps): ReactElement {
  const Icon = active === true ? IconUsersOutlineMedium : IconUsersOutlineRegular
  return <Icon size={size} />
}
