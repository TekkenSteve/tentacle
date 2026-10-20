/**
 * TentaclePersona domain tests: experts select shared presets, own their
 * workspace (skills live there), model route, permission preset and channel
 * bindings. The preset registry is out of scope here (covered by DSH); the
 * service is booted without one, so `listPresets()` falls back to empty.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import * as personaPlugin from '../src/index.js'
import type { TentaclePersona } from '../src/service.js'

async function bootService(
  config: Partial<personaPlugin.TentaclePersonaConfig> = {},
): Promise<{ app: Context; fiber: Fiber; service: TentaclePersona }> {
  const app = new Context()
  const fiber = app.plugin(personaPlugin, {
    stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-persona-svc-')),
    ...config,
  })
  await fiber
  const service = app.tentaclePersona
  await service.ready
  return { app, fiber, service }
}

describe('TentaclePersona preset selection', () => {
  it('seeds one expert per template, each selecting the template preset', async () => {
    const { service } = await bootService()
    expect(service.listExperts().length).toBeGreaterThanOrEqual(4)
    for (const template of service.listTemplates()) {
      const expert = service.library.get(template.id)!
      expect(expert.agentPreset).toBe('standard')
      expect(expert.builtin).toBe(true)
      expect(template.agentPresetId).toBe('standard')
    }
  })

  it('createExpert stores the selected preset without deriving a new one', async () => {
    const { service } = await bootService()
    const expert = await service.createExpert({
      name: 'SRE 专家',
      description: '站点可靠性',
      agentPreset: 'minimal',
    })
    expect(expert.agentPreset).toBe('minimal')
    expect(service.resolveForSession(expert.id)?.agentPresetId).toBe('minimal')
  })

  it('updateExpert switches the selected preset', async () => {
    const { service } = await bootService()
    const expert = await service.createExpert({ name: 'Ops', description: 'ops', agentPreset: 'standard' })
    const switched = await service.updateExpert(expert.id, { agentPreset: 'ptc' })
    expect(switched.agentPreset).toBe('ptc')
  })

  it('rejects an empty preset selection', async () => {
    const { service } = await bootService()
    await expect(service.createExpert({ name: 'No Preset', description: 'x', agentPreset: '  ' }))
      .rejects.toMatchObject({ code: 'invalid-expert' })
  })

  it('disposes cleanly when the plugin unloads', async () => {
    const { fiber } = await bootService()
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })
})

describe('TentaclePersona experts as composition roots (design 09)', () => {
  it('plants template instances with a seeded workspace and resolves session routing', async () => {
    const { service } = await bootService()
    const ops = service.library.get('ops-engineer')!
    expect(ops.templateId).toBe('ops-engineer')
    expect(ops.builtin).toBe(true)

    const route = service.resolveForSession('ops-engineer')!
    expect(route.agentPresetId).toBe('standard')
    expect(route.workspacePath).toBe(service.workspaceOf('ops-engineer'))
    expect(existsSync(join(route.workspacePath, 'SOUL.md'))).toBe(true)
    expect(existsSync(join(route.workspacePath, '.tentacle', 'manifest.json'))).toBe(true)
    expect(existsSync(join(route.workspacePath, '.dsh', 'skills', 'k8s-triage', 'SKILL.md'))).toBe(true)
    expect(service.resolveForSession('nope')).toBeUndefined()
  })

  it('clones a bundled template into a detached instance selecting the template preset', async () => {
    const { service } = await bootService()
    const expert = await service.createExpertFromTemplate('ops-engineer', { id: 'ops-copy', name: 'Ops Copy' })
    expect(expert).toMatchObject({
      id: 'ops-copy',
      templateId: 'ops-engineer',
      builtin: false,
      name: { zh: 'Ops Copy', en: 'Ops Copy' },
      agentPreset: 'standard',
    })
    const route = service.resolveForSession('ops-copy')!
    expect(existsSync(join(route.workspacePath, 'SOUL.md'))).toBe(true)
    expect(existsSync(join(route.workspacePath, '.tentacle', 'manifest.json'))).toBe(true)
    const general = service.listTemplates().find((template) => template.id === 'general-assistant')
    expect(general?.installedExpertId).toBe('general-assistant')
    await expect(service.createExpertFromTemplate('no-such-template')).rejects.toMatchObject({ code: 'no-such-template' })
  })

  it('carries the instance model and permission preset into the resolved route', async () => {
    const { service } = await bootService()
    const expert = await service.createExpert({
      name: 'Review Squad',
      description: 'Reviews with a fixed model',
      agentPreset: 'standard',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      permissionPreset: 'read-only',
    })
    const route = service.resolveForSession(expert.id)!
    expect(route.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(route.permissionPreset).toBe('read-only')
    expect(service.listExpertRoutes()).toContainEqual({
      id: expert.id,
      name: 'Review Squad',
      agentPresetId: 'standard',
    })
  })

  it('manages workspace skills under .dsh/skills', async () => {
    const { service } = await bootService()
    const saved = service.saveSkill('ops-engineer', {
      name: 'release-notes',
      description: 'Write release notes from a diff.',
      body: '# Release notes\nSummarize user-visible changes.',
    })
    expect(saved).toMatchObject({ name: 'release-notes', description: 'Write release notes from a diff.' })
    const skills = service.listSkills('ops-engineer')
    expect(skills.map((skill) => skill.name)).toContain('release-notes')
    expect(skills.map((skill) => skill.name)).toContain('k8s-triage')
    const file = join(service.workspaceOf('ops-engineer'), '.dsh', 'skills', 'release-notes', 'SKILL.md')
    expect(existsSync(file)).toBe(true)
    expect(service.getSkill('ops-engineer', 'release-notes').body).toContain('# Release notes')
    service.removeSkill('ops-engineer', 'release-notes')
    expect(service.listSkills('ops-engineer').map((skill) => skill.name)).not.toContain('release-notes')
    expect(() => service.saveSkill('ops-engineer', { name: 'Bad Name', description: 'x', body: '' }))
      .toThrowError(/lowercase slug/)
  })
})

describe('TentaclePersona guaranteed default (design 09 §3)', () => {
  it('ships a minimal general expert even when no template library exists', async () => {
    const emptyTemplates = mkdtempSync(join(tmpdir(), 'tentacle-persona-empty-templates-'))
    const { service } = await bootService({ templatesRoot: emptyTemplates })
    expect(service.listExperts()).toHaveLength(1)
    const [expert] = service.listExperts()
    expect(expert).toMatchObject({ id: 'general-assistant', builtin: true, agentPreset: 'standard' })
    const route = service.resolveForSession('general-assistant')!
    expect(existsSync(join(route.workspacePath, 'SOUL.md'))).toBe(true)
  })

  it('exposes a configurable default expert channels migrate onto, and guards its deletion', async () => {
    const { service } = await bootService()
    expect(service.defaultExpertId).toBe('general-assistant')
    await service.setDefaultExpert('ops-engineer')
    expect(service.defaultExpertId).toBe('ops-engineer')
    await service.setDefaultExpert('general-assistant')

    const user = await service.createExpert({
      name: 'Bound Expert',
      description: 'Referenced by a channel',
      agentPreset: 'standard',
    })
    const release = service.registerExpertRemovalGuard((id) => (id === user.id ? 'used by channel bot-a' : undefined))
    await expect(service.removeExpert(user.id)).rejects.toMatchObject({ code: 'expert-in-use' })
    const free = await service.createExpert({ name: 'Free Expert', description: 'free', agentPreset: 'standard' })
    await expect(service.removeExpert(free.id)).resolves.toBeUndefined()
    release()
    await expect(service.removeExpert(user.id)).resolves.toBeUndefined()
  })

  it('returns an empty selectable roster without a preset registry', async () => {
    const { service } = await bootService()
    expect(await service.listPresets()).toEqual([])
  })
})
