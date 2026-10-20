/**
 * The sidebar icon that addresses the experts main panel
 * (`sidebar.panellist`, the same shape as channels).
 *
 * The official agent-preset glyph expresses exactly what an expert is in DSH:
 * a mounted preset. Both weights come from the primitives package the shell
 * already provides; the glyph draws in `currentColor`, so the sidebar owns the
 * tint, and `active` only picks the emphasized 1.3px weight.
 */
import type { ReactElement } from 'react'
import { IconAgentPresetOutlineMedium, IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Props the `sidebar.panellist` owner passes (ui-sidebar's slot contract). */
export type ExpertsPanelIconProps = SidebarPanelIconOwnerProps

export function ExpertsPanelIcon({ size, active }: ExpertsPanelIconProps): ReactElement {
  const Icon = active === true ? IconAgentPresetOutlineMedium : IconAgentPresetOutlineRegular
  return <Icon size={size} />
}
