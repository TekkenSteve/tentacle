/**
 * Admin API authorization matrix over a real gateway + tenancy composition.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalProvider } from '@tentacle/identity'
import { hashPassword } from '@tentacle/crypto'
import * as gatewayPlugin from '@tentacle/gateway'
import * as tenancyPlugin from '../src/index.js'
import type { TentacleGateway } from '@tentacle/gateway'

const ADMIN_PW = 'admin-pw'
const ALICE_PW = 'alice-pw'

describe('admin API', () => {
  let upstream: http.Server
  let port: number
  let fibers: { dispose(): Promise<void> }[] = []

  const call = async (path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: {
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: 'manual',
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined }
  }

  const loginCookie = async (username: string, password: string): Promise<string> => {
    const res = await fetch(`http://127.0.0.1:${port}/tentacle/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    expect(res.status).toBe(200)
    return res.headers.get('set-cookie')!.split(';', 1)[0]!
  }

  let adminCookie: string

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('token')) {
        res.writeHead(302, { 'set-cookie': 'dsh-auth-t=up; Path=/', location: './' })
        res.end()
        return
      }
      res.writeHead(200).end('ok')
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))

    const app = new Context()
    app.reflect.provide('webServer', { port: (upstream.address() as AddressInfo).port })
    app.reflect.provide('connection', { authenticatedUrl: (b: string) => `${b}/?token=t` })
    const identity = new LocalProvider(mkdtempSync(join(tmpdir(), 'tentacle-adm-i-')))
    await identity.boot()
    app.reflect.provide('tentacleIdentity', identity)

    fibers = [
      app.plugin(gatewayPlugin, { listen: '127.0.0.1:0', mode: 'required' }),
      app.plugin(tenancyPlugin, {
        stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-adm-t-')),
        bootstrapAdmin: { username: 'admin', passwordEnvelope: hashPassword(ADMIN_PW) },
      }),
    ]
    await new Promise((r) => setTimeout(r, 300))
    const gw = app.tentacleGateway as TentacleGateway
    port = ((gw as never as { server: http.Server }).server.address() as AddressInfo).port

    adminCookie = await loginCookie('admin', ADMIN_PW)
  })

  afterAll(async () => {
    await Promise.all(fibers.map((f) => f.dispose()))
    upstream.closeAllConnections()
    await new Promise((r) => upstream.close(() => r()))
  })

  it('rejects anonymous and non-admin callers', async () => {
    expect((await call('/tentacle/api/admin/users')).status).toBe(401)
    // create alice first (as admin), then prove she is forbidden
    expect((await call('/tentacle/api/admin/users', { cookie: adminCookie, body: { username: 'alice', password: ALICE_PW } })).status).toBe(200)
    const aliceCookie = await loginCookie('alice', ALICE_PW)
    const res = await call('/tentacle/api/admin/users', { cookie: aliceCookie })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('permission required: users')
  })

  it('admin creates users, lists them without password material', async () => {
    const list = await call('/tentacle/api/admin/users', { cookie: adminCookie })
    expect(list.status).toBe(200)
    const alice = list.body.find((u: any) => u.username === 'alice')
    expect(alice.subjectId).toMatch(/^did:key:z/)
    expect(JSON.stringify(list.body)).not.toContain('scrypt$')
  })

  it('invite → public signup → login → disable → revoked', async () => {
    const invite = await call('/tentacle/api/admin/invites', { cookie: adminCookie, body: { role: 'user' } })
    expect(invite.status).toBe(200)
    expect(invite.body.code).toBeTruthy()

    // public signup needs no cookie at all
    const signup = await call('/tentacle/api/signup', { body: { code: invite.body.code, username: 'bob', password: 'bob-pw' } })
    expect(signup.status).toBe(201)
    expect((await call('/tentacle/api/signup', { body: { code: invite.body.code, username: 'bob2', password: 'x' } })).status).toBe(410)

    const bobCookie = await loginCookie('bob', 'bob-pw')
    expect((await call('/tentacle/api/whoami', { cookie: bobCookie })).body.identity.handle).toBe('bob')

    const disable = await call('/tentacle/api/admin/users/disable', { cookie: adminCookie, body: { username: 'bob' } })
    expect(disable.status).toBe(200)
    // bob's live session is revoked immediately
    expect((await call('/tentacle/api/whoami', { cookie: bobCookie })).body.authenticated).toBe(false)
    expect((await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: bobCookie } })).status).toBe(403)
  })

  it('lists live sessions and per-user policies', async () => {
    // the admin's own session is visible in the snapshot
    const sessions = await call('/tentacle/api/admin/sessions', { cookie: adminCookie })
    expect(sessions.status).toBe(200)
    expect(sessions.body.some((s: any) => s.handle === 'admin' && s.roles.includes('admin'))).toBe(true)
    expect(JSON.stringify(sessions.body)).not.toContain('token')

    // policies round-trip through the GET endpoint
    const users = await call('/tentacle/api/admin/users', { cookie: adminCookie })
    const alice = users.body.find((u: any) => u.username === 'alice')
    await call('/tentacle/api/admin/policies', { cookie: adminCookie, body: { subjectId: alice.subjectId, name: 'max_agents', value: '3' } })
    const list = await call(`/tentacle/api/admin/policies?subjectId=${encodeURIComponent(alice.subjectId)}`, { cookie: adminCookie })
    expect(list.status).toBe(200)
    expect(list.body.find((p: any) => p.name === 'max_agents')?.value).toBe('3')
  })

  it('serves the admin console page to admins only', async () => {
    // anonymous
    let res = await fetch(`http://127.0.0.1:${port}/tentacle/admin`)
    expect(res.status).toBe(401)
    // admin gets the page
    res = await fetch(`http://127.0.0.1:${port}/tentacle/admin`, { headers: { cookie: adminCookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Tentacle Admin')
    // non-admin user is refused
    const aliceCookie = await loginCookie('alice', ALICE_PW)
    res = await fetch(`http://127.0.0.1:${port}/tentacle/admin`, { headers: { cookie: aliceCookie } })
    expect(res.status).toBe(403)
  })

  it('policy endpoints validate input', async () => {
    const users = await call('/tentacle/api/admin/users', { cookie: adminCookie })
    const alice = users.body.find((u: any) => u.username === 'alice')
    const ok = await call('/tentacle/api/admin/policies', { cookie: adminCookie, body: { subjectId: alice.subjectId, name: 'max_agents', value: '3' } })
    expect(ok.status).toBe(200)
    const bad = await call('/tentacle/api/admin/policies', { cookie: adminCookie, body: { subjectId: alice.subjectId, name: 'nonsense', value: '1' } })
    expect(bad.status).toBe(400)
  })

  it('user lifecycle endpoints: enable, unlock, profile, batch, self password change', async () => {
    // create a disposable user, lock them out via failed logins through the API
    expect((await call('/tentacle/api/admin/users', { cookie: adminCookie, body: { username: 'dave', password: 'dave-pw' } })).status).toBe(200)
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${port}/tentacle/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'dave', password: 'wrong' }),
      })
    }
    const lockedView = await call('/tentacle/api/admin/users', { cookie: adminCookie })
    const dave = lockedView.body.find((u: any) => u.username === 'dave')
    expect(dave.loginLockedUntil).toBeGreaterThan(Date.now())
    expect((await call('/tentacle/api/admin/users/unlock-login', { cookie: adminCookie, body: { username: 'dave' } })).status).toBe(200)

    // profile edit shows up in the list projection
    expect((await call('/tentacle/api/admin/users/update-profile', {
      cookie: adminCookie, body: { username: 'dave', displayName: 'Dave D.', email: 'dave@example.com' },
    })).status).toBe(200)
    const after = await call('/tentacle/api/admin/users', { cookie: adminCookie })
    expect(after.body.find((u: any) => u.username === 'dave')).toMatchObject({ displayName: 'Dave D.', email: 'dave@example.com' })

    // self-service password change requires the old password
    const daveCookie = await loginCookie('dave', 'dave-pw')
    expect((await call('/tentacle/api/me/change-password', { cookie: daveCookie, body: { oldPassword: 'nope', newPassword: 'brand-new-pw' } })).status).toBe(400)
    expect((await call('/tentacle/api/me/change-password', { cookie: daveCookie, body: { oldPassword: 'dave-pw', newPassword: 'brand-new-pw' } })).status).toBe(200)
    await loginCookie('dave', 'brand-new-pw')

    // disable → enable round-trip
    expect((await call('/tentacle/api/admin/users/disable', { cookie: adminCookie, body: { username: 'dave' } })).status).toBe(200)
    expect((await call('/tentacle/api/admin/users/enable', { cookie: adminCookie, body: { username: 'dave' } })).status).toBe(200)

    // batch: one good row, one unknown row — per-item outcomes, batch survives
    const batch = await call('/tentacle/api/admin/users/batch', {
      cookie: adminCookie, body: { usernames: ['dave', 'ghost'], action: 'delete' },
    })
    expect(batch.status).toBe(200)
    expect(batch.body.results).toEqual([
      { username: 'dave', ok: true },
      { username: 'ghost', ok: false, code: 'no-such-user' },
    ])
    const gone = await call('/tentacle/api/admin/users', { cookie: adminCookie })
    expect(gone.body.some((u: any) => u.username === 'dave')).toBe(false)

    // unknown batch action is rejected
    expect((await call('/tentacle/api/admin/users/batch', { cookie: adminCookie, body: { usernames: [], action: 'nuke' } })).status).toBe(400)
  })

  it('role templates gate the admin surface by permission key', async () => {
    // catalog + builtin templates are visible to the admin
    const catalog = await call('/tentacle/api/admin/permissions', { cookie: adminCookie })
    expect(catalog.status).toBe(200)
    expect(catalog.body.map((p: any) => p.key)).toContain('users')

    const roles = await call('/tentacle/api/admin/roles', { cookie: adminCookie })
    expect(roles.body.map((r: any) => r.id).sort()).toEqual(['admin', 'user'])
    expect((await call('/tentacle/api/admin/roles', { cookie: adminCookie, body: { id: 'bad id', name: { zh: 'x', en: 'x' }, permissionKeys: [] } })).status).toBe(400)
    expect((await call('/tentacle/api/admin/roles', { cookie: adminCookie, body: { id: 'invite-only', name: { zh: '仅邀请', en: 'Invite only' }, permissionKeys: ['invites'] } })).status).toBe(200)
    // unknown permission key is refused
    expect((await call('/tentacle/api/admin/roles', { cookie: adminCookie, body: { id: 'nope', name: { zh: 'x', en: 'x' }, permissionKeys: ['ghost'] } })).status).toBe(400)

    // a user carrying only the invites key: invites work, user management does not
    await call('/tentacle/api/admin/users', { cookie: adminCookie, body: { username: 'ivy', password: 'ivy-pw', role: 'invite-only' } })
    const ivyCookie = await loginCookie('ivy', 'ivy-pw')
    const me = await call('/tentacle/api/me', { cookie: ivyCookie })
    expect(me.body.identity.roles).toEqual(['invite-only'])
    expect(me.body.identity.permissions).toEqual(['invites'])

    expect((await call('/tentacle/api/admin/invites', { cookie: ivyCookie, body: { role: 'user' } })).status).toBe(200)
    expect((await call('/tentacle/api/admin/users', { cookie: ivyCookie, body: { username: 'mallory', password: 'mallory-pw' } })).status).toBe(403)
    expect((await call('/tentacle/api/admin/roles', { cookie: ivyCookie })).status).toBe(403)
    // ...but the roster is readable (shared user pickers, no password material)
    const roster = await call('/tentacle/api/admin/users', { cookie: ivyCookie })
    expect(roster.status).toBe(200)
    expect(JSON.stringify(roster.body)).not.toContain('scrypt$')

    // assignment + protected builtins
    expect((await call('/tentacle/api/admin/roles/assign', { cookie: adminCookie, body: { username: 'ivy', roleId: 'user' } })).status).toBe(200)
    expect((await call('/tentacle/api/admin/roles/update', { cookie: adminCookie, body: { id: 'user', permissionKeys: ['users'] } })).status).toBe(409)
    expect((await call('/tentacle/api/admin/roles/delete', { cookie: adminCookie, body: { id: 'invite-only' } })).status).toBe(200)
  })

  it('GET /tentacle/api/me returns the caller identity and workspace fence', async () => {
    // anonymous: the gateway's non-public route fence rejects before the handler
    expect((await call('/tentacle/api/me')).status).toBe(401)

    const users = await call('/tentacle/api/admin/users', { cookie: adminCookie })
    const alice = users.body.find((u: any) => u.username === 'alice')
    await call('/tentacle/api/admin/policies', { cookie: adminCookie, body: { subjectId: alice.subjectId, name: 'workspace_root_dir', value: '/ws/alice' } })

    const aliceCookie = await loginCookie('alice', ALICE_PW)
    const me = await call('/tentacle/api/me', { cookie: aliceCookie })
    expect(me.status).toBe(200)
    expect(me.body.identity.handle).toBe('alice')
    expect(me.body.identity.roles).toEqual(['user'])
    expect(me.body.workspaceRootDir).toBe('/ws/alice')

    // admin without a fence: identity present, root undefined
    const adminMe = await call('/tentacle/api/me', { cookie: adminCookie })
    expect(adminMe.status).toBe(200)
    expect(adminMe.body.identity.roles).toEqual(['admin'])
    expect(adminMe.body.workspaceRootDir).toBeUndefined()
  })
})
