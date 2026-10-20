/**
 * Team template catalog (design 10 §10) — the filesystem port of the reference implementation's
 * `teams/template/` + `seed_team_template`.
 *
 * A team template is ONE file: `manifest.json` carrying the bilingual
 * identity, the seed roster (member expert ids + per-member roles) and the
 * seed contract. Unlike expert templates there are no seed files — the host
 * persona is fully rendered from the instance's data by `prompt.ts`, so a
 * template is pure data and the workspace is generated at seed time
 * (`workspace.ts`). Planting an instance copies nothing from disk beyond
 * the manifest values; later template upgrades never touch existing
 * instances (the reference implementation's detach rule).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamLibrary } from './library.js'
import type { LocalizedText, QuickPrompt, TeamCollaboration, TeamContract, TeamMember, TeamTemplate, TeamTemplateManifest } from './types.js'

export interface TeamTemplateLoadResult {
  readonly templates: readonly TeamTemplate[]
  /** One human-readable line per rejected template; a bad template never kills boot. */
  readonly errors: readonly string[]
}

function isLocalized(value: unknown): value is LocalizedText {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { zh?: unknown; en?: unknown }
  return typeof candidate.zh === 'string' && candidate.zh.trim() !== ''
    && typeof candidate.en === 'string' && candidate.en.trim() !== ''
}

function parseQuickPrompts(raw: unknown): QuickPrompt[] {
  if (!Array.isArray(raw)) return []
  const prompts: QuickPrompt[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as { title?: unknown; prompt?: unknown }
    if (!isLocalized(candidate.title) || !isLocalized(candidate.prompt)) continue
    prompts.push({ title: candidate.title, prompt: candidate.prompt })
  }
  return prompts
}

function parseMembers(raw: unknown): TeamMember[] {
  if (!Array.isArray(raw)) return []
  const members: TeamMember[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as { expert_id?: unknown; role?: unknown }
    if (typeof candidate.expert_id !== 'string' || candidate.expert_id.trim() === '') continue
    if (!isLocalized(candidate.role)) continue
    members.push({ expertId: candidate.expert_id.trim(), role: candidate.role })
  }
  return members
}

function parseContract(raw: unknown): TeamContract | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as Record<string, unknown>
  const optional = (key: string): LocalizedText | undefined =>
    isLocalized(candidate[key]) ? candidate[key] as LocalizedText : undefined
  const list = (key: string): LocalizedText[] =>
    Array.isArray(candidate[key]) ? (candidate[key] as unknown[]).filter(isLocalized) : []
  const contract: TeamContract = {
    ...(optional('goal') === undefined ? {} : { goal: optional('goal') }),
    constraints: list('constraints'),
    ...(optional('delivery') === undefined ? {} : { delivery: optional('delivery') }),
    examples: list('examples'),
  }
  // An all-empty contract is indistinguishable from "no contract".
  if (contract.goal === undefined && contract.constraints.length === 0
    && contract.delivery === undefined && contract.examples.length === 0) {
    return undefined
  }
  return contract
}

function parseManifest(raw: unknown): TeamTemplateManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest must be an object')
  const candidate = raw as Record<string, unknown>
  if (typeof candidate['id'] !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(candidate['id'])) {
    throw new Error('manifest.id must be a slug')
  }
  if (!isLocalized(candidate['label'])) throw new Error('manifest.label requires zh and en text')
  if (!isLocalized(candidate['description'])) throw new Error('manifest.description requires zh and en text')
  const members = parseMembers(candidate['members'])
  if (members.length === 0) throw new Error('manifest.members requires at least one expert_id + role')
  const collaboration = candidate['collaboration']
  if (collaboration !== undefined && collaboration !== 'dispatch' && collaboration !== 'auto') {
    throw new Error(`manifest.collaboration must be dispatch or auto`)
  }
  const optional = (key: string): string | undefined =>
    typeof candidate[key] === 'string' && (candidate[key] as string).trim() !== '' ? (candidate[key] as string).trim() : undefined
  return {
    id: candidate['id'],
    label: candidate['label'],
    description: candidate['description'],
    ...(isLocalized(candidate['welcome_message']) ? { welcomeMessage: candidate['welcome_message'] } : {}),
    ...(optional('icon') === undefined ? {} : { icon: optional('icon') }),
    ...(optional('color') === undefined ? {} : { color: optional('color') }),
    quickPrompts: parseQuickPrompts(candidate['quick_prompts']),
    members,
    ...(parseContract(candidate['contract']) === undefined ? {} : { contract: parseContract(candidate['contract']) }),
    ...(collaboration === undefined ? {} : { collaboration: collaboration as TeamCollaboration }),
  }
}

/** Scan a templates root (missing root = empty catalog, never an error). */
export function loadTeamTemplates(root: string): TeamTemplateLoadResult {
  const templates: TeamTemplate[] = []
  const errors: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { templates, errors }
    throw error
  }
  for (const name of entries.sort()) {
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
      if (manifest.id !== name) throw new Error(`manifest.id "${manifest.id}" must match directory "${name}"`)
      templates.push({ manifest, dir })
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { templates, errors }
}

/** The full seed one template contributes (used by planting and cloning). */
export function teamSeedOf(manifest: TeamTemplateManifest): {
  name: typeof manifest.label
  description: typeof manifest.description
  icon?: string
  color?: string
  members: TeamTemplateManifest['members']
  contract?: TeamContract
  welcomeMessage?: LocalizedText
  quickPrompts: readonly QuickPrompt[]
  collaboration: TeamCollaboration
} {
  return {
    name: manifest.label,
    description: manifest.description,
    ...(manifest.icon === undefined ? {} : { icon: manifest.icon }),
    ...(manifest.color === undefined ? {} : { color: manifest.color }),
    members: manifest.members,
    ...(manifest.contract === undefined ? {} : { contract: manifest.contract }),
    ...(manifest.welcomeMessage === undefined ? {} : { welcomeMessage: manifest.welcomeMessage }),
    quickPrompts: manifest.quickPrompts ?? [],
    collaboration: manifest.collaboration ?? 'dispatch',
  }
}

/**
 * Plant one instance per bundled template (10 §10), dropping members whose
 * expert is missing and skipping a template whose roster falls below the
 * minimum — a broken seed must never kill boot, and the console surfaces the
 * rest for repair. Returns the ids actually planted.
 */
export async function plantTeamTemplates(
  library: TeamLibrary,
  templates: readonly TeamTemplate[],
  expertExists: (expertId: string) => boolean,
): Promise<readonly string[]> {
  const planted: string[] = []
  for (const template of templates) {
    if (library.get(template.manifest.id) !== undefined) continue
    const members = template.manifest.members.filter((m) => expertExists(m.expertId))
    if (members.length < 2) continue
    const seed = teamSeedOf(template.manifest)
    const team = await library.create({
      id: template.manifest.id,
      name: seed.name,
      description: seed.description,
      ...(seed.icon === undefined ? {} : { icon: seed.icon }),
      ...(seed.color === undefined ? {} : { color: seed.color }),
      members,
      ...(seed.contract === undefined ? {} : { contract: seed.contract }),
      ...(seed.welcomeMessage === undefined ? {} : { welcomeMessage: seed.welcomeMessage }),
      quickPrompts: seed.quickPrompts,
      collaboration: seed.collaboration,
      templateId: template.manifest.id,
      builtin: true,
    })
    planted.push(team.id)
  }
  return planted
}
