/**
 * Admin API authorization matrix for the expert routes. The route handlers
 * are invoked directly with a fake GatewayRoute context — no real gateway
 * needed — because the gateway's authentication fence (401 for anonymous on
 * non-public routes) is covered by the tenancy/gateway suites; what THIS
 * suite pins down is the role check and the error vocabulary.
 */
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Identity } from '@tentacle/gateway'
import * as personaPlugin from '../src/index.js'
import { createExpertRoutes } from '../src/admin-api.js'
import type { TentaclePersona } from '../src/service.js'

const PREFIX = '/tentacle/api/admin/experts'

function mockReq(method: string, path: string, body?: unknown): IncomingMessage {
  // Buffer chunks: the handler's Buffer.concat would reject plain strings.
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage
  req.method = method
  req.url = PREFIX + path
  return req
}

interface MockRes {
  status: number
  body: any
}

function mockRes(): ServerResponse & { result: MockRes } {
  const result: MockRes = { status: 0, body: undefined }
  const res = {
    result,
    writeHead(status: number) { result.status = status; return res },
    end(payload?: string) { result.body = payload ? JSON.parse(payload) : undefined },
  }
  return res as never
}

const ADMIN = { identity: { roles: ['admin'] } as Identity }
const USER = { identity: { roles: ['user'] } as Identity }
const ANON = { identity: undefined }

describe('expert admin API', () => {
  let persona: TentaclePersona
  let handler: (...args: never[]) => Promise<void>
  const call = (method: string, path: string, context: object, body?: unknown): Promise<MockRes> => {
    const res = mockRes()
    return Promise.resolve(handler(mockReq(method, path, body) as never, res as never, context as never)).then(() => res.result)
  }

  beforeAll(async () => {
    const app = new Context()
    await app.plugin(personaPlugin, {
      stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-persona-api-')),
      // No AgentPreset mounting under test here — a do-nothing class keeps
      // the fibers cheap and the assertions focused on the HTTP surface.
      agentPreset: class NoopPreset {},
    })
    persona = app.tentaclePersona
    await persona.ready
    handler = createExpertRoutes(persona)[0]!.handler as never
  })

  it('rejects anonymous and non-admin callers with 403', async () => {
    for (const context of [ANON, USER]) {
      expect((await call('GET', '/', context)).status).toBe(403)
      expect((await call('POST', '/', context, { name: 'x', description: 'y', agentPreset: 'standard' })).status).toBe(403)
      expect((await call('POST', '/remove', context, { id: 'x' })).status).toBe(403)
    }
    expect((await call('GET', '/', ANON)).body.error).toBe('permission required: experts')
  })

  it('admits a non-admin role carrying the experts permission key', async () => {
    const withKey = { identity: { subjectId: 'did:key:zCurator', handle: 'curator', roles: ['expert-curator'], permissions: ['experts'] } }
    expect((await call('GET', '/', withKey)).status).toBe(200)
    const withoutKey = { identity: { subjectId: 'did:key:zPlain', handle: 'plain', roles: ['user'], permissions: [] } }
    expect((await call('GET', '/', withoutKey)).status).toBe(403)
  })

  it('lists the seeded builtin experts for admins', async () => {
    const res = await call('GET', '/', ADMIN)
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThanOrEqual(4)
    const ids = res.body.map((e: any) => e.id)
    for (const id of ['general-assistant', 'ops-engineer', 'code-reviewer', 'translator']) {
      expect(ids).toContain(id)
    }
    expect(res.body.every((e: any) => e.builtin === true)).toBe(true)
    // The console projection: selected preset, ownership, default and workspace.
    const general = res.body.find((e: any) => e.id === 'general-assistant')
    expect(general).toMatchObject({
      agentPreset: 'standard',
      default: true,
      workspacePath: persona.workspaceOf('general-assistant'),
      skills: expect.any(Number),
    })
    expect(general.id).toBe('general-assistant')
    expect(general.agentPreset).not.toBe(general.id)
    expect(res.body.filter((e: any) => e.default === true)).toHaveLength(1)
  })

  it('lists the bundled template library with its seeded instance', async () => {
    const res = await call('GET', '/templates', ADMIN)
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThanOrEqual(4)
    const general = res.body.find((t: any) => t.id === 'general-assistant')
    expect(general).toMatchObject({
      id: 'general-assistant',
      agentPresetId: 'standard',
      installedExpertId: 'general-assistant',
    })
    expect(general.label.zh).toBe('通用助手')
    expect(Array.isArray(general.quickPrompts)).toBe(true)
  })

  it('clones a template into a new expert instance', async () => {
    const created = await call('POST', '/', ADMIN, { templateId: 'ops-engineer', id: 'ops-engineer-copy' })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({
      id: 'ops-engineer-copy',
      templateId: 'ops-engineer',
      builtin: false,
      agentPreset: 'standard',
    })
    // Blank identity overrides keep the template's bilingual manifest.
    expect(created.body.name.zh).toBe('运维工程师')
    expect(created.body.name.en).toBe('Ops Engineer')

    // The copy is a real, editable, deletable instance.
    const updated = await call('POST', '/update', ADMIN, { id: 'ops-engineer-copy', name: 'My Ops' })
    expect(updated.status).toBe(200)
    expect((await call('POST', '/remove', ADMIN, { id: 'ops-engineer-copy' })).status).toBe(200)

    const missing = await call('POST', '/', ADMIN, { templateId: 'no-such-template' })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('no-such-template')
  })

  it('creates, updates, and removes a user expert', async () => {
    const created = await call('POST', '/', ADMIN, {
      name: 'SRE 专家',
      description: '站点可靠性',
      agentPreset: 'standard',
    })
    expect(created.status).toBe(200)
    expect(created.body.id).toBe('sre')
    expect(created.body.agentPreset).toBe('standard')

    const updated = await call('POST', '/update', ADMIN, { id: 'sre', agentPreset: 'minimal' })
    expect(updated.status).toBe(200)
    expect(updated.body.agentPreset).toBe('minimal')

    expect((await call('POST', '/remove', ADMIN, { id: 'sre' })).status).toBe(200)
    expect((await call('POST', '/remove', ADMIN, { id: 'sre' })).status).toBe(404)
  })

  it('lists selectable presets and manages workspace skills', async () => {
    const presets = await call('GET', '/presets', ADMIN)
    expect(presets.status).toBe(200)
    expect(Array.isArray(presets.body)).toBe(true)

    const saved = await call('POST', '/skills/save', ADMIN, {
      id: 'general-assistant',
      name: 'release-notes',
      description: 'Write release notes.',
      body: '# Release notes',
    })
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ name: 'release-notes', description: 'Write release notes.' })
    const listed = await call('GET', '/skills?id=general-assistant', ADMIN)
    expect(listed.body.some((skill: any) => skill.name === 'release-notes')).toBe(true)
    const read = await call('GET', '/skills/get?id=general-assistant&name=release-notes', ADMIN)
    expect(read.body.body).toContain('# Release notes')
    expect((await call('POST', '/skills/remove', ADMIN, { id: 'general-assistant', name: 'release-notes' })).status).toBe(200)
    expect((await call('GET', '/skills?id=general-assistant', ADMIN)).body
      .some((skill: any) => skill.name === 'release-notes')).toBe(false)
  })

  it('pins the default expert channels migrate onto', async () => {
    const set = await call('POST', '/default', ADMIN, { id: 'ops-engineer' })
    expect(set.status).toBe(200)
    const list = await call('GET', '/', ADMIN)
    expect(list.body.find((e: any) => e.id === 'ops-engineer').default).toBe(true)
    expect(list.body.filter((e: any) => e.default === true)).toHaveLength(1)
    await call('POST', '/default', ADMIN, { id: 'general-assistant' })
  })

  it('maps the error vocabulary to stable statuses', async () => {
    // duplicate
    await call('POST', '/', ADMIN, { id: 'dup', name: 'a', description: 'b', agentPreset: 'standard' })
    expect((await call('POST', '/', ADMIN, { id: 'dup', name: 'a', description: 'b', agentPreset: 'standard' })).status).toBe(409)
    // invalid (no preset selected)
    const bad = await call('POST', '/', ADMIN, { id: '!!', name: 'a', description: 'b' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid-expert')
    // unknown action
    expect((await call('POST', '/nonsense', ADMIN, {})).status).toBe(404)
  })

  it('builtin experts: preset/routing editable, identity immutable, deletion 409', async () => {
    const updated = await call('POST', '/update', ADMIN, { id: 'ops-engineer', agentPreset: 'minimal' })
    expect(updated.status).toBe(200)
    expect(updated.body.agentPreset).toBe('minimal')

    const renamed = await call('POST', '/update', ADMIN, { id: 'ops-engineer', name: '改名' })
    expect(renamed.status).toBe(409)
    expect(renamed.body.error).toBe('builtin-protected')

    const removed = await call('POST', '/remove', ADMIN, { id: 'ops-engineer' })
    expect(removed.status).toBe(409)
    expect(removed.body.error).toBe('builtin-protected')

    // and the library is untouched by the rejected mutations
    const list = await call('GET', '/', ADMIN)
    const ops = list.body.find((e: any) => e.id === 'ops-engineer')
    expect(ops.name.zh).toBe('运维工程师')
  })

  it('a referenced expert is refused with 409 expert-in-use, then deletable once released', async () => {
    const created = await call('POST', '/', ADMIN, { id: 'bound', name: 'Bound', description: 'b', agentPreset: 'standard' })
    expect(created.status).toBe(200)

    const release = persona.registerExpertRemovalGuard(() => 'channel "bot-a" routes to expert bound')
    const blocked = await call('POST', '/remove', ADMIN, { id: 'bound' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toBe('expert-in-use')
    // Still in the library: a refused deletion is not a partial one.
    expect((await call('GET', '/', ADMIN)).body.some((e: any) => e.id === 'bound')).toBe(true)

    release()
    expect((await call('POST', '/remove', ADMIN, { id: 'bound' })).status).toBe(200)
  })
})
