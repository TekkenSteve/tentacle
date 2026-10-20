/**
 * The sidebar icon that addresses the channels main panel
 * (`sidebar.panellist`, design 07 §5).
 *
 * The official paper-plane glyph: channels are where messages arrive, and both
 * weights come from the primitives package the shell already provides. The
 * glyph draws in `currentColor`, so the sidebar owns the tint; `active` only
 * picks the emphasized 1.3px weight, the same Regular/Medium pairing every
 * official entry uses.
 */
import type { ReactElement } from 'react'
import { IconPaperPlaneOutlineMedium, IconPaperPlaneOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Props the `sidebar.panellist` owner passes (ui-sidebar's slot contract). */
export type ChannelsPanelIconProps = SidebarPanelIconOwnerProps

export function ChannelsPanelIcon({ size, active }: ChannelsPanelIconProps): ReactElement {
  const Icon = active === true ? IconPaperPlaneOutlineMedium : IconPaperPlaneOutlineRegular
  return <Icon size={size} />
}
