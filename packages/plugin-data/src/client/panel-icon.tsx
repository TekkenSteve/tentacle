/**
 * The sidebar icon addressing the Data Studio main panel.
 */
import type { ReactElement } from 'react'
import { IconDataOutlineMedium, IconDataOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

export type DataPanelIconProps = SidebarPanelIconOwnerProps

export function DataPanelIcon({ size, active }: DataPanelIconProps): ReactElement {
  const Icon = active === true ? IconDataOutlineMedium : IconDataOutlineRegular
  return <Icon size={size} />
}
