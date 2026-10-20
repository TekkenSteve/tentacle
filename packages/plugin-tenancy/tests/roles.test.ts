/**
 * Role templates and the permission catalog (design 05 §3): builtin seeding,
 * custom CRUD with validation, assignment rules, and the admin bypass.
 */
import { describe, expect, it } from 'vitest'
import { UserDirectory } from '../src/directory.js'
import { MemoryRepo } from '../src/repo.js'
import { ADMIN_ROLE, PERMISSIONS, PERMISSION_KEYS, USER_ROLE, isPermissionKey } from '../src/permissions.js'
import { emptyState } from '../src/types.js'

async function makeDir() {
  const dir = new UserDirectory({ repo: new MemoryRepo() })
  await dir.boot()
  await dir.createUser({ username: 'root', password: 'root-pw', role: ADMIN_ROLE })
  await dir.createUser({ username: 'alice', password: 'alice-pw' })
  return dir
}

describe('permission catalog', () => {
  it('is data-defined and free of duplicates', () => {
    const keys = PERMISSIONS.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain('users')
    expect(keys).toContain('settings')
    // Every key must have a real enforcement point; `channels` is enforced by
    // @tentacle/channels' admin routes.
    expect(keys).toContain('channels')
    for (const def of PERMISSIONS) {
      expect(def.labelZh.length).toBeGreaterThan(0)
      expect(def.labelEn.length).toBeGreaterThan(0)
      expect(['admin', 'settings']).toContain(def.category)
    }
  })

  it('recognizes only catalog keys', () => {
    expect(isPermissionKey('users')).toBe(true)
    expect(isPermissionKey('nonsense')).toBe(false)
    expect(PERMISSION_KEYS.size).toBe(PERMISSIONS.length)
  })
})

describe('builtin role templates', () => {
  it('seeds admin and user on boot', async () => {
    const dir = await makeDir()
    const roles = dir.listRoles()
    expect(roles.map((r) => r.id).sort()).toEqual([ADMIN_ROLE, USER_ROLE])
    expect(roles.every((r) => r.builtin)).toBe(true)
    expect(dir.getRole(ADMIN_ROLE)!.permissionKeys).toEqual(PERMISSIONS.map((p) => p.key))
    expect(dir.getRole(USER_ROLE)!.permissionKeys).toEqual([])
  })

  it('backfills roles into a pre-roles state root', async () => {
    const repo = new MemoryRepo({ ...emptyState(), users: [] })
    // simulate an old state root that has users but no roles array
    const legacy: any = { version: 1, users: [], invites: [], policies: [], memberships: [] }
    await repo.save(legacy)
    const dir = new UserDirectory({ repo })
    await dir.boot()
    expect(dir.listRoles().length).toBe(2)
  })

  it('refuses to modify or delete builtin templates', async () => {
    const dir = await makeDir()
    await expect(dir.updateRole(USER_ROLE, { permissionKeys: ['users'] })).rejects.toMatchObject({ code: 'role-protected' })
    await expect(dir.deleteRole(ADMIN_ROLE)).rejects.toMatchObject({ code: 'role-protected' })
  })
})

describe('custom role templates', () => {
  it('creates, edits, assigns, and deletes a template', async () => {
    const dir = await makeDir()
    const role = await dir.createRole({
      id: 'support',
      name: { zh: '客服', en: 'Support' },
      permissionKeys: ['invites'],
    })
    expect(role.builtin).toBe(false)

    await dir.setRole('alice', 'support')
    expect(dir.getUser('alice')!.role).toBe('support')
    expect(dir.permissionsOf('alice')).toEqual(['invites'])

    await dir.updateRole('support', { permissionKeys: ['invites', 'sessions'] })
    expect(dir.permissionsOf('alice').sort()).toEqual(['invites', 'sessions'])

    // in-use templates cannot be deleted
    await expect(dir.deleteRole('support')).rejects.toMatchObject({ code: 'role-in-use' })
    await dir.setRole('alice', USER_ROLE)
    await dir.deleteRole('support')
    expect(dir.getRole('support')).toBeUndefined()
  })

  it('validates ids, duplicates, and unknown permission keys', async () => {
    const dir = await makeDir()
    await expect(dir.createRole({ id: 'Bad ID', name: { zh: 'x', en: 'x' }, permissionKeys: [] }))
      .rejects.toMatchObject({ code: 'bad-credentials' })
    await expect(dir.createRole({ id: USER_ROLE, name: { zh: 'x', en: 'x' }, permissionKeys: [] }))
      .rejects.toMatchObject({ code: 'duplicate-role' })
    await expect(dir.createRole({ id: 'ok', name: { zh: 'x', en: 'x' }, permissionKeys: ['nope'] }))
      .rejects.toMatchObject({ code: 'invalid-permission' })
  })

  it('rejects assigning an unknown role', async () => {
    const dir = await makeDir()
    await expect(dir.setRole('alice', 'ghost-role')).rejects.toMatchObject({ code: 'no-such-role' })
  })

  it('protects the last admin from demotion', async () => {
    const dir = await makeDir()
    await dir.createRole({ id: 'viewer', name: { zh: '只读', en: 'Viewer' }, permissionKeys: ['sessions'] })
    await expect(dir.setRole('root', 'viewer')).rejects.toMatchObject({ code: 'last-admin' })
  })
})

describe('effective permissions', () => {
  it('admin bypasses (full catalog), user has none, custom uses its keys', async () => {
    const dir = await makeDir()
    expect(dir.permissionsOf('root').length).toBe(PERMISSIONS.length)
    expect(dir.permissionsOf('alice')).toEqual([])

    await dir.createRole({ id: 'ops', name: { zh: '运维', en: 'Ops' }, permissionKeys: ['sessions', 'settings'] })
    await dir.setRole('alice', 'ops')
    expect([...dir.permissionsOf('alice')].sort()).toEqual(['sessions', 'settings'])
  })

  it('projects permissions into the public Identity and never leaks the envelope', async () => {
    const dir = await makeDir()
    await dir.createRole({ id: 'auditor', name: { zh: '审计', en: 'Auditor' }, permissionKeys: ['sessions'] })
    await dir.setRole('alice', 'auditor')
    const identity = await dir.authenticate('alice', 'alice-pw')
    expect(identity.roles).toEqual(['auditor'])
    expect(identity.permissions).toEqual(['sessions'])
    expect(JSON.stringify(identity)).not.toContain('scrypt$')
  })

  it('creates users only under existing role templates', async () => {
    const dir = await makeDir()
    await expect(dir.createUser({ username: 'bob', password: 'bob-pw', role: 'ghost' }))
      .rejects.toMatchObject({ code: 'no-such-role' })
  })
})
