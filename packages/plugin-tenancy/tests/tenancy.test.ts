import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashPassword } from '@tentacle/crypto'
import { DirectoryError, UserDirectory, LOGIN_LOCK_MS, MAX_LOGIN_FAILURES } from '../src/directory.js'
import { JsonFileRepo, MemoryRepo } from '../src/repo.js'
import { subjectId } from '@tentacle/identity'

function memoryDir(extra?: Partial<ConstructorParameters<typeof UserDirectory>[0]>): UserDirectory {
  return new UserDirectory({ repo: new MemoryRepo(), ...extra })
}

describe('UserDirectory users', () => {
  it('creates users with did:key subjectIds and member tuples', async () => {
    const dir = memoryDir()
    await dir.boot()
    const user = await dir.createUser({ username: 'alice', password: 'pw' })
    expect(user.subjectId.startsWith('did:key:z')).toBe(true)
    expect(user.role).toBe('user')
    expect(dir.check(user.subjectId, 'member', `tenant:${user.tenant}`)).toBe(true)
  })

  it('rejects duplicates and invalid usernames', async () => {
    const dir = memoryDir()
    await dir.boot()
    await dir.createUser({ username: 'alice', password: 'pw' })
    await expect(dir.createUser({ username: 'alice', password: 'pw' })).rejects.toMatchObject({ code: 'duplicate-user' })
    await expect(dir.createUser({ username: '../evil', password: 'pw' })).rejects.toMatchObject({ code: 'bad-credentials' })
  })

  it('seeds the bootstrap admin only while empty', async () => {
    const repo = new MemoryRepo()
    const envelope = hashPassword('bootstrap-pw')
    const dir = new UserDirectory({ repo, bootstrapAdmin: { username: 'root', passwordEnvelope: envelope } })
    await dir.boot()
    expect(dir.getUser('root')?.role).toBe('admin')
    expect((await dir.authenticate('root', 'bootstrap-pw')).roles).toContain('admin')

    // Second boot with an existing user table must NOT reseed.
    const again = new UserDirectory({ repo, bootstrapAdmin: { username: 'evil', passwordEnvelope: envelope } })
    await again.boot()
    expect(again.getUser('evil')).toBeUndefined()
  })
})

describe('authentication and rate limiting', () => {
  it('locks out after repeated failures and recovers after lock expiry', async () => {
    let now = 1_000_000
    const dir = new UserDirectory({ repo: new MemoryRepo(), now: () => now })
    await dir.boot()
    await dir.createUser({ username: 'bob', password: 'right' })

    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await expect(dir.authenticate('bob', 'wrong')).rejects.toMatchObject({ code: 'bad-credentials' })
    }
    await expect(dir.authenticate('bob', 'right')).rejects.toMatchObject({ code: 'login-locked' })

    now += LOGIN_LOCK_MS + 1
    expect((await dir.authenticate('bob', 'right')).handle).toBe('bob')
  })

  it('rejects disabled and unknown users', async () => {
    const dir = memoryDir()
    await dir.boot()
    await dir.createUser({ username: 'carol', password: 'pw', role: 'admin' })
    await dir.createUser({ username: 'dave', password: 'pw' })
    const id = await dir.disable('dave')
    expect(id).toBe(dir.getUser('dave')!.subjectId)
    await expect(dir.authenticate('dave', 'pw')).rejects.toMatchObject({ code: 'disabled' })
    await expect(dir.authenticate('nobody', 'pw')).rejects.toMatchObject({ code: 'bad-credentials' })
  })

  it('protects the last admin', async () => {
    const dir = memoryDir()
    await dir.boot()
    await dir.createUser({ username: 'only-admin', password: 'pw', role: 'admin' })
    await expect(dir.disable('only-admin')).rejects.toMatchObject({ code: 'last-admin' })
  })

  it('fails closed with setup-required on an empty directory', async () => {
    const dir = memoryDir()
    await dir.boot()
    await expect(dir.authenticate('anyone', 'pw')).rejects.toMatchObject({ code: 'setup-required' })
  })
})

describe('invites', () => {
  it('redeems once and refuses replays/expiry', async () => {
    let now = 0
    const dir = new UserDirectory({ repo: new MemoryRepo(), now: () => now })
    await dir.boot()
    await dir.createUser({ username: 'admin1', password: 'pw', role: 'admin' })

    const { code } = await dir.createInvite('user', 1000)
    const user = await dir.redeemInvite(code, 'erin', 'pw')
    expect(user.username).toBe('erin')
    await expect(dir.redeemInvite(code, 'erin2', 'pw')).rejects.toMatchObject({ code: 'invalid-invite' })

    const expired = await dir.createInvite('user', 500)
    now += 501
    await expect(dir.redeemInvite(expired.code, 'frank', 'pw')).rejects.toMatchObject({ code: 'invalid-invite' })
  })
})

describe('policies and memberships', () => {
  it('sets, reads, and clears named resource policies', async () => {
    const dir = memoryDir()
    await dir.boot()
    const user = await dir.createUser({ username: 'gina', password: 'pw' })
    await dir.setPolicy(user.subjectId, 'max_agents', '3')
    expect(dir.getPolicy(user.subjectId, 'max_agents')).toBe('3')
    await dir.setPolicy(user.subjectId, 'max_agents', '5')
    expect(dir.getPolicy(user.subjectId, 'max_agents')).toBe('5')
    await dir.setPolicy(user.subjectId, 'max_agents', undefined)
    expect(dir.getPolicy(user.subjectId, 'max_agents')).toBeUndefined()
  })

  it('grants and revokes ReBAC tuples idempotently', async () => {
    const dir = memoryDir()
    await dir.boot()
    const user = await dir.createUser({ username: 'henry', password: 'pw' })
    await dir.grant(user.subjectId, 'editor', 'workspace:w1')
    await dir.grant(user.subjectId, 'editor', 'workspace:w1') // idempotent
    expect(dir.check(user.subjectId, 'editor', 'workspace:w1')).toBe(true)
    await dir.revokeMembership(user.subjectId, 'editor', 'workspace:w1')
    expect(dir.check(user.subjectId, 'editor', 'workspace:w1')).toBe(false)
  })
})

describe('JsonFileRepo', () => {
  it('persists and reloads with 0600 perms', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-tenancy-'))
    const dir = new UserDirectory({ repo: new JsonFileRepo(root) })
    await dir.boot()
    const user = await dir.createUser({ username: 'ivan', password: 'pw' })

    const reloaded = new UserDirectory({ repo: new JsonFileRepo(root) })
    await reloaded.boot()
    expect(reloaded.getUser('ivan')?.subjectId).toBe(user.subjectId)
    expect(statSync(join(root, 'directory.json')).mode & 0o777).toBe(0o600)

    // password envelope is stored, never the plaintext
    const raw = readFileSync(join(root, 'directory.json'), 'utf8')
    expect(raw).not.toContain('"pw"')
    expect(raw).toContain('scrypt$')
  })
})
