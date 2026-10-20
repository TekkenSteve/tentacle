/**
 * ExpertLibrary domain-core tests: seed idempotency, CRUD, builtin guards and
 * the v3 preset-reference model. All against MemoryRepo (the core never touches
 * cordis or the filesystem); JsonFileRepo gets round-trip + migration tests.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExpertLibrary, slugify } from '../src/experts.js'
import { JsonFileRepo, MemoryRepo } from '../src/repo.js'

function memoryLibrary(repo = new MemoryRepo()): ExpertLibrary {
  return new ExpertLibrary({ repo })
}

const customInput = {
  name: 'DBA 专家',
  description: '数据库运维',
  agentPreset: 'standard',
}

describe('ExpertLibrary boot', () => {
  it('is a pure record store: no in-code seeds (templates are planted by the service)', async () => {
    const lib = memoryLibrary()
    await lib.boot()
    expect(lib.list().length).toBe(0)
  })

  it('is idempotent: a second boot neither duplicates nor overwrites edits', async () => {
    const repo = new MemoryRepo()
    const first = memoryLibrary(repo)
    await first.boot()
    await first.create({ ...customInput, id: 'ops-engineer', builtin: true })
    await first.update('ops-engineer', { agentPreset: 'minimal' })
    await first.create(customInput)

    const again = memoryLibrary(repo)
    await again.boot()
    expect(again.list().length).toBe(2)
    expect(again.get('ops-engineer')?.agentPreset).toBe('minimal')
    expect(again.get('dba')).toBeDefined()
  })
})

describe('ExpertLibrary CRUD', () => {
  it('creates user experts selecting an existing preset; slugifies the id by default', async () => {
    const lib = memoryLibrary()
    await lib.boot()
    const expert = await lib.create(customInput)
    expect(expert.id).toBe('dba')
    expect(expert.builtin).toBe(false)
    expect(expert.agentPreset).toBe('standard')
    expect(expert.presetSpec).toBeUndefined()
    expect(expert.name).toEqual({ zh: 'DBA 专家', en: 'DBA 专家' })
    expect(slugify('  My Helper!! ')).toBe('my-helper')
  })

  it('stores model and permission preset; model can be cleared', async () => {
    const lib = memoryLibrary()
    await lib.boot()
    const expert = await lib.create({
      name: 'Owned 专家',
      description: '自带预设选择',
      agentPreset: 'standard',
      model: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096 },
      permissionPreset: 'workspace-write',
      templateId: 'general-assistant',
    })
    expect(expert.agentPreset).toBe('standard')
    expect(expert.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096 })
    expect(expert.permissionPreset).toBe('workspace-write')
    expect(expert.templateId).toBe('general-assistant')

    const cleared = await lib.update(expert.id, { model: null, permissionPreset: null })
    expect(cleared.model).toBeUndefined()
    expect(cleared.permissionPreset).toBeUndefined()
  })

  it('accepts explicit ids and bilingual pairs', async () => {
    const lib = memoryLibrary()
    await lib.boot()
    const expert = await lib.create({
      id: 'db-admin',
      name: { zh: '数据库管理员', en: 'DB Admin' },
      description: { zh: '库表与备份', en: 'Schemas and backups' },
      icon: '🗄️',
      agentPreset: 'standard',
    })
    expect(expert.id).toBe('db-admin')
    expect(expert.name.en).toBe('DB Admin')
    expect(expert.icon).toBe('🗄️')
  })

  it('rejects duplicates, invalid ids, missing preset selection and empty owned persona', async () => {
    const lib = memoryLibrary()
    await lib.boot()
    await lib.create(customInput)
    await expect(lib.create(customInput)).rejects.toMatchObject({ code: 'duplicate-expert' })
    await expect(lib.create({ id: '../evil', ...customInput })).rejects.toMatchObject({ code: 'invalid-expert' })
    await expect(lib.create({ ...customInput, id: 'empty-preset', agentPreset: '  ' })).rejects.toMatchObject({ code: 'invalid-expert' })
    await expect(lib.create({ name: { zh: '', en: '' }, description: 'x', agentPreset: 'standard' }))
      .rejects.toMatchObject({ code: 'invalid-expert' })
  })

  it('updates user experts freely; builtin rows keep their identity but accept routing/preset changes', async () => {
    const lib = memoryLibrary()
    await lib.boot()
    const created = await lib.create(customInput)

    const updated = await lib.update(created.id, { name: 'DBA 大师', icon: '🐘' })
    expect(updated.name.zh).toBe('DBA 大师')
    expect(updated.icon).toBe('🐘')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt)

    await lib.create({ ...customInput, id: 'translator', builtin: true })
    const seeded = await lib.update('translator', { agentPreset: 'minimal', model: { provider: 'deepseek', model: 'deepseek-chat' } })
    expect(seeded.agentPreset).toBe('minimal')
    expect(seeded.model?.model).toBe('deepseek-chat')
    await expect(lib.update('translator', { name: '改名' })).rejects.toMatchObject({ code: 'builtin-protected' })
    await expect(lib.update('translator', { icon: '💥' })).rejects.toMatchObject({ code: 'builtin-protected' })
    await expect(lib.update('ghost', {})).rejects.toMatchObject({ code: 'no-such-expert' })
  })

  it('removes user experts but protects builtin ones', async () => {
    const lib = memoryLibrary()
    await lib.boot()
    const created = await lib.create(customInput)
    await lib.remove(created.id)
    expect(lib.get(created.id)).toBeUndefined()

    await lib.create({ ...customInput, id: 'general-assistant', builtin: true })
    await expect(lib.remove('general-assistant')).rejects.toMatchObject({ code: 'builtin-protected' })
    expect(lib.get('general-assistant')).toBeDefined()
    await expect(lib.remove('ghost')).rejects.toMatchObject({ code: 'no-such-expert' })
  })
})

describe('JsonFileRepo', () => {
  it('round-trips state through the state root with 0600 writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-persona-'))
    const repo = new JsonFileRepo(root)
    const lib = new ExpertLibrary({ repo })
    await lib.boot()
    await lib.create(customInput)

    const reloaded = new ExpertLibrary({ repo: new JsonFileRepo(root) })
    await reloaded.boot()
    expect(reloaded.list().length).toBe(1)
    expect(reloaded.get('dba')?.name.zh).toBe('DBA 专家')

    const onDisk = JSON.parse(readFileSync(join(root, 'experts.json'), 'utf8'))
    expect(onDisk.seeded).toBe(true)
    expect(onDisk.version).toBe(3)
  })

  it('migrates v2 persona/plugins rows onto the deployment default preset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-persona-migrate-'))
    writeFileSync(join(root, 'experts.json'), JSON.stringify({
      version: 2,
      seeded: true,
      experts: [{
        id: 'legacy',
        name: { zh: '旧', en: 'Legacy' },
        description: { zh: '旧', en: 'Legacy' },
        personaPrefix: '# Role\nold',
        plugins: [{ name: '@deepseek-ai/dsh-tool-subagent' }],
        builtin: false,
        createdAt: 0,
        updatedAt: 0,
      }],
    }))
    const lib = new ExpertLibrary({ repo: new JsonFileRepo(root) })
    await lib.boot()
    expect(lib.get('legacy')).toMatchObject({
      agentPreset: 'standard',
      id: 'legacy',
    })
  })
})
