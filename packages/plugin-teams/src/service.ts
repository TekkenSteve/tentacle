/**
 * TentacleTeams — the team layer (design: docs/design/10-teams.md).
 *
 * A team is a first-class composition unit beside the expert: a roster of
 * member experts with per-member roles plus a shared collaboration
 * contract. This service owns the product/data layer — the library, the
 * bundled templates, the workspace, the managed preset per team and the
 * admin surface — and delegates the actual collaboration to the official
 * `dsh-experimental-agent-team` runtime mounted by those presets.
 *
 * Wiring (design 04): `teams → persona + gateway + agentPresets`.
 *  - persona supplies member validation, member facts (prompt rendering)
 *    and member skills (workspace materialization);
 *  - agentPresets registers one managed preset per team (`team-<id>`);
 *  - the gateway carries the admin routes (same seat as persona/tenancy).
 *
 * The channel layer consumes the same seam persona exposes:
 * {@link TentacleTeams.resolveForSession} and `listTeamRoutes()`.
 */
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ExpertModelSelection } from '@tentacle/persona'
import type { GatewayRoute } from '@tentacle/gateway'
import { TeamError, TeamLibrary, type TeamInput, type TeamPatch } from './library.js'
import { hostPromptMembers, renderHostPrompt } from './prompt.js'
import { TeamPresetSync, teamPresetId } from './preset.js'
import { JsonFileRepo, type TeamRepo } from './repo.js'
import { createTeamRoutes } from './admin-api.js'
import { loadTeamTemplates, plantTeamTemplates, teamSeedOf } from './templates.js'
import type { LocalizedText, QuickPrompt, Team, TeamCollaboration, TeamTemplate, TeamTemplateManifest } from './types.js'
import { joinLocalized } from './types.js'
import {
  listMaterializedSkills,
  materializeMemberSkills,
  seedTeamWorkspace,
  type MemberSkillSource,
} from './workspace.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tentacleTeams: TentacleTeams
  }
}

const DEFAULT_TEMPLATES_ROOT = fileURLToPath(new URL('../templates', import.meta.url))

/** Structural view of the gateway seam we plug into. */
interface GatewayLike {
  registerRoute(route: GatewayRoute): () => void
}

/**
 * What the service needs from the persona library (structural, exactly like
 * channels consumes persona — no package-level coupling beyond types).
 */
export interface PersonaLibraryApi {
  readonly ready: Promise<void>
  listExperts(): readonly { readonly id: string; readonly name: LocalizedText; readonly description: LocalizedText }[]
  /** Root of one expert's DSH skills (`<expert workspace>/.dsh/skills`). */
  skillsRootOf(expertId: string): string
  /** Register a veto over expert deletion — a member expert may not vanish
   * from under a team (design 10 §8). Returns the disposer. */
  registerExpertRemovalGuard(guard: (expertId: string) => string | undefined): () => void
}

/** What a channel session needs from one team instance (mirrors ExpertRoute). */
export interface TeamRoute {
  readonly agentPresetId: string
  readonly model?: ExpertModelSelection
  readonly permissionPreset?: string
  /** One workspace per team instance, shared by every channel bound to it. */
  readonly workspacePath: string
}

/** One team as the channel console sees it (routing target picker). */
export interface TeamRouteSummary {
  readonly id: string
  readonly name: string
  readonly agentPresetId: string
}

export interface TentacleTeamsConfig {
  readonly stateRoot?: string
  /** Instance workspaces root. Default `<stateRoot>/agents`. */
  readonly workspaceRoot?: string
  readonly templatesRoot?: string
  /** Test seam: mount a repo instead of the JsonFileRepo. */
  readonly repo?: TeamRepo
}

/** One team as the admin console sees it. */
export interface TeamView {
  readonly id: string
  readonly name: LocalizedText
  readonly description: LocalizedText
  readonly icon?: string
  readonly color?: string
  readonly members: readonly { readonly expertId: string; readonly role: LocalizedText; readonly expertName: string }[]
  readonly contract: Team['contract']
  readonly collaboration: TeamCollaboration
  readonly welcomeMessage?: LocalizedText
  readonly quickPrompts: readonly QuickPrompt[]
  readonly model?: ExpertModelSelection
  readonly permissionPreset?: string
  readonly templateId?: string
  readonly builtin: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly workspacePath: string
  readonly presetId: string
}

/** One expert the member picker may choose, with its team usage count. */
export interface TeamMemberOption {
  readonly id: string
  readonly name: LocalizedText
  readonly description: LocalizedText
  /** How many teams already include this expert (console hint). */
  readonly usedByTeams: number
}

/** One materialized skill under the team workspace (read-only, 10 §4). */
export interface TeamSkillFile {
  /** Workspace-relative path under `.dsh/skills` (`<memberId>/<skill>`). */
  readonly path: string
  readonly name: string
  readonly description: string
  readonly body: string
}

export class TentacleTeams extends Service {
  /** Persona is the member-existence authority; the official preset registry
   * is what makes a team runnable. Both are bundle residents (design 04). */
  static inject = ['tentaclePersona', 'agentPresets']

  readonly library: TeamLibrary
  /**
   * Resolves once Service.init has fully settled (library booted, templates
   * planted, workspaces seeded, presets registered when the registry is
   * mounted, gateway routes registered when present). Awaiting the plugin
   * fiber alone does NOT cover this — so embedders (channels) and tests wait
   * on `ready`.
   */
  readonly ready: Promise<void>
  private readonly workspaceRoot: string
  private readonly templatesRoot: string
  /** Discovered templates by id — the seed source for new instances. */
  private readonly templates = new Map<string, TeamTemplate>()
  /** Preset syncer over the official registry (static inject — always present). */
  private presetSync!: TeamPresetSync
  /** The persona library (static inject — always present). */
  private persona!: PersonaLibraryApi
  private markReady!: () => void

  constructor(
    ctx: Context,
    config: TentacleTeamsConfig = {},
    repo?: TeamRepo,
  ) {
    super(ctx, 'tentacleTeams')
    const stateRoot = config.stateRoot ?? dshHomePath('tentacle', 'teams')
    this.workspaceRoot = config.workspaceRoot ?? join(stateRoot, 'agents')
    this.templatesRoot = config.templatesRoot ?? DEFAULT_TEMPLATES_ROOT
    this.library = new TeamLibrary({ repo: repo ?? new JsonFileRepo(stateRoot) })
    this.ready = new Promise((resolve) => { this.markReady = resolve })
  }

  protected async [Service.init](): Promise<void> {
    const loaded = loadTeamTemplates(this.templatesRoot)
    for (const error of loaded.errors) this.ctx.logger?.warn?.(`tentacle teams: template rejected — ${error}`)
    for (const template of loaded.templates) this.templates.set(template.manifest.id, template)

    // Persona is the member-existence authority and the preset registry is
    // what makes a team runnable — both are declared as static injects (the
    // bundle mounts them before teams), so they are present HERE, not on a
    // later inject tick: the boot-time preset registration folds into `ready`
    // and a channel session created right after boot always finds its preset.
    const persona = (this.ctx as unknown as { tentaclePersona: PersonaLibraryApi }).tentaclePersona
    const registry = (this.ctx as unknown as { agentPresets: AgentPresetRegistry }).agentPresets
    this.persona = persona
    this.presetSync = new TeamPresetSync(registry)

    // Wait for the expert library to be fully planted before validating
    // rosters (same discipline as channels — design 09 §3.3).
    await persona.ready
    this.library.setExpertValidator((expertId) => this.expertExists(expertId))

    // A member expert may not be deleted from under a team (10 §8); the
    // effect owns the guard's lifetime alongside this service.
    this.ctx.effect(() => persona.registerExpertRemovalGuard((expertId) => this.expertReferenceReason(expertId)))

    await this.library.boot()
    if (!this.library.seeded) {
      const planted = await plantTeamTemplates(this.library, [...this.templates.values()], (id) => this.expertExists(id))
      if (planted.length === 0 && this.templates.size > 0) {
        this.ctx.logger?.warn?.('tentacle teams: no bundled template could be planted (missing member experts?)')
      }
      await this.library.markSeeded()
    }
    for (const team of this.library.list()) this.refreshWorkspace(team)

    // One managed preset per team, kept in sync with the library from here on.
    await this.syncPresets()

    // Admin routes ride the gateway when it is mounted (optional seam — a
    // stock deployment without the Tentacle gateway keeps the library working).
    this.ctx.inject(['tentacleGateway'], (gwCtx) => {
      const gateway = (gwCtx as unknown as { tentacleGateway?: GatewayLike }).tentacleGateway
      if (gateway === undefined) return
      const disposeRoutes = createTeamRoutes(this).map((route) => gateway.registerRoute(route))
      this.ctx.logger?.info?.('tentacle teams: team admin routes registered on the gateway')
      return () => {
        for (const d of disposeRoutes) d()
      }
    })
    this.markReady()
  }

  private expertExists(expertId: string): boolean {
    return this.persona.listExperts().some((e) => e.id === expertId)
  }

  // ---------------------------------------------------------------- workspace

  private workspacePathOf(teamId: string): string {
    return join(this.workspaceRoot, teamId, 'workspace')
  }

  /** Workspace path of one team (console detail + channel sessions). */
  workspaceOf(teamId: string): string {
    return this.workspacePathOf(teamId)
  }

  /** Where each member's skills come from (its expert workspace skills root). */
  private memberSkillSources(team: Team): readonly MemberSkillSource[] {
    return team.members
      .map((member) => ({
        expertId: member.expertId,
        skillsRoot: this.persona.skillsRootOf(member.expertId),
      }))
      .filter((source) => source.skillsRoot !== '')
  }

  /** Re-seed the generated artifacts and rebuild materialized member skills. */
  private refreshWorkspace(team: Team): void {
    const workspace = this.workspacePathOf(team.id)
    seedTeamWorkspace(workspace, team, this.hostPromptOf(team))
    materializeMemberSkills(workspace, this.memberSkillSources(team))
  }

  private hostPromptOf(team: Team): string {
    return renderHostPrompt(team, hostPromptMembers(team, this.expertFacts()))
  }

  /** Member facts for the prompt renderer (name/description joined). */
  private expertFacts(): readonly { readonly id: string; readonly name: string; readonly description: string }[] {
    return (this.persona.listExperts()).map((expert) => ({
      id: expert.id,
      name: joinLocalized(expert.name),
      description: joinLocalized(expert.description),
    }))
  }

  /** Re-materialize one team's member skills (console refresh action, 10 §4). */
  refreshTeamSkills(teamId: string): readonly string[] {
    const team = this.library.get(teamId)
    if (team === undefined) throw new TeamError('no-such-team', `no such team: ${teamId}`)
    return materializeMemberSkills(this.workspacePathOf(teamId), this.memberSkillSources(team))
  }

  /** Materialized skill files of one team (generated data — read-only). */
  listSkills(teamId: string): readonly TeamSkillFile[] {
    const team = this.library.get(teamId)
    if (team === undefined) throw new TeamError('no-such-team', `no such team: ${teamId}`)
    return listMaterializedSkills(this.workspacePathOf(teamId))
      .map((path) => this.getSkill(teamId, path))
  }

  /** Read one materialized skill (read-only: edit the source expert skill).
   * A skill entry is a directory holding SKILL.md, or a single .md file. */
  getSkill(teamId: string, path: string): TeamSkillFile {
    const team = this.library.get(teamId)
    if (team === undefined) throw new TeamError('no-such-team', `no such team: ${teamId}`)
    const root = join(this.workspacePathOf(teamId), '.dsh', 'skills')
    const entry = join(root, path)
    if (!entry.startsWith(root + '/')) throw new TeamError('invalid-team', 'skill path escapes the skills root')
    const file = statSync(entry).isDirectory() ? join(entry, 'SKILL.md') : entry
    const body = readFileSync(file, 'utf8')
    const name = path.split('/').pop() ?? path
    const description = /^description:\s*(.*)$/m.exec(body)?.[1]?.trim() ?? ''
    return { path, name, description, body }
  }

  // ------------------------------------------------------------------ presets

  /** Re-register every team's managed preset (after writes and at boot). */
  private async syncPresets(): Promise<void> {
    await this.presetSync.syncAll(this.library.list().map((team) => ({
      teamId: team.id,
      displayName: joinLocalized(team.name),
      hostPrompt: this.hostPromptOf(team),
      memberCount: team.members.length,
    })))
  }

  // -------------------------------------------------------------- CRUD (team)

  async createTeam(input: TeamInput): Promise<Team> {
    const team = await this.library.create(input)
    this.refreshWorkspace(team)
    await this.syncPresets()
    return team
  }

  async updateTeam(id: string, patch: TeamPatch): Promise<Team> {
    const team = await this.library.update(id, patch)
    this.refreshWorkspace(team)
    await this.syncPresets()
    return team
  }

  async removeTeam(id: string): Promise<void> {
    await this.presetSync.drop(id)
    await this.library.remove(id)
    rmSync(join(this.workspaceRoot, id), { recursive: true, force: true })
    await this.syncPresets()
  }

  /** Clone a bundled template into a new (editable, deletable) instance. */
  async createTeamFromTemplate(templateId: string, overrides?: Partial<TeamInput>): Promise<Team> {
    const template = this.templates.get(templateId)
    if (template === undefined) throw new TeamError('no-such-template', `no such template: ${templateId}`)
    const seed = teamSeedOf(template.manifest)
    return await this.createTeam({ ...seed, ...overrides, templateId })
  }

  /** Reset a builtin team's editable fields back to its template seed. */
  async restoreTeamFromTemplate(id: string): Promise<Team> {
    const team = this.library.get(id)
    if (team === undefined) throw new TeamError('no-such-team', `no such team: ${id}`)
    if (!team.builtin || team.templateId === undefined) {
      throw new TeamError('builtin-protected', `team ${id} was not seeded from a bundled template`)
    }
    const template = this.templates.get(team.templateId)
    if (template === undefined) throw new TeamError('no-such-template', `no such template: ${team.templateId}`)
    const seed = teamSeedOf(template.manifest)
    return await this.updateTeam(id, {
      members: seed.members,
      ...(seed.contract === undefined ? { contract: { constraints: [], examples: [] } } : { contract: seed.contract }),
      collaboration: seed.collaboration,
      ...(seed.welcomeMessage === undefined ? { welcomeMessage: null } : { welcomeMessage: seed.welcomeMessage }),
      quickPrompts: seed.quickPrompts,
    })
  }

  // ------------------------------------------------------------------- views

  viewOf(team: Team): TeamView {
    const names = new Map((this.persona.listExperts()).map((e) => [e.id, joinLocalized(e.name)]))
    return {
      id: team.id,
      name: team.name,
      description: team.description,
      ...(team.icon === undefined ? {} : { icon: team.icon }),
      ...(team.color === undefined ? {} : { color: team.color }),
      members: team.members.map((m) => ({
        expertId: m.expertId,
        role: m.role,
        expertName: names.get(m.expertId) ?? m.expertId,
      })),
      contract: team.contract,
      collaboration: team.collaboration,
      ...(team.welcomeMessage === undefined ? {} : { welcomeMessage: team.welcomeMessage }),
      quickPrompts: team.quickPrompts,
      ...(team.model === undefined ? {} : { model: team.model }),
      ...(team.permissionPreset === undefined ? {} : { permissionPreset: team.permissionPreset }),
      ...(team.templateId === undefined ? {} : { templateId: team.templateId }),
      builtin: team.builtin,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      workspacePath: this.workspacePathOf(team.id),
      presetId: teamPresetId(team.id),
    }
  }

  listTeams(): readonly TeamView[] {
    return this.library.list().map((team) => this.viewOf(team))
  }

  /** Experts the member picker may choose, with team usage counts. */
  listMemberOptions(): readonly TeamMemberOption[] {
    const usage = new Map<string, number>()
    for (const team of this.library.list()) {
      for (const member of team.members) usage.set(member.expertId, (usage.get(member.expertId) ?? 0) + 1)
    }
    return (this.persona.listExperts()).map((expert) => ({
      id: expert.id,
      name: expert.name,
      description: expert.description,
      usedByTeams: usage.get(expert.id) ?? 0,
    }))
  }

  /** Bundled templates as the console's library tab sees them. */
  listTemplates(): readonly TeamTemplateManifest[] {
    return [...this.templates.values()].map((t) => t.manifest)
  }

  // --------------------------------------------------------- channels' seam

  /**
   * Resolve a team for a channel session (design 10 §6/§7): the managed
   * preset, the team's model route, permission preset and shared workspace.
   * Undefined = the channel routes to a team that no longer resolves — the
   * router treats it as a dispatch failure, never a silent fallback.
   */
  resolveForSession(teamId: string): TeamRoute | undefined {
    const team = this.library.get(teamId)
    if (team === undefined) return undefined
    return {
      agentPresetId: teamPresetId(team.id),
      ...(team.model === undefined ? {} : { model: team.model }),
      ...(team.permissionPreset === undefined ? {} : { permissionPreset: team.permissionPreset }),
      workspacePath: this.workspacePathOf(team.id),
    }
  }

  listTeamRoutes(): readonly TeamRouteSummary[] {
    return this.library.list().map((team) => ({
      id: team.id,
      name: joinLocalized(team.name),
      agentPresetId: teamPresetId(team.id),
    }))
  }

  /**
   * Register a deletion veto from the plugin that owns the references
   * (channels point at teams, 10 §8). Returns the disposer.
   */
  registerRemovalGuard(guard: (teamId: string) => string | undefined): () => void {
    return this.library.registerRemovalGuard(guard)
  }

  /** Why an expert cannot be deleted: it is a member of some team. */
  private expertReferenceReason(expertId: string): string | undefined {
    const bound = this.library.list()
      .filter((team) => team.members.some((m) => m.expertId === expertId))
      .map((team) => team.id)
    if (bound.length === 0) return undefined
    return `expert ${expertId} is still a member of team(s): ${bound.slice(0, 5).join(', ')}${bound.length > 5 ? ', …' : ''}`
  }
}
