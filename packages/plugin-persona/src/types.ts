/**
 * Persona domain types (design: docs/design/09-experts.md, the reference implementation's
 * `agents/experts` catalog).
 *
 * Two levels, mirroring the reference implementation:
 *  - {@link ExpertTemplate}: the bundled, read-only library item on disk
 *    (`templates/<id>/manifest.json` + seed files);
 *  - {@link Expert}: a user-owned INSTANCE and the composition root. It
 *    **selects** one official Agent preset (`agentPreset`) as its capability
 *    layer, and owns the other composition dimensions: workspace (where skill
 *    files live), model route, permission preset and channel bindings. A
 *    preset is one selectable component, never the expert identity.
 *
 * This file is cordis-free on purpose: the domain core (expert library,
 * template catalog) is unit-testable without a Host.
 */

/**
 * Bilingual display text. Names/descriptions are DATA (shown both in the
 * admin console and in the official preset roster, which is locale-unaware),
 * so both locales are stored instead of being resolved at render time.
 */
export interface LocalizedText {
  zh: string
  en: string
}

/**
 * Input form accepted from the API/UI: a plain string lands in both locales
 * (most user-created experts are single-language); builtin seeds ship the
 * full { zh, en } pair.
 */
export type LocalizedInput = string | LocalizedText

/** One composition row the expert's preset mounts (tools, skills, MCP, team…). */
export interface ExpertPluginRow {
  readonly name: string
  readonly config?: Record<string, unknown>
}

/** Per-session model route (maps to WebhookSessionRequest.model). */
export interface ExpertModelSelection {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
}

/** One quick-start card from a template manifest. */
export interface QuickPrompt {
  readonly title: LocalizedText
  readonly prompt: LocalizedText
}

/** One skill discovered under the expert workspace `.dsh/skills` root. */
export interface ExpertSkillSummary {
  /** Skill directory/file slug (also the frontmatter name). */
  readonly name: string
  readonly description: string
  /** Workspace-relative instruction file path. */
  readonly path: string
}

/** reference-shaped manifest.json of one expert template. */
export interface ExpertTemplateManifest {
  readonly id: string
  readonly label: LocalizedText
  readonly description: LocalizedText
  readonly welcomeMessage?: LocalizedText
  readonly icon?: string
  readonly color?: string
  readonly quickPrompts?: readonly QuickPrompt[]
  /** Agent preset every expert created from this template selects. */
  readonly agentPreset?: string
}

/**
 * One template discovered on disk. `files` lists workspace-relative seed paths
 * (everything under the template dir except `manifest.json`); bodies are read
 * at seed time, never held eagerly.
 */
export interface ExpertTemplate {
  readonly manifest: ExpertTemplateManifest
  readonly dir: string
  readonly files: readonly string[]
}

/**
 * A user-owned expert INSTANCE (the reference implementation's `agents` row).
 *
 * `templateId` is provenance only: seed files were copied at creation and the
 * instance is detached — template upgrades never touch existing instances.
 */
export interface Expert {
  /** Slug, immutable after creation. */
  readonly id: string
  name: LocalizedText
  description: LocalizedText
  /** Short glyph (emoji) shown in lists. Optional. */
  icon?: string
  /** Card accent colour (CSS colour); copied from the template manifest. */
  color?: string
  /**
   * The official Agent preset this expert **selects** — its capability layer
   * (tools, skill providers, MCP, team, base persona). Presets are shared
   * components: any number of experts may select the same one.
   */
  agentPreset: string
  /** Per-session model route; omitted = deployment default. */
  model?: ExpertModelSelection
  /** Permission preset for this expert's sessions; omitted = router default. */
  permissionPreset?: string
  /** Template this instance was created from (provenance only). */
  readonly templateId?: string
  /**
   * Seeded from a bundled template: cannot be deleted, and only its routing
   * and preset selection are editable (the seed identity stays recognizable).
   */
  readonly builtin: boolean
  readonly createdAt: number
  updatedAt: number
}

export interface ExpertState {
  version: 3
  /** Operator-selected default expert (channels migrate pre-expert rows onto it). */
  defaultExpertId?: string
  /**
   * True once the bundled templates have been planted as instances. Seeding
   * happens exactly once per state root: afterwards the library belongs to the
   * user and a package upgrade never overwrites their edits.
   */
  seeded: boolean
  experts: Expert[]
}

export function emptyState(): ExpertState {
  return { version: 3, seeded: false, experts: [] }
}
