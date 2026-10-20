/**
 * Integration: tenancy's user directory plugged into the gateway's
 * authenticator seat, over a real upstream stub. Mirrors the e2e chain.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalProvider } from '@tentacle/identity'
import { hashPassword } from '@tentacle/gateway'
import * as gatewayPlugin from '@tentacle/gateway'
import * as tenancyPlugin from '../src/index.js'
import type { TentacleGateway } from '@tentacle/gateway'
import type { TentacleTenancy } from '../src/service.js'

const ADMIN_PW = 'integration-admin-pw'

describe('tenancy × gateway integration', () => {
  let upstream: http.Server
  let gatewayPort: number
  let fiber: { dispose(): Promise<void> }
  let tenancy: TentacleTenancy

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('token')) {
        res.writeHead(302, { 'set-cookie': 'dsh-auth-t=upstream; Path=/', location: './' })
        res.end()
        return
      }
      if (req.headers.cookie !== 'dsh-auth-t=upstream') {
        res.writeHead(401).end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const upPort = (upstream.address() as AddressInfo).port

    const app = new Context()
    app.reflect.provide('webServer', { port: upPort })
    app.reflect.provide('connection', { authenticatedUrl: (b: string) => `${b}/?token=t` })
    const identity = new LocalProvider(mkdtempSync(join(tmpdir(), 'tentacle-int-i-')))
    await identity.boot()
    app.reflect.provide('tentacleIdentity', identity)

    app.plugin(gatewayPlugin, { listen: '127.0.0.1:0', mode: 'required' })
    fiber = app.plugin(tenancyPlugin, {
      stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-int-t-')),
      bootstrapAdmin: { username: 'admin', passwordEnvelope: hashPassword(ADMIN_PW) },
    })
    await new Promise((r) => setTimeout(r, 300))

    const gw = app.tentacleGateway as TentacleGateway
    gatewayPort = ((gw as never as { server: http.Server }).server.address() as AddressInfo).port
    tenancy = app.tentacleTenancy as TentacleTenancy
  })

  afterAll(async () => {
    await fiber.dispose()
    upstream.closeAllConnections()
    await new Promise((r) => upstream.close(() => r()))
  })

  const login = async (username: string, password: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${gatewayPort}/tentacle/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })

  it('bootstraps the admin and authenticates through the directory', async () => {
    expect((await login('admin', 'wrong')).status).toBe(401)
    const res = await login('admin', ADMIN_PW)
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie')!.split(';', 1)[0]!

    const authed = await fetch(`http://127.0.0.1:${gatewayPort}/`, { headers: { cookie } })
    expect(authed.status).toBe(200)
  })

  it('disable cascades into immediate session revocation', async () => {
    await tenancy.directory.createUser({ username: 'alice', password: 'alice-pw' })
    const res = await login('alice', 'alice-pw')
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie')!.split(';', 1)[0]!
    expect((await fetch(`http://127.0.0.1:${gatewayPort}/`, { headers: { cookie } })).status).toBe(200)

    await tenancy.disableUser('alice')
    expect((await fetch(`http://127.0.0.1:${gatewayPort}/`, { headers: { cookie } })).status).toBe(403)
    expect((await login('alice', 'alice-pw')).status).toBe(401)
  })

  it('whoami reflects session state', async () => {
    const anon = await fetch(`http://127.0.0.1:${gatewayPort}/tentacle/api/whoami`)
    expect(await anon.json()).toEqual({ authenticated: false })
  })
})
