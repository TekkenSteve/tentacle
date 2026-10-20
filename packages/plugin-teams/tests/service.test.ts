/**
 * TentacleTeams service tests: the wiring that makes a team a first-class
 * object (design 10). Fakes stand in for the three host seams — persona
 * (member authority + skills), the official preset registry, the gateway —
 * so these tests cover the glue, not the hosts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentPresetRegistry, PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { GatewayRoute } from '@tentacle/gateway'
import * as teamsPlugin from '../src/index.js'
import type { TentacleTeams } from '../src/service.js'

/** The plugin rows inside a team preset's isolate group. */
function teamRowsOf(def: PresetDefinition): { name: string; config?: Record<string, unknown> }[] {
  const [group] = def.plugins as [{ config: { name: string; config?: Record<string, unknown> }[] }]
  return group.config
}

/** The four experts the bundled templates need. */
const EXPERTS = [
  { id: 'general-assistant', name: { zh: '通用助手', en: 'General Assistant' }, description: { zh: '通用', en: 'General' } },
  { id: 'code-reviewer', name: { zh: '代码评审', en: 'Code Reviewer' }, description: { zh: '工程评审', en: 'Engineering review' } },
  { id: 'translator', name: { zh: '翻译', en: 'Translator' }, description: { zh: '本地化', en: 'Localization' } },
  { id: 'ops-engineer', name: { zh: '运维工程', en: 'Ops Engineer' }, description: { zh: '运维', en: 'Operations' } },
]

let root: string
let expertSkills: Record<string, string>
let cleanup: (() => void) | undefined

/** Records registrations, like the official registry (duplicate ids fail). */
class FakeRegistry {
  readonly registered: PresetDefinition[] = []
  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    if (this.registered.some((d) => d.id === definition.id)) throw new Error(`duplicate preset id: ${definition.id}`)
    this.registered.push(definition)
    return async () => {
      const at = this.registered.findIndex((d) => d.id === definition.id)
      if (at >= 0) this.registered.splice(at, 1)
    }
  }
}

class FakePersona extends Service {
  constructor(ctx: Context) { super(ctx, 'tentaclePersona') }
  readonly ready = Promise.resolve()
  readonly removalGuards: ((expertId: string) => string | undefined)[] = []
  listExperts(): typeof EXPERTS { return EXPERTS }
  skillsRootOf(expertId: string): string { return expertSkills[expertId]! }
  registerExpertRemovalGuard(guard: (expertId: string) => string | undefined): () => void {
    this.removalGuards.push(guard)
    return () => {
      const at = this.removalGuards.indexOf(guard)
      if (at >= 0) this.removalGuards.splice(at, 1)
    }
  }
}

class FakePresets extends Service {
  constructor(ctx: Context) { super(ctx, 'agentPresets') }
  readonly registry = new FakeRegistry()
  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    return await this.registry.register(definition)
  }
}

class FakeGateway extends Service {
  constructor(ctx: Context) { super(ctx, 'tentacleGateway') }
  readonly routes: GatewayRoute[] = []
  registerRoute(route: GatewayRoute): () => void {
    this.routes.push(route)
    return () => {
      const at = this.routes.indexOf(route)
      if (at >= 0) this.routes.splice(at, 1)
    }
  }
}

async function bootTeams(): Promise<{ app: Context; service: TentacleTeams; presets: FakeRegistry; gateway: FakeGateway; persona: FakePersona }> {
  const app = new Context()
  const persona = new FakePersona(app)
  const presets = new FakePresets(app)
  const gateway = new FakeGateway(app)
  const fiber = app.plugin(teamsPlugin, {
    stateRoot: root,
    workspaceRoot: join(root, 'agents'),
  })
  await fiber
  const service = app.tentacleTeams
  await service.ready
  return { app, service, presets: presets.registry, gateway, persona }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tentacle-teams-svc-'))
  expertSkills = {}
  for (const expert of EXPERTS) {
    const skillsRoot = join(root, 'expert-ws', expert.id, '.dsh', 'skills')
    mkdirSync(join(skillsRoot, `${expert.id}-skill`), { recursive: true })
    writeFileSync(join(skillsRoot, `${expert.id}-skill`, 'SKILL.md'), '---\ndescription: s\n---\nbody')
    expertSkills[expert.id] = skillsRoot
  }
})

afterEach(() => {
  cleanup?.()
  rmSync(root, { recursive: true, force: true })
})

describe('TentacleTeams boot', () => {
  it('plants one builtin instance per bundled template', async () => {
    const { service } = await bootTeams()
    const teams = service.listTeams()
    expect(teams.map((t) => t.id).sort()).toEqual([
      'content-planning', 'data-analysis', 'product-review', 'tech-review',
    ])
    const review = teams.find((t) => t.id === 'product-review')!
    expect(review.builtin).toBe(true)
    expect(review.members.map((m) => m.expertId)).toEqual(['code-reviewer', 'general-assistant'])
    expect(review.presetId).toBe('team-product-review')
  })

  it('registers one managed preset per team with the roster cap', async () => {
    const { presets } = await bootTeams()
    expect(presets.registered.map((d) => d.id).sort()).toEqual([
      'team-content-planning', 'team-data-analysis', 'team-product-review', 'team-tech-review',
    ])
    const def = presets.registered.find((d) => d.id === 'team-product-review')!
    const rows = teamRowsOf(def)
    expect(rows[0]!.name).toBe('@deepseek-ai/dsh-persona')
    expect(String(rows[0]!.config!['prefix'])).toContain('团队契约')
    expect(rows[1]!.config!['maxMembers']).toBe(2)
  })

  it('seeds the workspace: SOUL.md, manifest snapshot and materialized skills', async () => {
    const { service } = await bootTeams()
    const workspace = service.workspaceOf('product-review')
    expect(readFileSync(join(workspace, 'SOUL.md'), 'utf8')).toContain('团队契约')
    expect(existsSync(join(workspace, '.tentacle', 'manifest.json'))).toBe(true)
    const skills = service.listSkills('product-review').map((s) => s.path)
    expect(skills).toEqual(['code-reviewer/code-reviewer-skill', 'general-assistant/general-assistant-skill'])
  })

  it('registers admin routes on the gateway', async () => {
    const { gateway } = await bootTeams()
    expect(gateway.routes).toHaveLength(1)
    expect(gateway.routes[0]!.prefix).toBe('/tentacle/api/admin/teams')
  })
})

describe('TentacleTeams writes', () => {
  it('create validates the roster and refreshes workspace + preset', async () => {
    const { service, presets } = await bootTeams()
    const team = await service.createTeam({
      id: 'ops-squad', name: '运营小组', description: '值班', members: [{ expertId: 'ops-engineer', role: '值班' }, { expertId: 'general-assistant', role: '总结' }],
    })
    expect(team.builtin).toBe(false)
    expect(service.listSkills(team.id).map((s) => s.path)).toEqual([
      'general-assistant/general-assistant-skill', 'ops-engineer/ops-engineer-skill',
    ])
    const def = presets.registered.find((d) => d.id === `team-${team.id}`)!
    expect(teamRowsOf(def)[1]!.config!['maxMembers']).toBe(2)
    await expect(service.createTeam({ name: 'X', description: 'x', members: [{ expertId: 'ghost', role: 'r' }] }))
      .rejects.toMatchObject({ code: 'member-invalid' })
  })

  it('update re-renders the workspace prompt', async () => {
    const { service } = await bootTeams()
    await service.updateTeam('product-review', { contract: { goal: '先结论' } })
    expect(readFileSync(join(service.workspaceOf('product-review'), 'SOUL.md'), 'utf8')).toContain('先结论')
  })

  it('remove deletes the preset, the workspace and the team', async () => {
    const { service, presets } = await bootTeams()
    const team = await service.createTeam({ id: 'temp', name: 'Temp', description: 't', members: [{ expertId: 'translator', role: 'r' }, { expertId: 'ops-engineer', role: 'o' }] })
    await service.removeTeam(team.id)
    expect(service.library.get('temp')).toBeUndefined()
    expect(presets.registered.some((d) => d.id === 'team-temp')).toBe(false)
    expect(existsSync(join(root, 'agents', 'temp'))).toBe(false)
  })

  it('builtin identity is fixed but the roster stays editable', async () => {
    const { service } = await bootTeams()
    await expect(service.updateTeam('product-review', { name: '改名' })).rejects.toMatchObject({ code: 'builtin-protected' })
    await expect(service.removeTeam('product-review')).rejects.toMatchObject({ code: 'builtin-protected' })
    const swapped = await service.updateTeam('product-review', {
      members: [{ expertId: 'translator', role: '本地化' }, { expertId: 'ops-engineer', role: '数据' }],
    })
    expect(swapped.members.map((m) => m.expertId)).toEqual(['translator', 'ops-engineer'])
    expect(service.listSkills('product-review').map((s) => s.path)).toEqual([
      'ops-engineer/ops-engineer-skill', 'translator/translator-skill',
    ])
  })

  it('restores a builtin team from its template', async () => {
    const { service } = await bootTeams()
    await service.updateTeam('product-review', { members: [{ expertId: 'translator', role: '本地化' }, { expertId: 'ops-engineer', role: '数据' }] })
    const restored = await service.restoreTeamFromTemplate('product-review')
    expect(restored.members.map((m) => m.expertId)).toEqual(['code-reviewer', 'general-assistant'])
    await expect(service.restoreTeamFromTemplate('ghost')).rejects.toMatchObject({ code: 'no-such-team' })
  })

  it('creates an editable clone from a template', async () => {
    const { service } = await bootTeams()
    const clone = await service.createTeamFromTemplate('tech-review', { id: 'my-tech-review', name: '我的技术评审' })
    expect(clone.builtin).toBe(false)
    expect(clone.templateId).toBe('tech-review')
    expect(clone.name).toEqual({ zh: '我的技术评审', en: '我的技术评审' })
    await service.removeTeam(clone.id)
  })
})

describe('TentacleTeams referential integrity', () => {
  it('vetoes deleting a member expert that a team uses', async () => {
    const { persona } = await bootTeams()
    expect(persona.removalGuards).toHaveLength(1)
    const guard = persona.removalGuards[0]!
    expect(guard('code-reviewer')).toContain('member of team(s)')
    expect(guard('translator')).toBeDefined()
    expect(guard('unknown-expert')).toBeUndefined()
  })

  it('vetoes deleting a team a channel points at', async () => {
    const { service } = await bootTeams()
    const team = await service.createTeam({ id: 'guarded', name: 'Guarded', description: 'g', members: [{ expertId: 'translator', role: 'r' }, { expertId: 'ops-engineer', role: 'o' }] })
    const dispose = service.registerRemovalGuard((teamId) => teamId === team.id ? 'in use' : undefined)
    await expect(service.removeTeam(team.id)).rejects.toMatchObject({ code: 'team-in-use' })
    dispose()
    await service.removeTeam(team.id)
  })
})

describe('TentacleTeams channel seam', () => {
  it('resolves the managed preset and shared workspace for sessions', async () => {
    const { service } = await bootTeams()
    const route = service.resolveForSession('tech-review')!
    expect(route.agentPresetId).toBe('team-tech-review')
    expect(route.workspacePath).toBe(service.workspaceOf('tech-review'))
    expect(service.resolveForSession('ghost')).toBeUndefined()
    expect(service.listTeamRoutes()).toHaveLength(4)
  })

  it('lists member options with usage counts', async () => {
    const { service } = await bootTeams()
    const options = service.listMemberOptions()
    expect(options.find((o) => o.id === 'code-reviewer')!.usedByTeams).toBe(2)
    expect(options.find((o) => o.id === 'translator')!.usedByTeams).toBe(1)
  })
})
