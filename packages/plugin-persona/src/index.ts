/**
 * @tentacle/persona — expert library for DSH
 * (design: docs/mapping.md §3, docs/design/04-architecture.md §5).
 */
import type { Context } from '@deepseek-ai/cordis'
import { TentaclePersona, type TentaclePersonaConfig } from './service.js'

export const name = 'tentacle-persona'

export { TentaclePersona, type TentaclePersonaConfig, type ExpertRemovalGuard, type PresetRosterView, type SkillFile } from './service.js'
export { ExpertLibrary, ExpertError, slugify, type ExpertDeps, type ExpertInput, type ExpertPatch } from './experts.js'
export { MemoryRepo, JsonFileRepo, type ExpertRepo } from './repo.js'
export { loadTemplates, seedTemplate, WORKSPACE_MANIFEST_PATH, type TemplateLoadResult } from './templates.js'
export { createExpertRoutes, EXPERTS_ADMIN_PREFIX, type ExpertAdminApi } from './admin-api.js'
export * from './types.js'

export function apply(ctx: Context, config?: TentaclePersonaConfig): void {
  ctx.plugin(TentaclePersona, config)
}
