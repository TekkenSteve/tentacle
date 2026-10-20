/**
 * Admin API authorization matrix for the channel routes. Handlers are called
 * directly with a fake GatewayRoute context — no gateway needed — because the
 * gateway's authentication fence (401 for anonymous on non-public routes) is
 * covered by the tenancy/gateway suites; what THIS suite pins down is the
 * `channels` permission check, the tenant actor derived from the authenticated
 * identity, and the stable error vocabulary (design 07 §4).
 */
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { subjectId, tenantId, type Identity } from '@tentacle/identity'
import { CHANNELS_ADMIN_PREFIX, createChannelRoutes, type ChannelAdminApi } from '../src/admin-api.js'
import { BindingsError, type BindingsErrorCode } from '../src/bindings.js'
import { ChannelError, type ChannelErrorCode, type ChannelTypeSchema } from '../src/instances.js'
import type { ChannelActor } from '../src/registry.js'
import type { ChannelInstanceView, ChannelOverview, ProbeResult } from '../src/service.js'

function mockReq(method: string, path: string, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage
  req.method = method
  req.url = CHANNELS_ADMIN_PREFIX + path
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

/** Real operators: the gateway has already authenticated the caller. */
const ADMIN: Identity = {
  subjectId: subjectId('did:key:zAdmin'),
  tenant: tenantId('local'),
  roles: ['admin'],
  createdAt: 1,
}
const OPERATOR: Identity = {
  subjectId: subjectId('did:key:zOps'),
  tenant: tenantId('local'),
  roles: ['user'],
  permissions: ['channels'],
  createdAt: 1,
}
const USER: Identity = {
  subjectId: subjectId('did:key:zUser'),
  tenant: tenantId('local'),
  roles: ['user'],
  createdAt: 1,
}

const ADMIN_CTX = { identity: ADMIN }
const OPERATOR_CTX = { identity: OPERATOR }
const USER_CTX = { identity: USER }
const ANON_CTX = { identity: undefined }

const TELEGRAM_SCHEMA: ChannelTypeSchema = {
  channelType: 'telegram',
  config: [],
  credential: null,
}

interface RecordedCall {
  readonly method: keyof ChannelAdminApi
  readonly actor: ChannelActor | undefined
  readonly input: unknown
}

/**
 * Recording service face: every route's effect — including the actor the
 * handler derived — is observable, and any method can be made to fail on
 * demand so the error vocabulary is exercised through the real catch path.
 */
class FakeChannels implements ChannelAdminApi {
  readonly calls: RecordedCall[] = []
  readonly failures: { [K in keyof ChannelAdminApi]?: unknown } = {}
  overviewResult: ChannelOverview = {
    instances: [],
    bindings: [{ channelId: 'bot-a', channelType: 'telegram', platformId: '7', subjectId: 'did:key:zA', boundAt: 1, username: 'alice' }],
    conversations: [{ channelId: 'bot-a', conversation: 'bot-a:7', sessionId: 'webhook-1' }],
  }
  readonly schemasResult: readonly ChannelTypeSchema[] = [TELEGRAM_SCHEMA]
  readonly instance: ChannelInstanceView = {
    id: 'bot-a',
    tenant: tenantId('local'),
    channelType: 'telegram',
    name: 'primary',
    enabled: true,
    config: {},
    expertId: 'general-assistant',
    createdAt: 1,
    updatedAt: 1,
    runtime: { state: 'connected', identity: { id: 42, username: 'tentacle_test_bot' } },
    credential: { configured: true, writable: true },
  }
  readonly bindableUsers: readonly { readonly subjectId: string; readonly username: string }[] = [
    { subjectId: 'did:key:zA', username: 'alice' },
  ]
  unboundResult = true

  private record(method: keyof ChannelAdminApi, actor: ChannelActor | undefined, input?: unknown): void {
    this.calls.push({ method, actor, input })
    const failure = this.failures[method]
    if (failure !== undefined) throw failure
  }

  /** The most recent recorded call; assertions are order-based. */
  last(): RecordedCall {
    return this.calls[this.calls.length - 1]!
  }

  async overview(actor: ChannelActor): Promise<ChannelOverview> {
    this.record('overview', actor)
    return this.overviewResult
  }

  schemas(): readonly ChannelTypeSchema[] {
    this.record('schemas', undefined)
    return this.schemasResult
  }

  async createChannel(input: Record<string, unknown>, actor: ChannelActor): Promise<ChannelInstanceView> {
    this.record('createChannel', actor, input)
    return this.instance
  }

  async updateChannel(input: Record<string, unknown> & { id: string }, actor: ChannelActor): Promise<ChannelInstanceView> {
    this.record('updateChannel', actor, input)
    return this.instance
  }

  async setChannelEnabled(id: string, enabled: boolean, actor: ChannelActor): Promise<ChannelInstanceView> {
    this.record('setChannelEnabled', actor, { id, enabled })
    return this.instance
  }

  async removeChannel(id: string, actor: ChannelActor): Promise<void> {
    this.record('removeChannel', actor, id)
  }

  async testChannel(id: string, actor: ChannelActor): Promise<ProbeResult> {
    this.record('testChannel', actor, id)
    return { ok: true, identity: { id: 42, username: 'tentacle_test_bot' } }
  }

  async probeChannel(input: Record<string, unknown>): Promise<ProbeResult> {
    this.record('probeChannel', undefined, input)
    return { ok: false, error: 'not reachable' }
  }

  listBindableUsers(channelId: string, actor: ChannelActor): readonly { readonly subjectId: string; readonly username: string }[] {
    this.record('listBindableUsers', actor, channelId)
    return this.bindableUsers
  }

  async bind(input: { channelId: string; platformId: string; subjectId: string }, actor: ChannelActor): Promise<unknown> {
    this.record('bind', actor, input)
    return { ...input, channelType: 'telegram', boundAt: 1 }
  }

  listExpertRoutes(): readonly { readonly id: string; readonly name: string; readonly agentPresetId: string }[] {
    this.record('listExpertRoutes', undefined)
    return [{ id: 'ops', name: 'Ops', agentPresetId: 'expert-ops' }]
  }

  async unbind(input: { channelId: string; platformId: string }, actor: ChannelActor): Promise<boolean> {
    this.record('unbind', actor, input)
    return this.unboundResult
  }

  async startProvision(input: { channelType: unknown }, actor: ChannelActor): Promise<unknown> {
    this.record('startProvision', actor, input)
    return { state: 'waiting', flowId: 'prov-1', qrUrl: 'https://qr.example/scan' }
  }

  async pollProvision(flowId: string, actor: ChannelActor): Promise<unknown> {
    this.record('pollProvision', actor, flowId)
    return { state: 'waiting', flowId }
  }

  async stopProvision(flowId: string, actor: ChannelActor): Promise<void> {
    this.record('stopProvision', actor, flowId)
  }
}

const service = new FakeChannels()
const handler = createChannelRoutes(service)[0]!.handler as never

function call(method: string, path: string, context: object, body?: unknown): Promise<MockRes> {
  const res = mockRes()
  return Promise.resolve(handler(mockReq(method, path, body) as never, res as never, context as never)).then(() => res.result)
}

describe('channels admin API authorization', () => {
  it('rejects anonymous and permissionless callers with 403 without reaching the service', async () => {
    const before = service.calls.length
    for (const context of [ANON_CTX, USER_CTX]) {
      expect((await call('GET', '/', context)).status).toBe(403)
      expect((await call('GET', '/users?channelId=bot-a', context)).status).toBe(403)
      expect((await call('POST', '/bind', context, { channelId: 'bot-a', platformId: '7', subjectId: 'did:key:zA' })).status).toBe(403)
      expect((await call('POST', '/unbind', context, { channelId: 'bot-a', platformId: '7' })).status).toBe(403)
    }
    expect((await call('GET', '/', ANON_CTX)).body.error).toBe('permission required: channels')
    expect(service.calls.length).toBe(before)
  })

  it('admits an admin and a non-admin carrying the channels permission key', async () => {
    const admin = await call('GET', '/', ADMIN_CTX)
    expect(admin.status).toBe(200)
    expect(admin.body).toEqual(service.overviewResult)

    const operator = await call('GET', '/', OPERATOR_CTX)
    expect(operator.status).toBe(200)
    expect(operator.body).toEqual(service.overviewResult)
  })

  it('derives the tenant actor from the authenticated identity, admin bit included', async () => {
    await call('GET', '/', ADMIN_CTX)
    expect(service.last().actor).toEqual({ tenant: tenantId('local'), isAdmin: true })

    await call('GET', '/', OPERATOR_CTX)
    expect(service.last().actor).toEqual({ tenant: tenantId('local'), isAdmin: false })

    // The tenant is the caller's, not a deployment default.
    const other: Identity = { ...ADMIN, subjectId: subjectId('did:key:zFar'), tenant: tenantId('other') }
    await call('GET', '/', { identity: other })
    expect(service.last().actor).toEqual({ tenant: tenantId('other'), isAdmin: true })
  })

  it('passes a standing routing failure through the overview', async () => {
    const base = service.overviewResult
    service.overviewResult = { ...base, lastFailure: 'session for bot-a:7 never appeared' }
    expect((await call('GET', '/', OPERATOR_CTX)).body.lastFailure).toBe('session for bot-a:7 never appeared')
    service.overviewResult = base
  })

  it('creates an instance and answers 201', async () => {
    const response = await call('POST', '/create', ADMIN_CTX, { channelType: 'telegram', name: 'primary' })
    expect(response.status).toBe(201)
    expect(response.body).toEqual(service.instance)
    expect(service.last()).toMatchObject({
      method: 'createChannel',
      input: { channelType: 'telegram', name: 'primary' },
      actor: { tenant: 'local', isAdmin: true },
    })
  })

  it('routes enable and disable to setChannelEnabled with the right flag', async () => {
    const enabled = await call('POST', '/enable', ADMIN_CTX, { id: 'bot-a' })
    expect(enabled.status).toBe(200)
    expect(enabled.body).toEqual(service.instance)
    expect(service.last()).toMatchObject({ method: 'setChannelEnabled', input: { id: 'bot-a', enabled: true } })

    const disabled = await call('POST', '/disable', ADMIN_CTX, { id: 'bot-a' })
    expect(disabled.status).toBe(200)
    expect(service.last()).toMatchObject({ method: 'setChannelEnabled', input: { id: 'bot-a', enabled: false } })
  })

  it('binds and unbinds for an admin, and reports a missing binding', async () => {
    const bind = await call('POST', '/bind', ADMIN_CTX, { channelId: 'bot-a', platformId: '99', subjectId: 'did:key:zA' })
    expect(bind.status).toBe(200)
    expect(service.last()).toMatchObject({
      method: 'bind',
      input: { channelId: 'bot-a', platformId: '99', subjectId: 'did:key:zA' },
    })

    const unbind = await call('POST', '/unbind', ADMIN_CTX, { channelId: 'bot-a', platformId: '99' })
    expect(unbind.status).toBe(200)
    expect(unbind.body).toEqual({ ok: true })
    expect(service.last()).toMatchObject({ method: 'unbind', input: { channelId: 'bot-a', platformId: '99' } })

    service.unboundResult = false
    const missing = await call('POST', '/unbind', ADMIN_CTX, { channelId: 'bot-a', platformId: '404' })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('no-such-binding')
    service.unboundResult = true
  })

  it('starts, polls and stops a quick-setup flow', async () => {
    const started = await call('POST', '/provision/start', ADMIN_CTX, { channelType: 'telegram' })
    expect(started.status).toBe(200)
    expect(started.body).toEqual({ state: 'waiting', flowId: 'prov-1', qrUrl: 'https://qr.example/scan' })
    expect(service.last()).toMatchObject({ method: 'startProvision', input: { channelType: 'telegram' } })

    const polled = await call('GET', '/provision/poll?flowId=prov-1', ADMIN_CTX)
    expect(polled.status).toBe(200)
    expect(service.last()).toMatchObject({ method: 'pollProvision', input: 'prov-1' })

    const stopped = await call('POST', '/provision/stop', ADMIN_CTX, { flowId: 'prov-1' })
    expect(stopped.status).toBe(200)
    expect(stopped.body).toEqual({ ok: true })
    expect(service.last()).toMatchObject({ method: 'stopProvision', input: 'prov-1' })
  })

  it('lists expert instances for the channel form routing dropdown', async () => {
    const response = await call('GET', '/experts', ADMIN_CTX)
    expect(response.status).toBe(200)
    expect(response.body).toEqual([{ id: 'ops', name: 'Ops', agentPresetId: 'expert-ops' }])
    expect(service.last()).toMatchObject({ method: 'listExpertRoutes' })
  })

  it('answers /users without a channelId with 404 no-such-channel, never forwarding it', async () => {
    const before = service.calls.length
    const response = await call('GET', '/users', ADMIN_CTX)
    expect(response.status).toBe(404)
    expect(response.body.error).toBe('no-such-channel')
    expect(service.calls.length).toBe(before)
  })

  it('serves the bindable user list of one instance', async () => {
    const response = await call('GET', '/users?channelId=bot-a', ADMIN_CTX)
    expect(response.status).toBe(200)
    expect(response.body).toEqual(service.bindableUsers)
    expect(service.last()).toMatchObject({ method: 'listBindableUsers', input: 'bot-a' })
  })

  it('serves the form schema and probes saved and draft configs', async () => {
    const schema = await call('GET', '/schema', OPERATOR_CTX)
    expect(schema.status).toBe(200)
    expect(schema.body).toEqual(service.schemasResult)
    expect(service.last().method).toBe('schemas')
    expect(service.last().actor).toBeUndefined()

    const test = await call('POST', '/test', ADMIN_CTX, { id: 'bot-a' })
    expect(test.status).toBe(200)
    expect(test.body).toEqual({ ok: true, identity: { id: 42, username: 'tentacle_test_bot' } })
    expect(service.last()).toMatchObject({ method: 'testChannel', input: 'bot-a' })

    const probe = await call('POST', '/probe', ADMIN_CTX, { channelType: 'telegram', token: 'secret' })
    expect(probe.status).toBe(200)
    expect(probe.body).toEqual({ ok: false, error: 'not reachable' })
    expect(service.last()).toMatchObject({ method: 'probeChannel', input: { channelType: 'telegram', token: 'secret' } })
  })

  it('maps every domain error onto its stable status code', async () => {
    const channelCases: ReadonlyArray<readonly [ChannelErrorCode, number]> = [
      ['name-taken', 409],
      ['no-such-channel', 404],
      ['invalid-config', 400],
      ['forbidden-tenant', 403],
      ['credentials-unavailable', 409],
    ]
    for (const [code, status] of channelCases) {
      service.failures.createChannel = new ChannelError(code, code)
      const response = await call('POST', '/create', ADMIN_CTX, { channelType: 'telegram', name: 'x' })
      expect(response.status, code).toBe(status)
      expect(response.body.error).toBe(code)
    }
    delete service.failures.createChannel

    const bindingCases: ReadonlyArray<readonly [BindingsErrorCode, number]> = [
      ['unknown-user', 404],
      ['already-bound', 409],
      ['channel-tenant-mismatch', 400],
    ]
    for (const [code, status] of bindingCases) {
      service.failures.bind = new BindingsError(code, code)
      const response = await call('POST', '/bind', ADMIN_CTX, { channelId: 'bot-a', platformId: '1', subjectId: 'did:key:zA' })
      expect(response.status, code).toBe(status)
      expect(response.body.error).toBe(code)
    }
    delete service.failures.bind

    service.failures.createChannel = new TypeError('kaboom')
    const internal = await call('POST', '/create', ADMIN_CTX, { channelType: 'telegram', name: 'x' })
    expect(internal.status).toBe(500)
    expect(internal.body.error).toBe('internal-error')
    delete service.failures.createChannel
  })

  it('answers unknown actions with 404 rather than forwarding', async () => {
    const before = service.calls.length
    const response = await call('GET', '/nope', ADMIN_CTX)
    expect(response.status).toBe(404)
    expect(response.body.error).toBe('no such admin action')
    // A wrong method on a real path is equally unknown.
    expect((await call('POST', '/', ADMIN_CTX)).status).toBe(404)
    expect((await call('GET', '/create', ADMIN_CTX)).status).toBe(404)
    expect(service.calls.length).toBe(before)
  })
})
