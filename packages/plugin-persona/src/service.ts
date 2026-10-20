/**
 * TentaclePersona — the expert layer (design: docs/design/09-experts.md).
 *
 * Two levels, mirroring the reference implementation:
 *  - **templates** are bundled directories (`templates/<id>/manifest.json` +
 *    seed files + optional preset rows) discovered at boot;
 *  - **instances** are user-owned records created from a template (or blank).
 *
 * An expert is the composition root. It **selects** one official Agent preset
 * (`agentPreset`) for its capability layer, and owns the remaining dimensions:
 * a workspace (where skill files live), a model route, a permission preset,
 * channel bindings and template provenance. A preset is one selectable
 * component — shared by any number of experts — not the expert identity.
 *
 * The service registers two kinds of presets:
 *  - one template preset per bundled template (`expert-template-<id>`), shared
 *    by every expert created from that template;
 *  - an owned preset (`expert-<id>`) only when an expert carries a presetSpec
 *    (legacy import or an explicit fork).
 * Channels resolve an instance through {@link TentaclePersona.resolveForSession},
 * which yields the selected preset id, model route, permission preset and
 * workspace path.
 *
 * Seeding follows the reference implementation's detach rule: files are copied once at creation and
 * template upgrades never touch existing instance workspaces.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { GatewayRoute } from '@tentacle/gateway'
import { ExpertError, ExpertLibrary, type ExpertDeps, type ExpertInput, type ExpertPatch } from './experts.js'
import { createExpertRoutes } from './admin-api.js'
import { JsonFileRepo, type ExpertRepo } from './repo.js'
import { WORKSPACE_MANIFEST_PATH, loadTemplates, seedTemplate } from './templates.js'
import type {
  Expert,
  ExpertModelSelection,
  ExpertSkillSummary,
  ExpertTemplate,
  LocalizedInput,
  LocalizedText,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tentaclePersona: TentaclePersona
  }
}

/** Structural view of the gateway seam we plug into. */
interface GatewayLike {
  registerRoute(route: GatewayRoute): () => void
}

/** One row of the preset roster the expert editor can select from. */
export interface PresetRosterView {
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** The deployment default preset (what a session naming none composes). */
  readonly default: boolean
  /** Registered by this plugin (template preset or owned preset). */
  readonly managed: boolean
  /** Why the preset cannot compose a session; absent when usable. */
  readonly broken?: string
}

/** What a channel session needs from one expert instance. */
export interface ExpertRoute {
  readonly agentPresetId: string
  readonly model?: ExpertModelSelection
  readonly permissionPreset?: string
  /** One workspace per instance, shared by every channel bound to it. */
  readonly workspacePath: string
}

/** One expert as the channel console sees it (routing dropdown). */
export interface ExpertRouteSummary {
  readonly id: string
  readonly name: string
  readonly agentPresetId: string
}

/** One bundled template as the admin console sees it (design 09 §3). */
export interface ExpertTemplateView {
  readonly id: string
  readonly label: LocalizedText
  readonly description: LocalizedText
  readonly icon?: string
  readonly color?: string
  readonly welcomeMessage?: LocalizedText
  readonly quickPrompts: NonNullable<ExpertTemplate['manifest']['quickPrompts']>
  /** The preset this template supplies to its experts. */
  readonly agentPresetId: string
  /** The instance planted from this template, when one exists. */
  readonly installedExpertId?: string
}

/** Overrides accepted when an operator clones a template into a new expert. */
export interface CreateFromTemplateInput {
  readonly id?: string
  readonly name?: LocalizedInput
  readonly description?: LocalizedInput
}

/** A skill bundle under the expert workspace `.dsh/skills` root. */
export interface SkillFile extends ExpertSkillSummary {
  /** Markdown body after the frontmatter. */
  readonly body: string
}

/**
 * Referential-integrity veto over expert deletion (design 09 §3.4).
 *
 * A plugin that stores `expertId` references (channels) registers a guard at
 * init; `removeExpert` refuses the deletion while any guard reports the expert
 * is still in use. Returning the reason (channel names) keeps the host log
 * actionable while the API only exposes the stable `expert-in-use` code.
 */
export type ExpertRemovalGuard = (expertId: string) => string | undefined

export interface TentaclePersonaConfig {
  /** State root for `experts.json`. Default `$DSH_HOME/tentacle/persona`. */
  stateRoot?: string
  /** Instance workspaces root. Default `<stateRoot>/agents`. */
  workspaceRoot?: string
  /** Bundled template library. Default the package's own `templates/` dir. */
  templatesRoot?: string
}

/** The preset roster is locale-unaware: show both locales side by side. */
function joinText(text: LocalizedText, separator: string): string {
  return text.zh === text.en ? text.zh : `${text.zh}${separator}${text.en}`
}

const DEFAULT_TEMPLATES_ROOT = fileURLToPath(new URL('../templates', import.meta.url))

/**
 * Guaranteed default expert (design 09 §3): the most general, minimal persona.
 * Ship it in code, not only on disk — an install whose `templates/` directory
 * is missing (packaging mistake, stripped package) must still leave the console
 * with something to select and configure.
 */
const FALLBACK_EXPERT = {
  id: 'general-assistant',
  name: { zh: '通用助手', en: 'General Assistant' },
  description: {
    zh: '日常问答与知识工作的通用专家，结论先行、承认未知。',
    en: 'A versatile expert for everyday questions and knowledge work — conclusion first, honest about the unknown.',
  },
  icon: '🐙',
  color: '#4c7dff',
  agentPreset: 'standard',
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/** Parse the minimal SKILL.md frontmatter fields the console renders. */
function parseSkillFrontmatter(source: string): { name?: string; description?: string; body: string } {
  if (!source.startsWith('---')) return { body: source }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return { body: source }
  const header = source.slice(3, end)
  const body = source.slice(end + 4).replace(/^\r?\n/, '')
  const fields: Record<string, string> = {}
  for (const line of header.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match !== null) fields[match[1]!] = match[2]!.trim().replace(/^['"]|['"]$/g, '')
  }
  return {
    ...(fields['name'] === undefined ? {} : { name: fields['name'] }),
    ...(fields['description'] === undefined ? {} : { description: fields['description'] }),
    body,
  }
}

export class TentaclePersona extends Service {
  readonly library: ExpertLibrary
  /**
   * Resolves once Service.init has fully settled (templates planted, preset
   * mounts registered, gateway routes registered when present). Awaiting the
   * plugin fiber alone does NOT cover this — the fiber activates its parent
   * chain first — so embedders and tests should wait on `ready`.
   */
  readonly ready: Promise<void>
  private readonly workspaceRoot: string
  private readonly templatesRoot: string
  /** Discovered templates by id — the seed source for new instances. */
  private readonly templates = new Map<string, ExpertTemplate>()
  /** Registry-backed roster reader, installed once the registry service appears. */
  private presetRoster: (() => Promise<readonly { id: string; name?: string; description?: string; broken?: string; isDefault: boolean }[]>) | undefined
  /**
   * Referential-integrity guards registered by owners of OTHER plugins (e.g.
   * channels) that point at experts. Deletion asks every guard first: an
   * expert referenced by a tenant resource may not vanish under it.
   */
  private readonly removalGuards = new Set<ExpertRemovalGuard>()
  private markReady!: () => void

  constructor(
    ctx: Context,
    config: TentaclePersonaConfig = {},
    repo?: ExpertRepo,
  ) {
    super(ctx, 'tentaclePersona')
    const stateRoot = config.stateRoot ?? dshHomePath('tentacle', 'persona')
    const deps: ExpertDeps = {
      repo: repo ?? new JsonFileRepo(stateRoot),
    }
    this.library = new ExpertLibrary(deps)
    this.workspaceRoot = config.workspaceRoot ?? join(stateRoot, 'agents')
    this.templatesRoot = config.templatesRoot ?? DEFAULT_TEMPLATES_ROOT
    this.ready = new Promise((resolve) => { this.markReady = resolve })
  }

  protected async [Service.init](): Promise<void> {
    const loaded = loadTemplates(this.templatesRoot)
    for (const error of loaded.errors) this.ctx.logger?.warn?.(`tentacle persona: template rejected — ${error}`)
    for (const template of loaded.templates) this.templates.set(template.manifest.id, template)

    await this.library.boot()
    await this.plantTemplates()
    for (const expert of this.library.list()) this.ensureWorkspace(expert)

    // The registry supplies the selectable roster (official + our presets).
    this.ctx.inject(['agentPresets'], (injected) => {
      const registry = (injected as unknown as {
        agentPresets?: {
          defaultId: string
          list(): Promise<readonly { id: string; name?: string; description?: string; broken?: string }[]>
        }
      }).agentPresets
      if (registry === undefined) return
      this.presetRoster = async () => {
        const defaultId = registry.defaultId
        const rows = await registry.list()
        return rows.map((row) => ({
          id: row.id,
          ...(row.name === undefined ? {} : { name: row.name }),
          ...(row.description === undefined ? {} : { description: row.description }),
          ...(row.broken === undefined ? {} : { broken: row.broken }),
          isDefault: row.id === defaultId,
        }))
      }
      return () => { this.presetRoster = undefined }
    })

    this.ctx.inject(['tentacleGateway'], (gwCtx) => {
      const gateway = (gwCtx as unknown as { tentacleGateway: GatewayLike }).tentacleGateway
      const disposeRoutes = createExpertRoutes(this).map((route) => gateway.registerRoute(route))
      this.ctx.logger?.info?.('tentacle persona: expert admin routes registered on the gateway')
      return () => {
        for (const d of disposeRoutes) d()
      }
    })
    this.markReady()
  }

  /** Create one instance per bundled template (the reference implementation's boot-time seeding). */
  private async plantTemplates(): Promise<void> {
    for (const template of this.templates.values()) {
      const existing = this.library.get(template.manifest.id)
      if (existing !== undefined) {
        this.ensureWorkspace(existing)
        continue
      }
      const expert = await this.library.create({
        id: template.manifest.id,
        name: template.manifest.label,
        description: template.manifest.description,
        ...(template.manifest.icon === undefined ? {} : { icon: template.manifest.icon }),
        ...(template.manifest.color === undefined ? {} : { color: template.manifest.color }),
        agentPreset: template.manifest.agentPreset ?? 'standard',
        templateId: template.manifest.id,
        builtin: true,
      })
      seedTemplate(template, this.workspaceOf(expert.id))
    }
    // Every install keeps at least one expert, even when the template library
    // is absent or empty: the console must never be unconfigurable.
    if (this.library.list().length === 0) {
      const expert = await this.library.create({
        ...FALLBACK_EXPERT,
        builtin: true,
      })
      this.ensureWorkspace(expert)
    }
  }

  /** Persona text: the template's SOUL.md, else a minimal role line. */
  private personaPrefixOf(template: ExpertTemplate): string {
    const soul = join(template.dir, 'SOUL.md')
    if (existsSync(soul)) {
      const text = readFileSync(soul, 'utf8').trim()
      if (text !== '') return text
    }
    return `You are ${template.manifest.label.en}.`
  }

  /** One workspace per instance (channel sessions of this expert share it). */
  workspaceOf(expertId: string): string {
    return join(this.workspaceRoot, expertId, 'workspace')
  }

  /** Root of the expert's DSH skills (`<workspace>/.dsh/skills`). */
  skillsRootOf(expertId: string): string {
    return join(this.workspaceOf(expertId), '.dsh', 'skills')
  }

  /**
   * Ensure the instance workspace exists and was seeded exactly once. Files are
   * never re-copied once the manifest snapshot exists — template upgrades stay
   * out of existing instances (detach rule).
   */
  private ensureWorkspace(expert: Expert): void {
    const dir = this.workspaceOf(expert.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const template = this.templates.get(expert.templateId ?? expert.id)
    const seeded = existsSync(join(dir, WORKSPACE_MANIFEST_PATH))
    if (template !== undefined) {
      if (!seeded) seedTemplate(template, dir)
      return
    }
    const soul = join(dir, 'SOUL.md')
    if (!existsSync(soul)) writeFileSync(soul, `# ${expert.name.en}\n\n${expert.description.en}\n`, { mode: 0o600 })
  }

  private async requirePreset(id: string): Promise<string> {
    const presetId = id.trim()
    if (presetId === '') throw new ExpertError('invalid-expert', 'agentPreset must be selected')
    if (this.presetRoster !== undefined) {
      const roster = await this.presetRoster()
      const row = roster.find((candidate) => candidate.id === presetId)
      if (row === undefined) throw new ExpertError('no-such-preset', `no such agent preset: ${presetId}`)
      if (row.broken !== undefined) throw new ExpertError('invalid-expert', `preset cannot compose: ${row.broken}`)
    }
    return presetId
  }

  /** Selectable presets: the deployment registry roster. */
  async listPresets(): Promise<readonly PresetRosterView[]> {
    if (this.presetRoster === undefined) return []
    const rows = await this.presetRoster().catch(() => [])
    return rows
      .map((row) => ({
        id: row.id,
        ...(row.name === undefined ? {} : { name: row.name }),
        ...(row.description === undefined ? {} : { description: row.description }),
        default: row.isDefault,
        managed: false,
        ...(row.broken === undefined ? {} : { broken: row.broken }),
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async createExpert(input: ExpertInput): Promise<Expert> {
    const agentPreset = await this.requirePreset(input.agentPreset)
    const expert = await this.library.create({ ...input, agentPreset })
    this.ensureWorkspace(expert)
    return expert
  }

  /** Bundled templates with their manifest metadata (admin console library). */
  listTemplates(): readonly ExpertTemplateView[] {
    const experts = this.library.list()
    return [...this.templates.values()].map((template) => {
      const installed = experts.find((expert) => expert.templateId === template.manifest.id)
      return {
        id: template.manifest.id,
        label: template.manifest.label,
        description: template.manifest.description,
        ...(template.manifest.icon === undefined ? {} : { icon: template.manifest.icon }),
        ...(template.manifest.color === undefined ? {} : { color: template.manifest.color }),
        ...(template.manifest.welcomeMessage === undefined ? {} : { welcomeMessage: template.manifest.welcomeMessage }),
        quickPrompts: template.manifest.quickPrompts ?? [],
        agentPresetId: template.manifest.agentPreset ?? 'standard',
        ...(installed === undefined ? {} : { installedExpertId: installed.id }),
      }
    })
  }

  /**
   * Clone a bundled template into a NEW expert instance: the instance selects
   * the template's shared preset, and its seed files (skills, SOUL, manifest)
   * are copied into the new workspace on first use (detach rule — later
   * template upgrades never touch this instance's files).
   */
  async createExpertFromTemplate(templateId: string, overrides: CreateFromTemplateInput = {}): Promise<Expert> {
    const template = this.templates.get(templateId)
    if (template === undefined) throw new ExpertError('no-such-template', `no template: ${templateId}`)
    return await this.createExpert({
      ...(overrides.id === undefined ? {} : { id: overrides.id }),
      name: overrides.name ?? template.manifest.label,
      description: overrides.description ?? template.manifest.description,
      ...(template.manifest.icon === undefined ? {} : { icon: template.manifest.icon }),
      ...(template.manifest.color === undefined ? {} : { color: template.manifest.color }),
      agentPreset: template.manifest.agentPreset ?? 'standard',
      templateId,
    })
  }

  async updateExpert(id: string, patch: ExpertPatch): Promise<Expert> {
    const before = this.library.get(id)
    if (before === undefined) throw new ExpertError('no-such-expert', `no expert: ${id}`)
    const nextPreset = patch.agentPreset === undefined ? undefined : await this.requirePreset(patch.agentPreset)
    const expert = await this.library.update(id, {
      ...patch,
      ...(nextPreset === undefined ? {} : { agentPreset: nextPreset }),
    })
    this.ensureWorkspace(expert)
    return expert
  }

  async removeExpert(id: string): Promise<void> {
    const expert = this.library.get(id)
    if (expert === undefined) throw new ExpertError('no-such-expert', `no expert: ${id}`)
    // Builtin first: the reference check below is about tenant resources, not
    // about the seeded identity (that 409 has its own code).
    if (expert.builtin) throw new ExpertError('builtin-protected', `builtin expert ${id} cannot be deleted`)
    for (const guard of this.removalGuards) {
      const reason = guard(id)
      if (reason !== undefined) {
        this.ctx.logger?.warn?.(`tentacle persona: refusing to delete ${id}: ${reason}`)
        throw new ExpertError('expert-in-use', reason)
      }
    }
    await this.library.remove(id)
  }

  /**
   * Register a deletion veto from the plugin that owns the references (design
   * 09 §3.4). Returns the disposer; registration is idempotent per callback.
   */
  registerExpertRemovalGuard(guard: ExpertRemovalGuard): () => void {
    this.removalGuards.add(guard)
    return () => { this.removalGuards.delete(guard) }
  }

  /**
   * The expert a channel with no recorded binding is migrated onto. Prefer the
   * guaranteed `general-assistant`, else the first builtin, else the first
   * instance — boot guarantees at least one exists (design 09 §3.1).
   */
  get defaultExpertId(): string {
    const pinned = this.library.storedDefaultExpertId
    if (pinned !== undefined) return pinned
    const experts = this.library.list()
    const preferred = experts.find((expert) => expert.id === 'general-assistant')
      ?? experts.find((expert) => expert.builtin)
      ?? experts[0]
    if (preferred === undefined) throw new Error('tentacle persona: the expert library is empty')
    return preferred.id
  }

  /** Pin the default expert channels bind to when no expert is recorded. */
  async setDefaultExpert(id: string): Promise<Expert> {
    await this.library.setDefaultExpertId(id)
    this.ctx.logger?.info?.(`tentacle persona: default expert is now ${id}`)
    return this.library.get(id)!
  }

  listExperts(): readonly Expert[] {
    return this.library.list()
  }

  /** What a channel session should start with — resolved at dispatch time. */
  resolveForSession(expertId: string): ExpertRoute | undefined {
    const expert = this.library.get(expertId)
    if (expert === undefined) return undefined
    this.ensureWorkspace(expert)
    return {
      agentPresetId: expert.agentPreset,
      ...(expert.model === undefined ? {} : { model: expert.model }),
      ...(expert.permissionPreset === undefined ? {} : { permissionPreset: expert.permissionPreset }),
      workspacePath: this.workspaceOf(expert.id),
    }
  }

  /** Roster for the channel console's expert dropdown. */
  listExpertRoutes(): readonly ExpertRouteSummary[] {
    return this.library.list().map((expert) => ({
      id: expert.id,
      name: joinText(expert.name, ' / '),
      agentPresetId: expert.agentPreset,
    }))
  }

  // ---- workspace skills ---------------------------------------------------

  /** List the skills under `<workspace>/.dsh/skills` (dirs and flat files). */
  listSkills(expertId: string): readonly ExpertSkillSummary[] {
    this.requireExpert(expertId)
    const root = this.skillsRootOf(expertId)
    const skills: ExpertSkillSummary[] = []
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      return skills
    }
    for (const entry of entries.sort()) {
      const full = join(root, entry)
      const stat = statSync(full)
      let file: string
      if (stat.isDirectory()) file = join(full, 'SKILL.md')
      else if (entry.endsWith('.md')) file = full
      else continue
      if (!existsSync(file)) continue
      const parsed = parseSkillFrontmatter(readFileSync(file, 'utf8'))
      const name = parsed.name ?? (stat.isDirectory() ? entry : entry.slice(0, -3))
      skills.push({
        name,
        description: parsed.description ?? '',
        path: relative(this.workspaceOf(expertId), file).split(sep).join('/'),
      })
    }
    return skills
  }

  /** Read one skill body for editing. */
  getSkill(expertId: string, name: string): SkillFile {
    this.requireExpert(expertId)
    assertSkillName(name)
    const root = this.skillsRootOf(expertId)
    const dirFile = join(root, name, 'SKILL.md')
    const flatFile = join(root, `${name}.md`)
    const file = existsSync(dirFile) ? dirFile : existsSync(flatFile) ? flatFile : undefined
    if (file === undefined) throw new ExpertError('invalid-skill', `no such skill: ${name}`)
    const parsed = parseSkillFrontmatter(readFileSync(file, 'utf8'))
    return {
      name: parsed.name ?? name,
      description: parsed.description ?? '',
      path: relative(this.workspaceOf(expertId), file).split(sep).join('/'),
      body: parsed.body,
    }
  }

  /** Create or replace one skill bundle under the expert workspace. */
  saveSkill(expertId: string, input: { name: string; description: string; body: string }): SkillFile {
    this.requireExpert(expertId)
    const name = input.name.trim()
    assertSkillName(name)
    const description = input.description.trim()
    if (description === '') throw new ExpertError('invalid-skill', 'skill description must not be empty')
    const dir = join(this.skillsRootOf(expertId), name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const content = [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      '',
      input.body.trim(),
      '',
    ].join('\n')
    writeFileSync(join(dir, 'SKILL.md'), content, { mode: 0o600 })
    return this.getSkill(expertId, name)
  }

  /** Remove one skill bundle from the expert workspace. */
  removeSkill(expertId: string, name: string): void {
    this.requireExpert(expertId)
    assertSkillName(name)
    const root = this.skillsRootOf(expertId)
    const dir = join(root, name)
    const flat = join(root, `${name}.md`)
    if (existsSync(dir) && statSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true })
    else if (existsSync(flat)) rmSync(flat, { force: true })
    else throw new ExpertError('invalid-skill', `no such skill: ${name}`)
  }

  private requireExpert(expertId: string): Expert {
    const expert = this.library.get(expertId)
    if (expert === undefined) throw new ExpertError('no-such-expert', `no expert: ${expertId}`)
    this.ensureWorkspace(expert)
    return expert
  }
}

function assertSkillName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new ExpertError('invalid-skill', 'skill name must be a lowercase slug')
  }
}
