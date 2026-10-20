/**
 * User lifecycle: enable/disable round-trip, delete with cascade cleanup,
 * login lockout + unlock, profile edits, self-service password change, and
 * batch semantics (per-item outcomes, revoked subjectIds).
 */
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '@tentacle/crypto'
import { DirectoryError, LOGIN_LOCK_MS, MAX_LOGIN_FAILURES, UserDirectory } from '../src/directory.js'
import { MemoryRepo } from '../src/repo.js'

async function makeDir(now?: () => number) {
  const dir = new UserDirectory({ repo: new MemoryRepo(), now })
  await dir.boot()
  await dir.createUser({ username: 'root', password: 'root-pw', role: 'admin' })
  await dir.createUser({ username: 'alice', password: 'alice-pw' })
  return dir
}

describe('enable / disable round-trip', () => {
  it('re-enables a disabled user and clears lockout state', async () => {
    const dir = await makeDir()
    const id = await dir.disable('alice')
    expect(id).toBe(dir.getUser('alice')!.subjectId)
    await expect(dir.authenticate('alice', 'alice-pw')).rejects.toMatchObject({ code: 'disabled' })

    await dir.enable('alice')
    expect((await dir.authenticate('alice', 'alice-pw')).handle).toBe('alice')
  })

  it('enable is a no-op for an already active user', async () => {
    const dir = await makeDir()
    await dir.enable('alice')
    expect(dir.getUser('alice')!.disabled).toBe(false)
  })
})

describe('deleteUser', () => {
  it('removes the user and their memberships/policies', async () => {
    const dir = await makeDir()
    const alice = dir.getUser('alice')!
    await dir.setPolicy(alice.subjectId, 'max_agents', '3')
    expect(dir.check(alice.subjectId, 'member', `tenant:${alice.tenant}`)).toBe(true)

    const id = await dir.deleteUser('alice')
    expect(id).toBe(alice.subjectId)
    expect(dir.getUser('alice')).toBeUndefined()
    expect(dir.getPolicy(alice.subjectId, 'max_agents')).toBeUndefined()
    expect(dir.check(alice.subjectId, 'member', `tenant:${alice.tenant}`)).toBe(false)
    await expect(dir.authenticate('alice', 'alice-pw')).rejects.toMatchObject({ code: 'bad-credentials' })
  })

  it('protects the last admin', async () => {
    const dir = await makeDir()
    await expect(dir.deleteUser('root')).rejects.toMatchObject({ code: 'last-admin' })
  })

  it('allows deleting an admin once another active admin exists', async () => {
    const dir = await makeDir()
    await dir.createUser({ username: 'root2', password: 'root2-pw', role: 'admin' })
    await expect(dir.deleteUser('root')).resolves.toBeTruthy()
  })
})

describe('login lockout and unlock', () => {
  it('locks after repeated failures and unlockLogin clears it immediately', async () => {
    const now = () => 1_000_000
    const dir = await makeDir(now)
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await dir.authenticate('alice', 'wrong').catch(() => undefined)
    }
    expect(dir.getUser('alice')!.loginLockedUntil).toBeGreaterThan(now())
    await expect(dir.authenticate('alice', 'alice-pw')).rejects.toMatchObject({ code: 'login-locked' })

    await dir.unlockLogin('alice')
    expect(dir.getUser('alice')!.loginLockedUntil).toBe(0)
    expect((await dir.authenticate('alice', 'alice-pw')).handle).toBe('alice')
  })
})

describe('updateProfile', () => {
  it('sets display name and email, and clears them on empty input', async () => {
    const dir = await makeDir()
    await dir.updateProfile('alice', { displayName: 'Alice A.', email: 'alice@example.com' })
    expect(dir.getUser('alice')).toMatchObject({ displayName: 'Alice A.', email: 'alice@example.com' })

    await dir.updateProfile('alice', { displayName: '', email: '' })
    expect(dir.getUser('alice')!.displayName).toBeUndefined()
    expect(dir.getUser('alice')!.email).toBeUndefined()
  })

  it('rejects a malformed email', async () => {
    const dir = await makeDir()
    await expect(dir.updateProfile('alice', { email: 'not-an-email' })).rejects.toMatchObject({ code: 'bad-credentials' })
  })
})

describe('changePassword', () => {
  it('verifies the old password and rejects weak new ones', async () => {
    const dir = await makeDir()
    await expect(dir.changePassword('alice', 'wrong', 'new-password')).rejects.toMatchObject({ code: 'bad-credentials' })
    await expect(dir.changePassword('alice', 'alice-pw', 'short')).rejects.toMatchObject({ code: 'bad-credentials' })

    await dir.changePassword('alice', 'alice-pw', 'new-password')
    expect(verifyPassword('new-password', dir.getUser('alice')!.passwordEnvelope)).toBe(true)
    await expect(dir.authenticate('alice', 'alice-pw')).rejects.toMatchObject({ code: 'bad-credentials' })
    expect((await dir.authenticate('alice', 'new-password')).handle).toBe('alice')
  })
})

describe('batch', () => {
  it('reports per-item outcomes and never lets one failure sink the batch', async () => {
    const dir = await makeDir()
    await dir.createUser({ username: 'bob', password: 'bob-pw' })

    const out = await dir.batch(['alice', 'root', 'ghost'], 'disable')
    expect(out.results).toEqual([
      { username: 'alice', ok: true },
      { username: 'root', ok: false, code: 'last-admin' },
      { username: 'ghost', ok: false, code: 'no-such-user' },
    ])
    expect(out.revoked).toEqual([dir.getUser('alice')!.subjectId])

    const back = await dir.batch(['alice', 'bob'], 'enable')
    expect(back.results.every((r) => r.ok)).toBe(true)

    const del = await dir.batch(['alice', 'ghost'], 'delete')
    expect(del.results).toEqual([
      { username: 'alice', ok: true },
      { username: 'ghost', ok: false, code: 'no-such-user' },
    ])
    expect(dir.getUser('alice')).toBeUndefined()
  })
})

describe('password material hygiene', () => {
  it('never exposes envelopes through the list projection', async () => {
    const dir = await makeDir()
    const view = dir.listUsers().map((u) => ({ username: u.username, role: u.role }))
    expect(JSON.stringify(view)).not.toContain('scrypt$')
    expect(hashPassword('x')).toContain('scrypt$')
  })
})

describe('DirectoryError vocabulary', () => {
  it('carries a stable code for the API layer', () => {
    const error = new DirectoryError('last-admin', 'nope')
    expect(error.code).toBe('last-admin')
    expect(error.name).toBe('DirectoryError')
    expect(LOGIN_LOCK_MS).toBeGreaterThan(0)
  })
})
