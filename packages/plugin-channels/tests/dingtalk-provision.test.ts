/**
 * DingTalk device-code provisioning tests. The fake registration service
 * records init/begin/poll independently, so request bodies and terminal status
 * mappings are checked against the protocol rather than the implementation's
 * own return values.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { tenantId } from '@tentacle/identity'
import { FakeDingTalkApi, FakeDingTalkRegistration } from './fake-dingtalk-api.js'
import { DingTalkAdapter } from '../src/adapter/dingtalk.js'
import { DingTalkProvisionFlow } from '../src/provision/dingtalk.js'
import type { ProvisionSession } from '../src/provision.js'

const NOW = 1_700_000_000_000
const DEVICE_CODE = 'device-secret'
const registrations: FakeDingTalkRegistration[] = []
const apiServers: FakeDingTalkApi[] = []
const adapters: DingTalkAdapter[] = []

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop().catch(() => undefined)
  for (const server of apiServers.splice(0)) await server.close()
  for (const server of registrations.splice(0)) await server.close()
})

function session(): ProvisionSession {
  return {
    flowId: 'prov-dingtalk',
    channelType: 'dingtalk' as ProvisionSession['channelType'],
    tenant: tenantId('local'),
    actor: { tenant: tenantId('local'), isAdmin: true },
    createdAt: NOW,
    expiresAt: 0,
    data: undefined,
  }
}

async function setup(options: ConstructorParameters<typeof FakeDingTalkRegistration>[0] = {}) {
  const server = new FakeDingTalkRegistration(options)
  registrations.push(server)
  await server.listen()
  const flow = new DingTalkProvisionFlow({ apiBaseUrl: server.baseUrl, now: () => NOW })
  const current = session()
  return { server, flow, current }
}

function expectNoDeviceCode(projection: unknown): void {
  expect(JSON.stringify(projection)).not.toContain(DEVICE_CODE)
  expect(projection).not.toHaveProperty('device_code')
  expect(projection).not.toHaveProperty('deviceCode')
}

describe('DingTalkProvisionFlow', () => {
  it('performs init→begin with exact bodies and keeps device_code only in session.data', async () => {
    const { server, flow, current } = await setup()
    server.pushPoll({ status: 'WAITING' })
    const started = await flow.start(current)

    expect(started).toEqual({
      qrUrl: 'https://open-dev.dingtalk.com/scan?code=public',
      userCode: 'ABCD-EFGH-IJKL',
      expiresAt: NOW + 600_000,
      pollAfterMs: 5000,
    })
    expect(server.callsTo('init').map((call) => call.body)).toEqual([{}])
    expect(server.callsTo('begin').map((call) => call.body)).toEqual([{ nonce: 'nonce-1' }])
    expect(current.data).toMatchObject({ deviceCode: DEVICE_CODE })
    expectNoDeviceCode(started)

    const waiting = await flow.poll(current)
    expect(waiting).toEqual({
      state: 'waiting',
      qrUrl: started.qrUrl,
      userCode: started.userCode,
    })
    expect(server.callsTo('poll').map((call) => call.body)).toEqual([{ device_code: DEVICE_CODE }])
    expectNoDeviceCode(waiting)
  })

  it('maps WAITING→FAIL to failed with fail_reason and consumes the device code', async () => {
    const { server, flow, current } = await setup()
    server.pushPoll({ status: 'WAITING' }, { status: 'FAIL', fail_reason: 'user refused authorization' })
    await flow.start(current)
    expect((await flow.poll(current)).state).toBe('waiting')
    const failed = await flow.poll(current)

    expect(failed).toEqual({ state: 'failed', error: 'user refused authorization' })
    expect(current.data).toMatchObject({ deviceCode: '' })
    expectNoDeviceCode(failed)
    expect(flow.stop).toBeUndefined()
  })

  it('maps WAITING→EXPIRED to expired without returning platform state', async () => {
    const { server, flow, current } = await setup()
    server.pushPoll({ status: 'WAITING' }, { status: 'EXPIRED' })
    await flow.start(current)
    expect((await flow.poll(current)).state).toBe('waiting')
    const expired = await flow.poll(current)

    expect(expired).toEqual({ state: 'expired' })
    expect(current.data).toMatchObject({ deviceCode: '' })
    expectNoDeviceCode(expired)
  })

  it('maps WAITING→SUCCESS to adapter-compatible credentials that can complete a real handshake', async () => {
    const { server, flow, current } = await setup()
    server.pushPoll(
      { status: 'WAITING' },
      { status: 'SUCCESS', client_id: 'ding-client', client_secret: 'ding-secret' },
    )
    await flow.start(current)
    expect((await flow.poll(current)).state).toBe('waiting')
    const success = await flow.poll(current)

    expect(success).toEqual({
      state: 'success',
      credentials: { clientId: 'ding-client', clientSecret: 'ding-secret' },
    })
    expect(current.data).toMatchObject({ deviceCode: '' })
    expectNoDeviceCode(success)
    if (success.state !== 'success') throw new Error('expected success')

    // Prove the provisioning output is directly usable by the adapter, rather
    // than merely similarly named: the scanned pair appears in connections/open.
    const api = new FakeDingTalkApi()
    apiServers.push(api)
    await api.listen()
    const adapter = new DingTalkAdapter({
      id: 'from-scan',
      apiBaseUrl: api.baseUrl,
      streamUrl: api.baseUrl,
      credentials: {
        clientId: success.credentials['clientId']!,
        clientSecret: success.credentials['clientSecret']!,
      },
    })
    adapters.push(adapter)
    await adapter.start()
    expect(api.callsTo('open')[0]!.body).toMatchObject({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    })
  })
})
