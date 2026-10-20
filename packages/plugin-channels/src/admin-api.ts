/**
 * Admin REST API for channels — the same declarative route table as the
 * tenancy/persona admin surfaces (design 05 §2.2, 07 §4):
 *
 *   GET  /tentacle/api/admin/channels             instances + runtime + bindings + links
 *   GET  /tentacle/api/admin/channels/schema      per-type form schema (client renders it)
 *   GET  /tentacle/api/admin/channels/users       bindable users of one instance
 *   POST /tentacle/api/admin/channels/create      create an instance            (201)
 *   POST /tentacle/api/admin/channels/update      update an instance
 *   POST /tentacle/api/admin/channels/enable      start an instance
 *   POST /tentacle/api/admin/channels/disable     stop an instance, keep config
 *   POST /tentacle/api/admin/channels/remove      delete an instance
 *   POST /tentacle/api/admin/channels/test        probe one instance's SAVED token
 *   POST /tentacle/api/admin/channels/probe       probe a DRAFT config (nothing persisted)
 *   POST /tentacle/api/admin/channels/bind        bind a platform identity
 *   POST /tentacle/api/admin/channels/unbind      remove a binding
 *
 * The route is non-public, so the gateway has already authenticated the caller
 * (anonymous → 401 before we ever run); this handler authorizes on the
 * `channels` permission key and derives the tenant actor from the authenticated
 * identity, which is what keeps an instance inside its tenant (design 07 §4).
 * Errors are a fixed vocabulary — no stack traces, no internals (design 02 §6).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Identity } from '@tentacle/identity'
import type { GatewayRoute } from '@tentacle/gateway'
import { BindingsError } from './bindings.js'
import { ChannelError, type ChannelTypeSchema } from './instances.js'
import { ProvisionError } from './provision.js'
import type { ChannelActor } from './registry.js'
import type { ChannelInstanceView, ChannelOverview, ProbeResult } from './service.js'

export const CHANNELS_ADMIN_PREFIX = '/tentacle/api/admin/channels'

/** The narrow service face the routes consume (satisfied by TentacleChannels). */
export interface ChannelAdminApi {
  overview(actor: ChannelActor): Promise<ChannelOverview>
  schemas(): readonly ChannelTypeSchema[]
  createChannel(input: Record<string, unknown>, actor: ChannelActor): Promise<ChannelInstanceView>
  updateChannel(input: Record<string, unknown> & { id: string }, actor: ChannelActor): Promise<ChannelInstanceView>
  setChannelEnabled(id: string, enabled: boolean, actor: ChannelActor): Promise<ChannelInstanceView>
  removeChannel(id: string, actor: ChannelActor): Promise<void>
  testChannel(id: string, actor: ChannelActor): Promise<ProbeResult>
  probeChannel(input: Record<string, unknown>): Promise<ProbeResult>
  listBindableUsers(channelId: string, actor: ChannelActor): readonly { readonly subjectId: string; readonly username: string }[]
  bind(input: { channelId: string; platformId: string; subjectId: string }, actor: ChannelActor): Promise<unknown>
  unbind(input: { channelId: string; platformId: string }, actor: ChannelActor): Promise<boolean>
  /** Expert instances available for channel routing (design 09). */
  listExpertRoutes(): readonly { readonly id: string; readonly name: string; readonly agentPresetId: string }[]
  /** Team instances available for channel routing (design 10 §7). */
  listTeamRoutes(): readonly { readonly id: string; readonly name: string; readonly agentPresetId: string }[]
  /** Quick-setup (QR) provisioning (design 08). `instanceId` repairs in place. */
  startProvision(input: { channelType: unknown; instanceId?: unknown; target?: unknown }, actor: ChannelActor): Promise<unknown>
  pollProvision(flowId: string, actor: ChannelActor): Promise<unknown>
  stopProvision(flowId: string, actor: ChannelActor): Promise<void>
}

/** Stable public error codes — the domain vocabulary maps 1:1, nothing leaks. */
export function errorStatus(error: unknown): { status: number; code: string } {
  if (error instanceof ChannelError) {
    const status = {
      'name-taken': 409,
      'no-such-channel': 404,
      'invalid-name': 400,
      'invalid-channel-type': 400,
      'invalid-config': 400,
      'invalid-credential-ref': 400,
      'invalid-tenant': 400,
      'credentials-unavailable': 409,
      'forbidden-tenant': 403,
    }[error.code]
    return { status, code: error.code }
  }
  if (error instanceof ProvisionError) {
    const status = { 'no-provision-flow': 400, 'no-such-flow': 404 }[error.code]
    return { status, code: error.code }
  }
  if (error instanceof BindingsError) {
    const status = {
      'unknown-user': 404,
      'already-bound': 409,
      'invalid-binding': 400,
      'no-such-binding': 404,
      'channel-tenant-mismatch': 400,
    }[error.code]
    return { status, code: error.code }
  }
  return { status: 500, code: 'internal-error' }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) as Record<string, unknown> : {}
}

/** The acting principal: the authenticated identity's tenant plus admin bit. */
function actorOf(identity: Identity | undefined): ChannelActor | undefined {
  if (identity === undefined) return undefined
  return { tenant: identity.tenant, isAdmin: identity.roles?.includes('admin') === true }
}

function requiredId(body: Record<string, unknown>): string {
  const id = body['id']
  if (typeof id !== 'string' || id === '') throw new ChannelError('no-such-channel', 'id is required')
  return id
}

interface AdminAction {
  method: string
  path: string
  /** Success status; defaults to 200. */
  status?: number
  run(api: ChannelAdminApi, body: Record<string, unknown>, query: URLSearchParams, actor: ChannelActor): Promise<unknown>
}

const ADMIN_ACTIONS: AdminAction[] = [
  {
    method: 'GET', path: '/',
    run: async (channels, _body, _query, actor) => await channels.overview(actor),
  },
  {
    method: 'GET', path: '/schema',
    run: async (channels) => channels.schemas(),
  },
  {
    method: 'GET', path: '/users',
    run: async (channels, _body, query, actor) => {
      const channelId = query.get('channelId')
      if (channelId === null || channelId === '') throw new ChannelError('no-such-channel', 'channelId is required')
      return channels.listBindableUsers(channelId, actor)
    },
  },
  {
    method: 'POST', path: '/create', status: 201,
    run: async (channels, body, _query, actor) => await channels.createChannel(body, actor),
  },
  {
    method: 'POST', path: '/update',
    run: async (channels, body, _query, actor) => await channels.updateChannel({ ...body, id: requiredId(body) }, actor),
  },
  {
    method: 'POST', path: '/enable',
    run: async (channels, body, _query, actor) => await channels.setChannelEnabled(requiredId(body), true, actor),
  },
  {
    method: 'POST', path: '/disable',
    run: async (channels, body, _query, actor) => await channels.setChannelEnabled(requiredId(body), false, actor),
  },
  {
    method: 'POST', path: '/remove',
    run: async (channels, body, _query, actor) => {
      await channels.removeChannel(requiredId(body), actor)
      return { ok: true }
    },
  },
  {
    method: 'POST', path: '/test',
    run: async (channels, body, _query, actor) => await channels.testChannel(requiredId(body), actor),
  },
  {
    method: 'POST', path: '/probe',
    run: async (channels, body) => await channels.probeChannel(body),
  },
  {
    method: 'GET', path: '/experts',
    run: async (channels) => channels.listExpertRoutes(),
  },
  {
    method: 'GET', path: '/teams',
    run: async (channels) => channels.listTeamRoutes(),
  },
  {
    method: 'POST', path: '/provision/start',
    run: async (channels, body, _query, actor) => await channels.startProvision({
      channelType: body['channelType'],
      ...(body['instanceId'] === undefined ? {} : { instanceId: body['instanceId'] }),
      ...(body['target'] === undefined ? {} : { target: body['target'] }),
    }, actor),
  },
  {
    method: 'GET', path: '/provision/poll',
    run: async (channels, _body, query, actor) => {
      const flowId = query.get('flowId')
      if (flowId === null || flowId === '') throw new ProvisionError('no-such-flow', 'flowId is required')
      return await channels.pollProvision(flowId, actor)
    },
  },
  {
    method: 'POST', path: '/provision/stop',
    run: async (channels, body, _query, actor) => {
      await channels.stopProvision(String(body['flowId'] ?? ''), actor)
      return { ok: true }
    },
  },
  {
    method: 'POST', path: '/bind',
    run: async (channels, body, _query, actor) => await channels.bind({
      channelId: String(body['channelId'] ?? ''),
      platformId: String(body['platformId'] ?? ''),
      subjectId: String(body['subjectId'] ?? ''),
    }, actor),
  },
  {
    method: 'POST', path: '/unbind',
    run: async (channels, body, _query, actor) => {
      const removed = await channels.unbind({
        channelId: String(body['channelId'] ?? ''),
        platformId: String(body['platformId'] ?? ''),
      }, actor)
      if (!removed) throw new BindingsError('no-such-binding', 'that identity is not bound')
      return { ok: true }
    },
  },
]

/** Build the gateway route registration for channels. */
export function createChannelRoutes(channels: ChannelAdminApi): GatewayRoute[] {
  return [
    {
      prefix: CHANNELS_ADMIN_PREFIX,
      handler: async (req, res, context) => {
        // Admin bypass, else the `channels` permission key from
        // plugin-tenancy's catalog — the same rule every admin console applies.
        const identity = context.identity
        const allowed = identity !== undefined && (
          identity.roles?.includes('admin') === true
          || identity.permissions?.includes('channels') === true
        )
        const actor = actorOf(identity)
        if (!allowed || actor === undefined) {
          writeJson(res, 403, { error: 'permission required: channels' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.slice(CHANNELS_ADMIN_PREFIX.length) || '/'
        const action = ADMIN_ACTIONS.find((candidate) => candidate.method === req.method && candidate.path === path)
        if (action === undefined) {
          writeJson(res, 404, { error: 'no such admin action' })
          return
        }
        try {
          const body = req.method === 'GET' ? {} : await readJson(req)
          writeJson(res, action.status ?? 200, await action.run(channels, body, url.searchParams, actor))
        } catch (error) {
          const { status, code } = errorStatus(error)
          writeJson(res, status, { error: code })
        }
      },
    },
  ]
}
