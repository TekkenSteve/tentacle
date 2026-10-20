/**
 * TeamLibrary — the pure domain core of plugin-teams (design 10 §2).
 *
 * Zero cordis imports: every dependency is injected (repo, clock, expert
 * existence check), so the whole lifecycle is unit-testable against
 * MemoryRepo — the same discipline as ExpertLibrary and UserDirectory.
 *
 * Design notes:
 * - A team is a roster of EXPERTS (never teams): `knownExpert` is the seam the
 *   service wires to the persona library, so a member id can never name a
 *   team or a deleted expert.
 * - Builtin instances (planted from bundled templates) keep identity fixed;
 *   roster, contract and routing stay editable, and restore-from-template is
 *   a service-level action (10 §2).
 * - Referential integrity is veto-based (10 §8): the plugin that owns a
 *   reference (channels) registers a guard; deletion asks every guard first.
 *   In-flight member work has NO veto (the official runtime exposes no
 *   "member busy" fact) — documented limitation, 10 §13.
 */
import type { TeamRepo } from './repo.js'
import type {
  LocalizedInput,
  LocalizedText,
  QuickPrompt,
  QuickPromptInput,
  Team,
  TeamCollaboration,
  TeamContract,
  TeamContractInput,
  TeamMember,
  TeamMemberInput,
  TeamState,
} from './types.js'
import { MAX_CONSTRAINTS, MAX_EXAMPLES, TEAM_MAX_MEMBERS, TEAM_MIN_MEMBERS } from './types.js'
import type { ExpertModelSelection } from '@tentacle/persona'

export type TeamErrorCode =
  | 'duplicate-team'
  | 'no-such-team'
  | 'no-such-template'
  | 'builtin-protected'
  | 'invalid-team'
  | 'team-in-use'
  | 'member-invalid'
  | 'members-too-few'
  | 'members-too-many'
  | 'invalid-collaboration'
  | 'invalid-contract'

export class TeamError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TeamError'
  }
}

export interface TeamInput {
  /** Slug; defaults to a slugified English name. */
  id?: string
  name: LocalizedInput
  description: LocalizedInput
  icon?: string
  color?: string
  members: readonly TeamMemberInput[]
  contract?: TeamContractInput
  welcomeMessage?: LocalizedInput
  quickPrompts?: readonly QuickPromptInput[]
  model?: ExpertModelSelection | null
  permissionPreset?: string | null
  collaboration?: TeamCollaboration
  /** Provenance when created from a template. */
  templateId?: string
  /** Seeding-only flag: instances planted from a bundled template are protected. */
  builtin?: boolean
}

export interface TeamPatch {
  name?: LocalizedInput
  description?: LocalizedInput
  icon?: string
  color?: string
  /** Complete next roster (not incremental adds), same as the reference implementation's PATCH semantics. */
  members?: readonly TeamMemberInput[]
  contract?: TeamContractInput
  welcomeMessage?: LocalizedInput | null
  quickPrompts?: readonly QuickPromptInput[]
  /** `null` clears the route so the deployment default applies again. */
  model?: ExpertModelSelection | null
  /** `null` clears the team-level permission preset. */
  permissionPreset?: string | null
  collaboration?: TeamCollaboration
}

export interface TeamDeps {
  repo: TeamRepo
  now?: () => number
  /**
   * Whether an expert id names a usable expert (wired to the persona library
   * by the service). Undefined accepts any id — for pure-domain tests that
   * do not model the expert library.
   */
  knownExpert?: (expertId: string) => boolean
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

function normalizeText(value: LocalizedInput, field: string): LocalizedText {
  const pair = typeof value === 'string' ? { zh: value, en: value } : value
  const zh = pair.zh?.trim() ?? ''
  const en = pair.en?.trim() ?? ''
  if (zh === '' || en === '') {
    throw new TeamError('invalid-team', `${field} requires non-empty zh and en text`)
  }
  return { zh, en }
}

function normalizeOptionalText(value: LocalizedInput | null | undefined, field: string): LocalizedText | undefined {
  if (value === undefined || value === null) return undefined
  const text = normalizeText(value, field)
  return text.zh === '' && text.en === '' ? undefined : text
}

function normalizeModel(raw: ExpertModelSelection | null | undefined): ExpertModelSelection | undefined {
  if (raw === undefined || raw === null) return undefined
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') throw new TeamError('invalid-team', 'model requires provider and model')
  if (raw.maxTokens !== undefined && (!Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0)) {
    throw new TeamError('invalid-team', 'model.maxTokens must be a positive integer')
  }
  return { provider, model, ...(raw.maxTokens === undefined ? {} : { maxTokens: raw.maxTokens }) }
}

function normalizePermissionPreset(raw: string | null | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = raw.trim()
  return value === '' ? undefined : value
}

function normalizeCollaboration(raw: string | null | undefined): TeamCollaboration {
  if (raw === undefined || raw === null) return 'dispatch'
  if (raw !== 'dispatch' && raw !== 'auto') {
    throw new TeamError('invalid-collaboration', `unknown collaboration mode: ${raw}`)
  }
  return raw
}

/** Derive a slug from free text; empty result means "caller must supply id". */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
}

export class TeamLibrary {
  private state: TeamState | undefined
  private readonly now: () => number
  /** Expert-existence validator; installed by the service once the persona
   * library is mounted (the library itself is constructed earlier). */
  private expertValidator: ((expertId: string) => boolean) | undefined

  constructor(private readonly deps: TeamDeps) {
    this.now = deps.now ?? Date.now
    this.expertValidator = deps.knownExpert
  }

  /** Install (or replace) the expert-existence validator after construction. */
  setExpertValidator(validator: ((expertId: string) => boolean) | undefined): void {
    this.expertValidator = validator
  }

  /** Load team state. Bundled templates are planted by the service (10 §10):
   * the library stays a pure record store. */
  async boot(): Promise<void> {
    this.state = await this.deps.repo.load()
  }

  /** True until the service has planted the bundled templates once. */
  get seeded(): boolean {
    return this.loaded().seeded
  }

  /** Mark the library as seeded (the service calls this after planting). */
  async markSeeded(): Promise<void> {
    const state = this.loaded()
    if (state.seeded) return
    state.seeded = true
    await this.save()
  }

  private loaded(): TeamState {
    if (!this.state) throw new Error('tentacle teams: team library not booted')
    return this.state
  }

  private async save(): Promise<void> {
    await this.deps.repo.save(this.loaded())
  }

  list(): readonly Team[] {
    return this.loaded().teams
  }

  get(id: string): Team | undefined {
    return this.loaded().teams.find((t) => t.id === id)
  }

  private mustFind(id: string): Team {
    const team = this.get(id)
    if (team === undefined) throw new TeamError('no-such-team', `no such team: ${id}`)
    return team
  }

  /**
   * Validate a complete roster: every id must name a usable expert (never a
   * team, never a deleted expert), roles are bilingual, and the size stays
   * within {@link TEAM_MIN_MEMBERS}–{@link TEAM_MAX_MEMBERS}.
   */
  private normalizeMembers(raw: readonly TeamMemberInput[]): TeamMember[] {
    if (!Array.isArray(raw)) throw new TeamError('invalid-team', 'members must be an array')
    const seen = new Set<string>()
    const members: TeamMember[] = []
    for (const entry of raw) {
      const expertId = typeof entry?.expertId === 'string' ? entry.expertId.trim() : ''
      if (expertId === '') throw new TeamError('member-invalid', 'member expertId is required')
      if (seen.has(expertId)) throw new TeamError('member-invalid', `duplicate member: ${expertId}`)
      seen.add(expertId)
      if (this.expertValidator !== undefined && !this.expertValidator(expertId)) {
        throw new TeamError('member-invalid', `no such expert: ${expertId}`)
      }
      members.push({ expertId, role: normalizeText(entry.role, `members.${expertId}.role`) })
    }
    if (members.length < TEAM_MIN_MEMBERS) {
      throw new TeamError('members-too-few', `a team needs at least ${TEAM_MIN_MEMBERS} members`)
    }
    if (members.length > TEAM_MAX_MEMBERS) {
      throw new TeamError('members-too-many', `a team may have at most ${TEAM_MAX_MEMBERS} members`)
    }
    return members
  }

  private normalizeContract(raw: TeamContractInput | undefined): TeamContract {
    if (raw === undefined) return { constraints: [], examples: [] }
    const constraints = (raw.constraints ?? []).map((c, i) => normalizeText(c, `contract.constraints[${i}]`))
    if (constraints.length > MAX_CONSTRAINTS) {
      throw new TeamError('invalid-contract', `at most ${MAX_CONSTRAINTS} constraints`)
    }
    const examples = (raw.examples ?? []).map((e, i) => normalizeText(e, `contract.examples[${i}]`))
    if (examples.length > MAX_EXAMPLES) {
      throw new TeamError('invalid-contract', `at most ${MAX_EXAMPLES} examples`)
    }
    return {
      ...(normalizeOptionalText(raw.goal, 'contract.goal') === undefined
        ? {}
        : { goal: normalizeOptionalText(raw.goal, 'contract.goal') }),
      constraints,
      ...(normalizeOptionalText(raw.delivery, 'contract.delivery') === undefined
        ? {}
        : { delivery: normalizeOptionalText(raw.delivery, 'contract.delivery') }),
      examples,
    }
  }

  private normalizeQuickPrompts(raw: readonly QuickPromptInput[] | undefined): QuickPrompt[] {
    if (raw === undefined) return []
    return raw.map((p) => ({
      title: normalizeText(p.title, 'quickPrompts.title'),
      prompt: normalizeText(p.prompt, 'quickPrompts.prompt'),
    }))
  }

  async create(input: TeamInput): Promise<Team> {
    const state = this.loaded()
    const name = normalizeText(input.name, 'name')
    const description = normalizeText(input.description, 'description')
    const id = (input.id ?? slugify(name.en)).trim()
    if (!ID_PATTERN.test(id)) throw new TeamError('invalid-team', `invalid team id: ${id}`)
    if (state.teams.some((t) => t.id === id)) {
      throw new TeamError('duplicate-team', `team exists: ${id}`)
    }
    const team: Team = {
      id,
      name,
      description,
      icon: input.icon?.trim() || undefined,
      ...(input.color?.trim() ? { color: input.color.trim() } : {}),
      members: this.normalizeMembers(input.members),
      contract: this.normalizeContract(input.contract),
      ...(normalizeOptionalText(input.welcomeMessage, 'welcomeMessage') === undefined
        ? {}
        : { welcomeMessage: normalizeOptionalText(input.welcomeMessage, 'welcomeMessage') }),
      quickPrompts: this.normalizeQuickPrompts(input.quickPrompts),
      ...(normalizeModel(input.model) === undefined ? {} : { model: normalizeModel(input.model) }),
      ...(normalizePermissionPreset(input.permissionPreset) === undefined
        ? {}
        : { permissionPreset: normalizePermissionPreset(input.permissionPreset) }),
      collaboration: normalizeCollaboration(input.collaboration),
      ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
      builtin: input.builtin === true,
      createdAt: this.now(),
      updatedAt: this.now(),
    }
    state.teams.push(team)
    await this.save()
    return team
  }

  /**
   * Patch a team. Builtin rows accept everything EXCEPT identity
   * (id/name/description/icon/color): the seeded identity is the shared
   * vocabulary every install agrees on. `members` is the complete next
   * roster — the same whole-value PATCH semantics the reference implementation uses.
   */
  async update(id: string, patch: TeamPatch): Promise<Team> {
    const team = this.mustFind(id)
    if (team.builtin && (
      patch.name !== undefined
      || patch.description !== undefined
      || patch.icon !== undefined
      || patch.color !== undefined
    )) {
      throw new TeamError('builtin-protected', `builtin team ${id}: identity is fixed`)
    }
    if (patch.name !== undefined) team.name = normalizeText(patch.name, 'name')
    if (patch.description !== undefined) team.description = normalizeText(patch.description, 'description')
    if (patch.icon !== undefined) team.icon = patch.icon.trim() || undefined
    if (patch.color !== undefined) team.color = patch.color.trim() || undefined
    if (patch.members !== undefined) {
      team.members = this.normalizeMembers(patch.members)
    }
    if (patch.contract !== undefined) team.contract = this.normalizeContract(patch.contract)
    if (patch.welcomeMessage !== undefined) {
      const welcome = normalizeOptionalText(patch.welcomeMessage, 'welcomeMessage')
      if (welcome === undefined) delete team.welcomeMessage
      else team.welcomeMessage = welcome
    }
    if (patch.quickPrompts !== undefined) team.quickPrompts = this.normalizeQuickPrompts(patch.quickPrompts)
    if (patch.model !== undefined) {
      const model = normalizeModel(patch.model)
      if (model === undefined) delete team.model
      else team.model = model
    }
    if (patch.permissionPreset !== undefined) {
      const permission = normalizePermissionPreset(patch.permissionPreset)
      if (permission === undefined) delete team.permissionPreset
      else team.permissionPreset = permission
    }
    if (patch.collaboration !== undefined) team.collaboration = normalizeCollaboration(patch.collaboration)
    team.updatedAt = this.now()
    await this.save()
    return team
  }

  /**
   * Remove a user-created team. Builtin rows are protected (409). Guards
   * registered by reference owners (channels) veto first (10 §8).
   */
  async remove(id: string): Promise<void> {
    const state = this.loaded()
    const team = this.mustFind(id)
    if (team.builtin) throw new TeamError('builtin-protected', `builtin team ${id} cannot be deleted`)
    for (const guard of this.removalGuards) {
      const reason = guard(id)
      if (reason !== undefined) {
        throw new TeamError('team-in-use', reason)
      }
    }
    state.teams.splice(state.teams.indexOf(team), 1)
    await this.save()
  }

  /**
   * Register a deletion veto from the plugin that owns the references
   * (channels point at teams, 10 §8). Returns the disposer; registration is
   * idempotent per callback.
   */
  private readonly removalGuards = new Set<(teamId: string) => string | undefined>()
  registerRemovalGuard(guard: (teamId: string) => string | undefined): () => void {
    this.removalGuards.add(guard)
    return () => { this.removalGuards.delete(guard) }
  }
}
