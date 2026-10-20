/**
 * Browser-side client for the expert admin API (design 09 §3).
 *
 * The wire shapes are declared here as the CLIENT's view of the contract: the
 * bundle may not import the host half (tsdown inlines everything reachable),
 * so the handful of fields the console renders are mirrored rather than
 * shared. Error codes keep the host's stable vocabulary and are localized by
 * {@link errorText}.
 */
import type { PersonaLocaleKey, Translate } from '../locales.ts'

export interface LocalizedText {
  readonly zh: string
  readonly en: string
}

export interface ExpertModelRoute {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
}

/** One expert instance as `GET /tentacle/api/admin/experts` returns it. */
export interface ExpertRow {
  readonly id: string
  readonly name: LocalizedText
  readonly description: LocalizedText
  readonly icon?: string
  readonly color?: string
  /** Selected official Agent preset (capability layer) — shared. */
  readonly agentPreset: string
  readonly builtin: boolean
  readonly templateId?: string
  readonly model?: ExpertModelRoute
  readonly permissionPreset?: string
  readonly createdAt: number
  readonly updatedAt: number
  /** The deployment default expert (channels migrate pre-expert rows onto it). */
  readonly default: boolean
  /** Absolute per-instance shared workspace (channel session cwd). */
  readonly workspacePath: string
  /** Number of skills under `<workspace>/.dsh/skills`. */
  readonly skills: number
}

/** One bundled template as `GET /tentacle/api/admin/experts/templates` returns it. */
export interface TemplateRow {
  readonly id: string
  readonly label: LocalizedText
  readonly description: LocalizedText
  readonly icon?: string
  readonly color?: string
  readonly welcomeMessage?: LocalizedText
  readonly quickPrompts: readonly { readonly title: LocalizedText; readonly prompt: LocalizedText }[]
  /** Shared preset this template supplies to its experts. */
  readonly agentPresetId: string
  /** Instance planted from this template (one per bundled template today). */
  readonly installedExpertId?: string
}

/** One selectable preset from `GET .../presets`. */
export interface PresetRow {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly default: boolean
  /** Registered by Tentacle (template/owned preset). */
  readonly managed: boolean
  /** Why the preset cannot compose a session; absent when usable. */
  readonly broken?: string
}

/** One model catalog group as `/api/session/modelCatalog` advertises it. */
export interface ModelCatalogRow {
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
  }[]
  readonly default: { readonly provider: string; readonly model: string }
}

/** One permission preset from `/api/permissionPresets/catalog`. */
export interface PermissionCatalogRow {
  readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
  readonly defaultPreset?: string
}

/** One preset declaration's composition (read-only YAML). */
export interface PresetDocument {
  readonly agentPreset: string
  readonly content: string
  readonly name?: string
  readonly description?: string
}

/** One skill under the expert workspace. */
export interface SkillRow {
  readonly name: string
  readonly description: string
  readonly path: string
}

export interface SkillFile extends SkillRow {
  readonly body: string
}

/** Minimal channels-overview shape used to project per-expert channel counts. */
export interface ChannelRow {
  readonly id: string
  readonly name: string
  readonly channelType: string
  readonly enabled: boolean
  readonly expertId?: string
}

/** An API rejection carrying the host's stable error code. */
export class ExpertsApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'ExpertsApiError'
  }
}

const PREFIX = '/tentacle/api/admin/experts'
const CHANNELS_PREFIX = '/tentacle/api/admin/channels'

/**
 * Call one official connection RPC (`/api/<method>`) with the documented
 * client-request envelope. The console reads the same catalogs the official
 * UI reads instead of hardcoding providers or permission names.
 */
async function officialRpc<T>(method: string, args: unknown = {}): Promise<T> {
  const response = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `tentacle-ui-${Math.random().toString(36).slice(2)}`,
      method,
      payload: { args },
    }),
  })
  if (!response.ok) throw new Error(`rpc ${method}: HTTP ${response.status}`)
  const envelope = await response.json() as { result?: { ok?: boolean; value?: unknown; error?: { code?: string } } }
  const result = envelope.result
  if (result?.ok !== true) throw new Error(`rpc ${method}: ${result?.error?.code ?? 'rejected'}`)
  return result.value as T
}

/** Model catalog; unavailable providers/exports degrade to "no selector". */
export async function listModelCatalog(): Promise<ModelCatalogRow | undefined> {
  try {
    return await officialRpc<ModelCatalogRow>('session/modelCatalog')
  } catch {
    return undefined
  }
}

/** Permission presets catalog; unavailable composition degrades to no selector. */
export async function listPermissionCatalog(): Promise<PermissionCatalogRow | undefined> {
  try {
    return await officialRpc<PermissionCatalogRow>('permissionPresets/catalog')
  } catch {
    return undefined
  }
}

async function request<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body !== undefined ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined)
  const payload: unknown = await res.json().catch(() => undefined)
  if (!res.ok) {
    const code = typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : String(res.status)
    throw new ExpertsApiError(code, res.status)
  }
  return payload as T
}

export async function listExperts(): Promise<ExpertRow[]> {
  return await request<ExpertRow[]>(`${PREFIX}/`)
}

export async function listTemplates(): Promise<TemplateRow[]> {
  return await request<TemplateRow[]>(`${PREFIX}/templates`)
}

export async function listPresets(): Promise<PresetRow[]> {
  return await request<PresetRow[]>(`${PREFIX}/presets`)
}

export async function listSkills(expertId: string): Promise<SkillRow[]> {
  return await request<SkillRow[]>(`${PREFIX}/skills?id=${encodeURIComponent(expertId)}`)
}

export async function getSkill(expertId: string, name: string): Promise<SkillFile> {
  return await request<SkillFile>(`${PREFIX}/skills/get?id=${encodeURIComponent(expertId)}&name=${encodeURIComponent(name)}`)
}

export async function saveSkill(expertId: string, input: { name: string; description: string; body: string }): Promise<SkillFile> {
  return await request<SkillFile>(`${PREFIX}/skills/save`, { id: expertId, ...input })
}

export async function removeSkill(expertId: string, name: string): Promise<void> {
  await request<unknown>(`${PREFIX}/skills/remove`, { id: expertId, name })
}

export interface ExpertWrite {
  readonly id?: string
  readonly templateId?: string
  readonly name?: string | LocalizedText
  readonly description?: string | LocalizedText
  readonly icon?: string
  /** Selected preset (required for a blank expert; inherited by template clones). */
  readonly agentPreset?: string
  readonly model?: ExpertModelRoute | null
  readonly permissionPreset?: string | null
}

export async function createExpert(input: ExpertWrite): Promise<ExpertRow> {
  return await request<ExpertRow>(`${PREFIX}/`, input)
}

export async function updateExpert(input: ExpertWrite & { readonly id: string }): Promise<ExpertRow> {
  return await request<ExpertRow>(`${PREFIX}/update`, input)
}

export async function removeExpert(id: string): Promise<void> {
  await request<unknown>(`${PREFIX}/remove`, { id })
}

export async function readPreset(id: string): Promise<PresetDocument> {
  return await officialRpc<PresetDocument>('agentPresets/read', { agentPreset: id })
}

export async function setDefaultExpert(id: string): Promise<void> {
  await request<unknown>(`${PREFIX}/default`, { id })
}

/**
 * Channel instances of the deployment, for the per-expert channel projection.
 * The channels plugin may not be installed, or the caller may lack its
 * permission key — both are "no data", never a page failure.
 */
export async function listChannels(): Promise<ChannelRow[]> {
  try {
    const overview = await request<{ instances?: ChannelRow[] }>(CHANNELS_PREFIX)
    return overview.instances ?? []
  } catch {
    return []
  }
}

/** The preset roster is locale-unaware: show both locales side by side. */
export function text(value: LocalizedText): string {
  return value.zh === value.en ? value.zh : `${value.zh} / ${value.en}`
}

const ERROR_KEYS: Readonly<Record<string, PersonaLocaleKey>> = {
  'duplicate-expert': 'experts.error.duplicate',
  'no-such-expert': 'experts.error.noSuch',
  'no-such-template': 'experts.error.noSuchTemplate',
  'builtin-protected': 'experts.error.builtin',
  'expert-in-use': 'experts.error.inUse',
  'invalid-expert': 'experts.error.invalid',
  'no-such-preset': 'experts.error.noSuchPreset',
  'invalid-skill': 'experts.error.invalidSkill',
}

/** Localized, human-readable text for a thrown API error (unknown codes verbatim). */
export function errorText(t: Translate, error: unknown): string {
  const code = error instanceof ExpertsApiError
    ? error.code
    : error instanceof Error ? error.message : String(error)
  const key = ERROR_KEYS[code]
  return key === undefined ? code : t(key)
}
