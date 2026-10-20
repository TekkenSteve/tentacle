/**
 * The sidebar icon that addresses the teams main panel
 * (`sidebar.panellist`, the same shape as experts/channels).
 *
 * The users glyph expresses what a team is in Tentacle: a roster of member
 * experts plus a shared contract. Both weights come from the primitives
 * package the shell already provides; the glyph draws in `currentColor`, so
 * the sidebar owns the tint, and `active` only picks the emphasized weight.
 */
import type { ReactElement } from 'react'
import { IconUsersOutlineMedium, IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Props the `sidebar.panellist` owner passes (ui-sidebar's slot contract). */
export type TeamsPanelIconProps = SidebarPanelIconOwnerProps

export function TeamsPanelIcon({ size, active }: TeamsPanelIconProps): ReactElement {
  const Icon = active === true ? IconUsersOutlineMedium : IconUsersOutlineRegular
  return <Icon size={size} />
}
