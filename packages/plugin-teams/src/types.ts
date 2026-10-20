/**
 * Team domain types (design: docs/design/10-teams.md, the reference implementation's
 * `infra/agents/teams` contract ported to Tentacle's asset base).
 *
 * A **Team** is a first-class composition unit beside {@link Expert}: where an
 * expert is one persona with one workspace, a team is a roster of experts with
 * per-member roles and a shared collaboration contract. The official
 * `dsh-experimental-agent-team` runtime performs the actual collaboration;
 * this layer is the product/data layer the reference implementation had and Tentacle was missing
 * (channels → team → experts).
 *
 * This file is cordis-free on purpose: the domain core (team library,
 * template catalog) is unit-testable without a Host.
 */
import type { ExpertModelSelection } from '@tentacle/persona'

/**
 * Bilingual display text. Contract fields are rendered into the host prompt
 * and shown in the admin console, so both locales are stored rather than
 * resolved at render time (same rule as the expert library).
 */
export interface LocalizedText {
  zh: string
  en: string
}

/** Input form accepted from the API/UI: a plain string lands in both locales. */
export type LocalizedInput = string | LocalizedText

/**
 * Compact bilingual rendering for display and prompts: one line when both
 * locales agree (most user-created content is single-language).
 */
export function joinLocalized(text: LocalizedText): string {
  return text.zh === text.en ? text.zh : `${text.zh} / ${text.en}`
}

/** One roster row: a member expert plus the role it plays in THIS team. */
export interface TeamMember {
  readonly expertId: string
  readonly role: LocalizedText
}

/** Member input accepted from the API/UI. */
export interface TeamMemberInput {
  readonly expertId: string
  readonly role: LocalizedInput
}

/**
 * The shared collaboration contract (10 §2). Every field is optional — a team
 * may carry only a goal, or a full contract; the renderer (prompt.ts) omits
 * empty sections instead of printing blank headers.
 */
export interface TeamContract {
  readonly goal?: LocalizedText
  readonly constraints: readonly LocalizedText[]
  readonly delivery?: LocalizedText
  /** 0–3 example briefs showing the kind of work this team takes. */
  readonly examples: readonly LocalizedText[]
}

/** Contract input accepted from the API/UI. */
export interface TeamContractInput {
  readonly goal?: LocalizedInput | null
  readonly constraints?: readonly LocalizedInput[]
  readonly delivery?: LocalizedInput | null
  readonly examples?: readonly LocalizedInput[]
}

/** The contract with every optional section cleared. */
export function emptyTeamContract(): TeamContract {
  return { constraints: [], examples: [] }
}

/** One quick-start card from a team template manifest. */
export interface QuickPrompt {
  readonly title: LocalizedText
  readonly prompt: LocalizedText
}

/** Input form: a plain string lands in both locales (same rule as LocalizedInput). */
export interface QuickPromptInput {
  readonly title: LocalizedInput
  readonly prompt: LocalizedInput
}

/**
 * How members may work together (10 §5). The official runtime lets ANY member
 * message any other member — there is no runtime switch — so this is prompt
 * discipline only, persisted so the contract stays data.
 */
export type TeamCollaboration = 'dispatch' | 'auto'

/** reference-shaped manifest.json of one team template. */
export interface TeamTemplateManifest {
  readonly id: string
  readonly label: LocalizedText
  readonly description: LocalizedText
  readonly welcomeMessage?: LocalizedText
  readonly icon?: string
  readonly color?: string
  readonly quickPrompts?: readonly QuickPrompt[]
  /** Seed roster: expert ids with the role each plays (10 §10). */
  readonly members: readonly TeamMember[]
  /** Seed contract the instance starts with (editable afterwards). */
  readonly contract?: TeamContract
  /** Seed collaboration mode; defaults to `dispatch`. */
  readonly collaboration?: TeamCollaboration
}

/** One template discovered on disk (manifest is the only file). */
export interface TeamTemplate {
  readonly manifest: TeamTemplateManifest
  readonly dir: string
}

/**
 * A user-owned team INSTANCE (the reference implementation's `agents` row with `kind="team"`).
 *
 * `templateId` is provenance only: the instance is detached after creation —
 * template upgrades never touch existing instances (the reference implementation's detach rule).
 * Builtin instances (planted from bundled templates) keep their identity
 * fixed; roster, contract and routing stay editable, and the console offers
 * restore-from-template (10 §2).
 */
export interface Team {
  /** Slug, immutable after creation. */
  readonly id: string
  name: LocalizedText
  description: LocalizedText
  /** Short glyph (emoji) shown in lists. Optional. */
  icon?: string
  /** Card accent colour (CSS colour); copied from the template manifest. */
  color?: string
  /** Roster of member experts with per-member roles (2–8 rows). Replaced
   * whole by the library on update; the array itself is read-only to callers. */
  members: readonly TeamMember[]
  /** Shared collaboration contract rendered into the host prompt. */
  contract: TeamContract
  welcomeMessage?: LocalizedText
  quickPrompts: readonly QuickPrompt[]
  /** Per-session model route; omitted = deployment default. */
  model?: ExpertModelSelection
  /** Permission preset for this team's sessions; omitted = router default. */
  permissionPreset?: string
  /** Member-to-member discipline, rendered into the host prompt (10 §5). */
  collaboration: TeamCollaboration
  /** Template this instance was created from (provenance only). */
  readonly templateId?: string
  /** Seeded from a bundled template: identity fixed, deletion refused. */
  readonly builtin: boolean
  readonly createdAt: number
  updatedAt: number
}

export interface TeamState {
  version: 1
  /**
   * True once the bundled templates have been planted as instances. Seeding
   * happens exactly once per state root: afterwards the library belongs to the
   * user and a package upgrade never overwrites their edits.
   */
  seeded: boolean
  teams: Team[]
}

export function emptyState(): TeamState {
  return { version: 1, seeded: false, teams: [] }
}

/** Roster bounds (10 §2): a team needs real division of labour, and the
 * official runtime's default `maxMembers` is 16 — we cap well below it so a
 * roster stays reviewable and the preset-level cap (10 §3) stays meaningful. */
export const TEAM_MIN_MEMBERS = 2
export const TEAM_MAX_MEMBERS = 8
/** Contract bounds (10 §2). */
export const MAX_CONSTRAINTS = 8
export const MAX_EXAMPLES = 3
