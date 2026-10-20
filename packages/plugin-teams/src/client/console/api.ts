/**
 * Browser-side client for the team admin API (design 10 §6).
 *
 * The wire shapes are declared here as the CLIENT's view of the contract:
 * the bundle may not import the host half (tsdown inlines everything
 * reachable), so the fields the console renders are mirrored rather than
 * shared. Error codes keep the host's stable vocabulary and are localized by
 * {@link errorText}.
 */
import type { TeamsLocaleKey, Translate } from '../locales.ts'

export interface LocalizedText {
  readonly zh: string
  readonly en: string
}

export interface ExpertModelRoute {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
}

export interface QuickPrompt {
  readonly title: LocalizedText
  readonly prompt: LocalizedText
}

export interface TeamMemberRow {
  readonly expertId: string
  readonly role: LocalizedText
  /** Display name of the member expert (locales joined by the host). */
  readonly expertName: string
}

/** One team instance as `GET /tentacle/api/admin/teams` returns it. */
export interface TeamRow {
  readonly id: string
  readonly name: LocalizedText
  readonly description: LocalizedText
  readonly icon?: string
  readonly color?: string
  readonly members: readonly TeamMemberRow[]
  readonly contract: {
    readonly goal?: LocalizedText
    readonly constraints: readonly LocalizedText[]
    readonly delivery?: LocalizedText
    readonly examples: readonly LocalizedText[]
  }
  readonly collaboration: 'dispatch' | 'auto'
  readonly welcomeMessage?: LocalizedText
  readonly quickPrompts: readonly QuickPrompt[]
  readonly model?: ExpertModelRoute
  readonly permissionPreset?: string
  readonly templateId?: string
  readonly builtin: boolean
  readonly createdAt: number
  readonly updatedAt: number
  /** Absolute shared workspace of the instance (channel session cwd). */
  readonly workspacePath: string
  /** Managed preset id (`team-<id>`) the sessions compose. */
  readonly presetId: string
}

/** One expert the member picker may choose. */
export interface MemberOptionRow {
  readonly id: string
  readonly name: LocalizedText
  readonly description: LocalizedText
  /** How many teams already include this expert. */
  readonly usedByTeams: number
}

/** One bundled template as `GET .../templates` returns it. */
export interface TemplateRow {
  readonly id: string
  readonly label: LocalizedText
  readonly description: LocalizedText
  readonly welcomeMessage?: LocalizedText
  readonly icon?: string
  readonly color?: string
  readonly quickPrompts: readonly QuickPrompt[]
  readonly members: readonly TeamMemberRow[]
  readonly collaboration: 'dispatch' | 'auto'
  readonly contract?: {
    readonly goal?: LocalizedText
    readonly constraints?: readonly LocalizedText[]
    readonly delivery?: LocalizedText
    readonly examples?: readonly LocalizedText[]
  }
}

/** One materialized skill under the team workspace (read-only). */
export interface SkillRow {
  readonly path: string
  readonly name: string
  readonly description: string
  readonly body: string
}

/** An API rejection carrying the host's stable error code. */
export class TeamsApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'TeamsApiError'
  }
}

const PREFIX = '/tentacle/api/admin/teams'

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
    throw new TeamsApiError(code, res.status)
  }
  return payload as T
}

export async function listTeams(): Promise<TeamRow[]> {
  return await request<TeamRow[]>(`${PREFIX}/`)
}

export async function listMemberOptions(): Promise<MemberOptionRow[]> {
  return await request<MemberOptionRow[]>(`${PREFIX}/members`)
}

export async function listTemplates(): Promise<TemplateRow[]> {
  return await request<TemplateRow[]>(`${PREFIX}/templates`)
}

export async function listSkills(teamId: string): Promise<SkillRow[]> {
  return await request<SkillRow[]>(`${PREFIX}/skills?id=${encodeURIComponent(teamId)}`)
}

export async function refreshSkills(teamId: string): Promise<readonly string[]> {
  const result = await request<{ materialized: readonly string[] }>(`${PREFIX}/skills/refresh`, { id: teamId })
  return result.materialized
}

export interface TeamWrite {
  readonly id?: string
  readonly templateId?: string
  readonly name?: string | LocalizedText
  readonly description?: string | LocalizedText
  readonly icon?: string
  readonly color?: string
  readonly members?: readonly { readonly expertId: string; readonly role: string | LocalizedText }[]
  readonly contract?: {
    readonly goal?: string | LocalizedText | null
    readonly constraints?: readonly (string | LocalizedText)[]
    readonly delivery?: string | LocalizedText | null
    readonly examples?: readonly (string | LocalizedText)[]
  }
  readonly collaboration?: 'dispatch' | 'auto'
  readonly model?: ExpertModelRoute | null
  readonly permissionPreset?: string | null
  readonly welcomeMessage?: string | LocalizedText | null
  readonly quickPrompts?: readonly { readonly title: string | LocalizedText; readonly prompt: string | LocalizedText }[]
}

export async function createTeam(input: TeamWrite): Promise<TeamRow> {
  return await request<TeamRow>(`${PREFIX}/`, input)
}

export async function updateTeam(input: TeamWrite & { readonly id: string }): Promise<TeamRow> {
  return await request<TeamRow>(`${PREFIX}/update`, input)
}

export async function removeTeam(id: string): Promise<void> {
  await request<unknown>(`${PREFIX}/remove`, { id })
}

export async function restoreTeam(id: string): Promise<TeamRow> {
  return await request<TeamRow>(`${PREFIX}/restore`, { id })
}

/** Compact bilingual rendering: one line when both locales agree. */
export function text(value: LocalizedText): string {
  return value.zh === value.en ? value.zh : `${value.zh} / ${value.en}`
}

const ERROR_KEYS: Readonly<Record<string, TeamsLocaleKey>> = {
  'duplicate-team': 'teams.error.duplicate',
  'no-such-team': 'teams.error.noSuch',
  'no-such-template': 'teams.error.noSuchTemplate',
  'builtin-protected': 'teams.error.builtin',
  'team-in-use': 'teams.error.inUse',
  'invalid-team': 'teams.error.invalid',
  'member-invalid': 'teams.error.memberInvalid',
  'members-too-few': 'teams.error.tooFew',
  'members-too-many': 'teams.error.tooMany',
  'invalid-collaboration': 'teams.error.invalidCollaboration',
  'invalid-contract': 'teams.error.invalidContract',
}

/** Localized, human-readable text for a thrown API error (unknown codes verbatim). */
export function errorText(t: Translate, error: unknown): string {
  const code = error instanceof TeamsApiError
    ? error.code
    : error instanceof Error ? error.message : String(error)
  const key = ERROR_KEYS[code]
  return key === undefined ? code : t(key)
}
