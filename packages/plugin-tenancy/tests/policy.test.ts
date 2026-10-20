import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DefaultPolicy } from '@tentacle/gateway'
import { UserDirectory } from '../src/directory.js'
import { MemoryRepo } from '../src/repo.js'
import { isWithin, TenancyPolicy } from '../src/policy.js'
import type { RouteFact } from '@tentacle/gateway'

async function dirWithUser(rootPolicy?: string) {
  const dir = new UserDirectory({ repo: new MemoryRepo() })
  await dir.boot()
  const admin = await dir.createUser({ username: 'root', password: 'pw', role: 'admin' })
  const user = await dir.createUser({ username: 'alice', password: 'pw' })
  if (rootPolicy) await dir.setPolicy(user.subjectId, 'workspace_root_dir', rootPolicy)
  return { dir, admin, user }
}

const createFact = (cwd: string): RouteFact => ({
  channel: 'rpc',
  method: 'POST',
  path: '/api/session.create',
  rpcEndpoint: 'session.create',
  body: { args: { cwd } },
})

describe('TenancyPolicy workspace fence', () => {
  it('fences session.create cwd to the user root (realpath)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-fence-'))
    const { dir, user } = await dirWithUser(root)
    const policy = new TenancyPolicy(dir)
    const identity = await dir.authenticate('alice', 'pw')

    expect((await policy.resolve(identity, createFact(join(root, 'project')))).allow).toBe(true)
    expect((await policy.resolve(identity, createFact('/etc'))).allow).toBe(false)
    expect((await policy.resolve(identity, createFact(join(root, '..', 'escape')))).allow).toBe(false)
  })

  it('symlink escapes fail closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-fence-'))
    const link = join(root, 'trap')
    symlinkSync('/etc', link)
    const { dir, user } = await dirWithUser(root)
    const policy = new TenancyPolicy(dir)
    const identity = await dir.authenticate('alice', 'pw')
    expect((await policy.resolve(identity, createFact(link))).allow).toBe(false)
  })

  it('admins and unfenced users are unaffected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-fence-'))
    const { dir } = await dirWithUser(root)
    const policy = new TenancyPolicy(dir)

    const adminIdentity = await dir.authenticate('root', 'pw')
    expect((await policy.resolve(adminIdentity, createFact('/anywhere'))).allow).toBe(true)

    const { dir: dir2 } = await dirWithUser() // no policy for this user
    const policy2 = new TenancyPolicy(dir2)
    const bob = await dir2.authenticate('alice', 'pw')
    expect((await policy2.resolve(bob, createFact('/anywhere'))).allow).toBe(true)
  })

  it('still denies the privileged surface (wraps DefaultPolicy)', async () => {
    const { dir } = await dirWithUser()
    const policy = new TenancyPolicy(dir)
    const alice = await dir.authenticate('alice', 'pw')
    const fact: RouteFact = { channel: 'rpc', method: 'POST', path: '/api/commands/execute', rpcEndpoint: 'commands/execute' }
    expect((await policy.resolve(alice, fact)).allow).toBe(false)
    expect((await policy.resolve(undefined, fact)).allow).toBe(false)
  })
})

describe('isWithin', () => {
  it('accepts the root itself and children, rejects siblings', () => {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-iswithin-'))
    expect(isWithin(root, root)).toBe(true)
    expect(isWithin(join(root, 'child'), root)).toBe(true)
    expect(isWithin(`${root}-sibling`, root)).toBe(false)
    expect(isWithin('/', root)).toBe(false)
  })
})
