/**
 * @tentacle/teams — expert team library for DSH
 * (design: docs/design/10-teams.md, docs/mapping.md §4).
 *
 * The domain core is cordis-free: the library, templates, prompt renderer,
 * workspace and preset registration are pure modules the service wires into
 * the host (design 04: teams → persona + gateway + agentPresets).
 */
import type { Context } from '@deepseek-ai/cordis'
import { TentacleTeams, type TentacleTeamsConfig } from './service.js'

export const name = 'tentacle-teams'

export {
  TentacleTeams,
  type TentacleTeamsConfig,
  type PersonaLibraryApi,
  type TeamRoute,
  type TeamRouteSummary,
  type TeamView,
  type TeamMemberOption,
  type TeamSkillFile,
} from './service.js'
export { TeamLibrary, TeamError, slugify, type TeamDeps, type TeamInput, type TeamPatch } from './library.js'
export { MemoryRepo, JsonFileRepo, type TeamRepo } from './repo.js'
export { loadTeamTemplates, plantTeamTemplates, teamSeedOf, type TeamTemplateLoadResult } from './templates.js'
export { createTeamRoutes, TEAMS_ADMIN_PREFIX, type TeamAdminApi } from './admin-api.js'
export { renderHostPrompt, hostPromptMembers, type HostPromptMember } from './prompt.js'
export { teamPresetId, teamPresetDefinition, TeamPresetSync, TEAM_PRESET_PREFIX, type TeamPresetInput } from './preset.js'
export {
  teamWorkspaceRoot,
  teamWorkspacePath,
  seedTeamWorkspace,
  materializeMemberSkills,
  listMaterializedSkills,
  teamManifestSnapshot,
  TEAM_WORKSPACE_MANIFEST_PATH,
  type MemberSkillSource,
} from './workspace.js'
export * from './types.js'

export function apply(ctx: Context, config?: TentacleTeamsConfig): void {
  ctx.plugin(TentacleTeams, config)
}
