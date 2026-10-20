/**
 * ExpertLibrary — the pure domain core of plugin-persona.
 *
 * Zero cordis imports: every dependency is injected (repo, clock), so the
 * whole lifecycle is unit-testable against MemoryRepo (same discipline as
 * @tentacle/tenancy's UserDirectory).
 *
 * Design notes (docs/mapping.md §3):
 * - An expert is the composition root: it **selects** one official Agent
 *   preset (`agentPreset`) for capabilities, and owns the remaining dimensions
 *   — workspace (skill files live there), model route, permission preset,
 *   channel bindings and template provenance. A preset is one component, not
 *   the expert identity.
 * - Borrowed from the reference implementation: manifest row + persona packaging, and the "detach
 *   from the template after creation" rule (seeds plant once; user edits are
 *   never overwritten by upgrades).
 * - Deliberately NOT borrowed: MBTI/zodiac-style persona labels. Persona text
 *   uses structured behavior dimensions (role / tone / output format /
 *   boundaries) which the model can actually follow.
 */
import type { ExpertRepo } from './repo.js'
import type { Expert, ExpertModelSelection, ExpertState, LocalizedInput, LocalizedText } from './types.js'

export class ExpertError extends Error {
  constructor(
    readonly code: 'duplicate-expert' | 'no-such-expert' | 'no-such-template' | 'no-such-preset' | 'builtin-protected' | 'invalid-expert' | 'expert-in-use' | 'invalid-skill',
    message: string,
  ) {
    super(message)
    this.name = 'ExpertError'
  }
}

export interface ExpertInput {
  /** Slug; defaults to a slugified English name. */
  id?: string
  name: LocalizedInput
  description: LocalizedInput
  icon?: string
  /** Card accent colour copied from the template manifest. */
  color?: string
  /** Selected official Agent preset (capability layer). Required. */
  agentPreset: string
  model?: ExpertModelSelection
  permissionPreset?: string
  /** Provenance when created from a template; copied files are already seeded. */
  templateId?: string
  /** Seeding-only flag: instances planted from a bundled template are protected. */
  builtin?: boolean
}

export interface ExpertPatch {
  name?: LocalizedInput
  description?: LocalizedInput
  icon?: string
  /** Switch the selected preset. */
  agentPreset?: string
  /** `null` clears the route so the deployment default applies again. */
  model?: ExpertModelSelection | null
  /** `null` clears the expert-level permission preset. */
  permissionPreset?: string | null
}

function normalizeModel(raw: ExpertModelSelection | null | undefined): ExpertModelSelection | undefined {
  if (raw === undefined || raw === null) return undefined
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') throw new ExpertError('invalid-expert', 'model requires provider and model')
  if (raw.maxTokens !== undefined && (!Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0)) {
    throw new ExpertError('invalid-expert', 'model.maxTokens must be a positive integer')
  }
  return { provider, model, ...(raw.maxTokens === undefined ? {} : { maxTokens: raw.maxTokens }) }
}

function normalizePermissionPreset(raw: string | null | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = raw.trim()
  return value === '' ? undefined : value
}

export interface ExpertDeps {
  repo: ExpertRepo
  now?: () => number
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

function normalizeText(value: LocalizedInput, field: string): LocalizedText {
  const pair = typeof value === 'string' ? { zh: value, en: value } : value
  const zh = pair.zh?.trim() ?? ''
  const en = pair.en?.trim() ?? ''
  if (!zh || !en) throw new ExpertError('invalid-expert', `${field} requires non-empty zh and en text`)
  return { zh, en }
}

/** Derive a slug from free text; empty result means "caller must supply id". */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
}

export class ExpertLibrary {
  private state: ExpertState | undefined
  private readonly now: () => number

  constructor(private readonly deps: ExpertDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Load instance state. Bundled templates are planted by the service
   * (design 09 §3): the library itself stays a pure record store, so file
   * seeding and preset registration live in one place.
   */
  async boot(): Promise<void> {
    const state = (this.state = await this.deps.repo.load())
    if (!state.seeded) {
      state.seeded = true
      await this.deps.repo.save(state)
    }
  }

  private loaded(): ExpertState {
    if (!this.state) throw new Error('tentacle persona: expert library not booted')
    return this.state
  }

  private async save(): Promise<void> {
    await this.deps.repo.save(this.loaded())
  }

  list(): readonly Expert[] {
    return this.loaded().experts
  }

  /** Operator-selected default expert, when it still exists. */
  get storedDefaultExpertId(): string | undefined {
    const id = this.loaded().defaultExpertId
    return id !== undefined && this.get(id) !== undefined ? id : undefined
  }

  /** Pin the expert new/migrated channels bind to by default. */
  async setDefaultExpertId(id: string): Promise<void> {
    this.mustFind(id)
    this.loaded().defaultExpertId = id
    await this.save()
  }

  get(id: string): Expert | undefined {
    return this.loaded().experts.find((e) => e.id === id)
  }

  private mustFind(id: string): Expert {
    const expert = this.get(id)
    if (!expert) throw new ExpertError('no-such-expert', `no such expert: ${id}`)
    return expert
  }

  async create(input: ExpertInput): Promise<Expert> {
    const state = this.loaded()
    const name = normalizeText(input.name, 'name')
    const description = normalizeText(input.description, 'description')
    const id = (input.id ?? slugify(name.en)).trim()
    if (!ID_PATTERN.test(id)) throw new ExpertError('invalid-expert', `invalid expert id: ${id}`)
    if (state.experts.some((e) => e.id === id)) {
      throw new ExpertError('duplicate-expert', `expert exists: ${id}`)
    }
    const agentPreset = (input.agentPreset ?? '').trim()
    if (agentPreset === '') throw new ExpertError('invalid-expert', 'agentPreset must be selected')
    const expert: Expert = {
      id,
      name,
      description,
      icon: input.icon?.trim() || undefined,
      ...(input.color?.trim() ? { color: input.color.trim() } : {}),
      agentPreset,
      ...(normalizeModel(input.model) === undefined ? {} : { model: normalizeModel(input.model) }),
      ...(normalizePermissionPreset(input.permissionPreset) === undefined
        ? {}
        : { permissionPreset: normalizePermissionPreset(input.permissionPreset) }),
      ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
      builtin: input.builtin === true,
      createdAt: this.now(),
      updatedAt: this.now(),
    }
    state.experts.push(expert)
    await this.save()
    return expert
  }

  /**
   * Patch an expert. Builtin rows accept only routing/preset changes: their
   * identity (id/name/description) is the shared vocabulary every install
   * agrees on, so it stays fixed.
   */
  async update(id: string, patch: ExpertPatch): Promise<Expert> {
    const expert = this.mustFind(id)
    if (expert.builtin && (patch.name !== undefined || patch.description !== undefined || patch.icon !== undefined)) {
      throw new ExpertError('builtin-protected', `builtin expert ${id}: identity is fixed`)
    }
    if (patch.name !== undefined) expert.name = normalizeText(patch.name, 'name')
    if (patch.description !== undefined) expert.description = normalizeText(patch.description, 'description')
    if (patch.icon !== undefined) expert.icon = patch.icon.trim() || undefined
    if (patch.agentPreset !== undefined) {
      const next = patch.agentPreset.trim()
      if (next === '') throw new ExpertError('invalid-expert', 'agentPreset must not be empty')
      expert.agentPreset = next
    }
    if (patch.model !== undefined) {
      const model = normalizeModel(patch.model)
      if (model === undefined) delete expert.model
      else expert.model = model
    }
    if (patch.permissionPreset !== undefined) {
      const permission = normalizePermissionPreset(patch.permissionPreset)
      if (permission === undefined) delete expert.permissionPreset
      else expert.permissionPreset = permission
    }
    expert.updatedAt = this.now()
    await this.save()
    return expert
  }

  /** Remove a user-created expert. Builtin rows are protected (409). */
  async remove(id: string): Promise<void> {
    const state = this.loaded()
    const expert = this.mustFind(id)
    if (expert.builtin) throw new ExpertError('builtin-protected', `builtin expert ${id} cannot be deleted`)
    state.experts.splice(state.experts.indexOf(expert), 1)
    await this.save()
  }
}
