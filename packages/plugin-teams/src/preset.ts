/**
 * Team preset registration (design 10 §3).
 *
 * Every team owns one managed Agent preset (`team-<id>`) whose rows are:
 *
 *   - `@deepseek-ai/dsh-persona` with `prefix` = the rendered host prompt
 *     (prompt.ts) — the ONLY way a session gets its persona, since
 *     `dsh-persona` reads config, never workspace files;
 *   - `@deepseek-ai/dsh-experimental-agent-team` with `maxMembers` = roster
 *     size — the structural roster cap (10 §1);
 *  - `@deepseek-ai/dsh-experimental-tool-agent-team` — the model-facing
 *     Team tools (`spawn_teammate` / `send_message` / `wait_agent` /
 *     `team_task_*` / `list_agents` / `interrupt_agent`).
 *
 * Presets are ADDITIVE overlays on the base composition (the standard preset
 * ships `plugins: []`), so team sessions keep the base tool surface —
 * teammates inherit it and can do real work (10 §1).
 *
 * The official registry owns revisions: `register()` returns a disposer and
 * duplicate ids fail loading, so a refresh is dispose-then-register guarded
 * by a content hash (an unrelated team's edit must not churn this one).
 * Edits affect subsequently created Agents only — live sessions keep the
 * composition they started with (official preset-edit semantics).
 */
import type { AgentPresetRegistry, PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

/** Preset id prefix; the roster teammate names are the member expert ids. */
export const TEAM_PRESET_PREFIX = 'team-'

export function teamPresetId(teamId: string): string {
  return `${TEAM_PRESET_PREFIX}${teamId}`
}

/** The model-facing Team tool plugin, configured like the official profile. */
const TOOL_AGENT_TEAM = '@deepseek-ai/dsh-experimental-tool-agent-team'
const AGENT_TEAM = '@deepseek-ai/dsh-experimental-agent-team'
const PERSONA = '@deepseek-ai/dsh-persona'

/** What one team's preset registration needs. */
export interface TeamPresetInput {
  readonly teamId: string
  /** Display name for the preset roster (locales joined by the service). */
  readonly displayName: string
  /** Rendered host prompt (prompt.ts) — becomes the persona prefix. */
  readonly hostPrompt: string
  /** Roster size — the structural `maxMembers` cap (10 §1). */
  readonly memberCount: number
}

/** Build the preset definition for one team (pure; exported for tests). */
export function teamPresetDefinition(input: TeamPresetInput): PresetDefinition {
  return {
    id: teamPresetId(input.teamId),
    name: `团队：${input.displayName}`,
    plugins: [
      {
        // The team rows register services (`agentTeams`), and a preset mounts
        // in the registry's root realm unless a group isolates them — the same
        // pattern the shipped presets use for `planMode` and `workflowEngine`.
        // The realm is per mount, so every team session gets its own team
        // runtime (TeamId = the session id), exactly like the official profile
        // gets one engine per agent.
        id: 'team',
        name: 'cordis:group',
        group: true,
        isolate: { agentTeams: true },
        config: [
          { id: 'persona', name: PERSONA, config: { prefix: input.hostPrompt } },
          { id: 'agent-team', name: AGENT_TEAM, config: { maxMembers: input.memberCount } },
          {
            id: 'tool-agent-team',
            name: TOOL_AGENT_TEAM,
            config: { freshProvider: 'spawn', forkProvider: 'fork' },
          },
        ],
      },
    ],
  }
}

/** Cheap content key: re-register only when the definition actually changed. */
function definitionKey(input: TeamPresetInput): string {
  return JSON.stringify([input.displayName, input.memberCount, input.hostPrompt])
}

/**
 * Keeps one managed preset per team in sync with the team library. The
 * service drives it: `syncAll` after boot and after every team write.
 *
 * Every operation is serialized through one promise chain: a boot-time sync
 * must never interleave with a write-triggered sync, or both would observe
 * the pre-write key and register the same preset id twice (the official
 * registry rejects duplicates). Writes are rare, so a chain costs nothing.
 */
export class TeamPresetSync {
  private readonly disposers = new Map<string, () => Promise<void>>()
  private readonly keys = new Map<string, string>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly registry: AgentPresetRegistry) {}

  /** Enqueue one mutation on the serialized chain. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.queue.then(op, op)
    // Keep the chain alive even when an op rejects; callers see the error.
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Reconcile presets against the live team ids: drop presets of deleted
   * teams, (re)register changed ones, leave untouched ones alone.
   */
  syncAll(teams: readonly TeamPresetInput[]): Promise<void> {
    return this.enqueue(async () => {
      const live = new Set(teams.map((t) => t.teamId))
      for (const [teamId, dispose] of [...this.disposers]) {
        if (live.has(teamId)) continue
        await dispose()
        this.disposers.delete(teamId)
        this.keys.delete(teamId)
      }
      for (const team of teams) {
        const key = definitionKey(team)
        if (this.keys.get(team.teamId) === key && this.disposers.has(team.teamId)) continue
        await this.disposers.get(team.teamId)?.()
        const dispose = await this.registry.register(teamPresetDefinition(team))
        this.disposers.set(team.teamId, dispose)
        this.keys.set(team.teamId, key)
      }
    })
  }

  /** Drop one team's preset (called on team deletion before syncAll). */
  drop(teamId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.disposers.get(teamId)?.()
      this.disposers.delete(teamId)
      this.keys.delete(teamId)
    })
  }

  /** Dispose every managed preset (plugin teardown). */
  disposeAll(): Promise<void> {
    return this.enqueue(async () => {
      for (const dispose of [...this.disposers.values()]) await dispose()
      this.disposers.clear()
      this.keys.clear()
    })
  }
}
