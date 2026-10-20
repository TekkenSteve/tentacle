/**
 * Team preset registration tests (design 10 §3): the definition shape, and
 * the sync lifecycle against a fake official registry — register on change,
 * skip on no-op, drop deleted teams, dispose everything on teardown.
 */
import { describe, expect, it } from 'vitest'
import type { AgentPresetRegistry, PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { TeamPresetSync, teamPresetDefinition, teamPresetId } from '../src/preset.js'

/** Minimal fake of the official registry: records registrations and disposals. */
class FakeRegistry {
  readonly registered: PresetDefinition[] = []
  readonly disposed: string[] = []
  /** Simulate the official rule: a duplicate id fails loading. */
  duplicateIds = true

  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    if (this.duplicateIds && this.registered.some((d) => d.id === definition.id)) {
      throw new Error(`duplicate preset id: ${definition.id}`)
    }
    this.registered.push(definition)
    return async () => {
      this.disposed.push(definition.id)
      const at = this.registered.findIndex((d) => d.id === definition.id)
      if (at >= 0) this.registered.splice(at, 1)
    }
  }
}

function input(overrides: Partial<Parameters<typeof teamPresetDefinition>[0]> = {}) {
  return {
    teamId: 'product-review',
    displayName: '产品评审',
    hostPrompt: 'host prompt v1',
    memberCount: 2,
    ...overrides,
  }
}

describe('teamPresetDefinition', () => {
  it('mounts persona + agent-team + tool-agent-team with the roster cap', () => {
    const def = teamPresetDefinition(input())
    expect(def.id).toBe('team-product-review')
    expect(def.name).toBe('团队：产品评审')
    // The rows live in an isolate group: the agent-team row registers the
    // `agentTeams` service, and a preset mounts in the registry's root realm
    // unless a group isolates it (mountPreset rejects leaked services).
    const [group] = def.plugins as [
      { name: string; group: boolean; isolate: Record<string, boolean>; config: { name: string; config?: Record<string, unknown> }[] },
    ]
    expect(group.name).toBe('cordis:group')
    expect(group.group).toBe(true)
    expect(group.isolate).toEqual({ agentTeams: true })
    const rows = group.config
    expect(rows.map((r) => r.name)).toEqual([
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-experimental-agent-team',
      '@deepseek-ai/dsh-experimental-tool-agent-team',
    ])
    expect(rows[0]!.config).toMatchObject({ prefix: 'host prompt v1' })
    // maxMembers = roster size: the structural cap (10 §1).
    expect(rows[1]!.config).toMatchObject({ maxMembers: 2 })
    expect(rows[2]!.config).toMatchObject({ freshProvider: 'spawn', forkProvider: 'fork' })
  })
})

describe('TeamPresetSync', () => {
  it('registers one preset per team', async () => {
    const registry = new FakeRegistry()
    const sync = new TeamPresetSync(registry as unknown as AgentPresetRegistry)
    await sync.syncAll([input(), input({ teamId: 'tech-review', displayName: '技术评审' })])
    expect(registry.registered.map((d) => d.id)).toEqual(['team-product-review', 'team-tech-review'])
    expect(registry.disposed).toEqual([])
  })

  it('re-registers only when the definition changed', async () => {
    const registry = new FakeRegistry()
    const sync = new TeamPresetSync(registry as unknown as AgentPresetRegistry)
    await sync.syncAll([input()])
    await sync.syncAll([input()])
    expect(registry.registered).toHaveLength(1)
    expect(registry.disposed).toEqual([])

    await sync.syncAll([input({ hostPrompt: 'host prompt v2' })])
    expect(registry.disposed).toEqual(['team-product-review'])
    expect(registry.registered).toHaveLength(1)
    const [group] = registry.registered[0]!.plugins as [{ config: { config?: Record<string, unknown> }[] }]
    expect(group.config[0]!.config).toMatchObject({ prefix: 'host prompt v2' })
  })

  it('drops presets of deleted teams and keeps the rest', async () => {
    const registry = new FakeRegistry()
    const sync = new TeamPresetSync(registry as unknown as AgentPresetRegistry)
    await sync.syncAll([input(), input({ teamId: 'tech-review' })])
    await sync.syncAll([input()])
    expect(registry.disposed).toEqual(['team-tech-review'])
    expect(registry.registered.map((d) => d.id)).toEqual(['team-product-review'])
  })

  it('drop() and disposeAll() release their presets', async () => {
    const registry = new FakeRegistry()
    const sync = new TeamPresetSync(registry as unknown as AgentPresetRegistry)
    await sync.syncAll([input(), input({ teamId: 'tech-review' })])
    await sync.drop('product-review')
    expect(registry.disposed).toEqual(['team-product-review'])
    await sync.disposeAll()
    expect(registry.disposed).toEqual(['team-product-review', 'team-tech-review'])
    expect(registry.registered).toEqual([])
  })

  it('teamPresetId is the documented prefix', () => {
    expect(teamPresetId('abc')).toBe('team-abc')
  })
})
