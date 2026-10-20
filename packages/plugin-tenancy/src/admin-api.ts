/**
 * Admin REST API (design 05 §2.2) — declarative route table served at the
 * gateway layer via `registerRoute`. Two seats:
 *
 * - `/tentacle/api/admin/*` — authenticated, admin role required
 * - `/tentacle/api/signup`   — public, redeems an invite code
 *
 * The handler receives the gateway-authenticated identity; authorization
 * consults `roles` only (D1). Errors are a fixed vocabulary — no stack
 * traces, no internals (design 02 §6).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GatewayRoute } from '@tentacle/gateway'
import { subjectId } from '@tentacle/identity'
import { DirectoryError } from './directory.js'
import type { TentacleTenancy } from './service.js'
import type { Role } from './types.js'

const ADMIN_PREFIX = '/tentacle/api/admin'
const SIGNUP_PATH = '/tentacle/api/signup'
const SETUP_STATUS_PATH = '/tentacle/api/setup-status'
const SETUP_PATH = '/tentacle/api/setup'
const ME_PATH = '/tentacle/api/me'
const ME_CHANGE_PASSWORD_PATH = '/tentacle/api/me/change-password'

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

/**
 * Accept a plain string (applied to both locales) or a {zh,en} object.
 * The roster has no locale concept, so templates store both.
 */
function localized(value: unknown, fallback: unknown): { zh: string; en: string } {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return { zh: String(record.zh ?? ''), en: String(record.en ?? '') }
  }
  const text = String(value ?? fallback ?? '')
  return { zh: text, en: text }
}

/** Stable public error codes — DirectoryError codes map 1:1, nothing else leaks. */
function errorStatus(error: unknown): { status: number; code: string } {
  if (error instanceof DirectoryError) {
    const status = {
      'duplicate-user': 409,
      'no-such-user': 404,
      'invalid-invite': 410,
      'login-locked': 423,
      disabled: 403,
      'bad-credentials': 400,
      'last-admin': 409,
      'setup-required': 428,
      'setup-closed': 409,
      'no-such-role': 404,
      'duplicate-role': 409,
      'role-protected': 409,
      'role-in-use': 409,
      'invalid-permission': 400,
    }[error.code] as number
    return { status, code: error.code }
  }
  return { status: 400, code: 'bad-request' }
}

interface AdminAction {
  method: string
  path: string
  /** Permission key required to run this action (ignored for the admin bypass). */
  permission: PermissionKey
  /**
   * Read-only roster sharing: `/users` is the natural source for the other
   * tabs' user pickers, so any sibling management permission may read it.
   * It never exposes password material.
   */
  alsoAllowedWith?: readonly PermissionKey[]
  run(tenancy: TentacleTenancy, body: Record<string, unknown>): Promise<unknown>
}

type PermissionKey = 'users' | 'roles' | 'invites' | 'policies' | 'sessions' | 'experts' | 'teams'

const ADMIN_ACTIONS: AdminAction[] = [
  {
    method: 'GET', path: '/users',
    permission: 'users', alsoAllowedWith: ['roles', 'invites', 'policies', 'sessions'],
    run: async (t) => t.listUsers().map((u) => ({
      subjectId: u.subjectId,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      role: u.role,
      disabled: u.disabled,
      loginFailedCount: u.loginFailedCount,
      loginLockedUntil: u.loginLockedUntil,
      createdAt: u.createdAt,
    })),
  },
  {
    method: 'POST', path: '/users',
    permission: 'users',
    run: async (t, b) => {
      const user = await t.directory.createUser({
        username: String(b.username ?? ''),
        password: String(b.password ?? ''),
        role: b.role === undefined ? undefined : String(b.role),
        displayName: b.displayName === undefined ? undefined : String(b.displayName),
      })
      return { subjectId: user.subjectId, username: user.username, role: user.role }
    },
  },
  {
    method: 'POST', path: '/users/disable',
    permission: 'users',
    run: async (t, b) => {
      await t.disableUser(String(b.username ?? ''))
      return { ok: true }
    },
  },
  {
    method: 'POST', path: '/users/enable',
    permission: 'users',
    run: async (t, b) => {
      await t.directory.enable(String(b.username ?? ''))
      return { ok: true }
    },
  },
  {
    method: 'POST', path: '/users/delete',
    permission: 'users',
    run: async (t, b) => {
      await t.deleteUser(String(b.username ?? ''))
      return { ok: true }
    },
  },
  {
    method: 'POST', path: '/users/unlock-login',
    permission: 'users',
    run: async (t, b) => {
      await t.directory.unlockLogin(String(b.username ?? ''))
      return { ok: true }
    },
  },
  {
    method: 'POST', path: '/users/update-profile',
    permission: 'users',
    run: async (t, b) => {
      await t.directory.updateProfile(String(b.username ?? ''), {
        displayName: b.displayName === undefined ? undefined : String(b.displayName),
        email: b.email === undefined ? undefined : String(b.email),
      })
      return { ok: true }
    },
  },
  {
    method: 'POST', path: '/users/batch',
    permission: 'users',
    run: async (t, b) => {
      const usernames = Array.isArray(b.usernames) ? b.usernames.map(String).slice(0, 500) : []
      const action = String(b.action ?? '')
      if (action !== 'enable' && action !== 'disable' && action !== 'delete') {
        throw new DirectoryError('bad-credentials', `unknown batch action: ${action}`)
      }
      return { results: await t.batchUsers(usernames, action) }
    },
  },
  {
    method: 'POST', path: '/users/reset-password',
    permission: 'users',
    run: async (t, b) => {
      await t.directory.resetPassword(String(b.username ?? ''), String(b.password ?? ''))
      return { ok: true }
    },
  },
  {
    method: 'GET', path: '/invites',
    permission: 'invites',
    run: async (t) => t.directory.listInvites().map((i) => ({
      fingerprint: i.codeFingerprint,
      role: i.role,
      expiresAt: i.expiresAt,
      redeemedBy: i.redeemedBy,
      createdAt: i.createdAt,
    })),
  },
  {
    method: 'POST', path: '/invites',
    permission: 'invites',
    run: async (t, b) => {
      const ttlHours = typeof b.ttlHours === 'number' ? b.ttlHours : undefined
      return t.directory.createInvite(b.role === 'admin' ? 'admin' : 'user', ttlHours ? ttlHours * 3_600_000 : undefined)
    },
  },
  {
    method: 'POST', path: '/invites/revoke',
    permission: 'invites',
    run: async (t, b) => ({ ok: await t.directory.revokeInvite(String(b.code ?? '')) }),
  },
  {
    method: 'GET', path: '/roles',
    permission: 'roles',
    run: async (t) => t.directory.listRoles(),
  },
  {
    method: 'POST', path: '/roles',
    permission: 'roles',
    run: async (t, b) => t.directory.createRole({
      id: String(b.id ?? ''),
      name: localized(b.name, b.id),
      description: b.description === undefined ? undefined : localized(b.description, b.id),
      permissionKeys: Array.isArray(b.permissionKeys) ? b.permissionKeys.map(String) : [],
    }),
  },
  {
    method: 'POST', path: '/roles/update',
    permission: 'roles',
    run: async (t, b) => t.directory.updateRole(String(b.id ?? ''), {
      name: b.name === undefined ? undefined : localized(b.name, b.id),
      description: b.description === undefined ? undefined : localized(b.description, b.id),
      permissionKeys: Array.isArray(b.permissionKeys) ? b.permissionKeys.map(String) : undefined,
    }),
  },
  {
    method: 'POST', path: '/roles/delete',
    permission: 'roles',
    run: async (t, b) => {
      await t.directory.deleteRole(String(b.id ?? ''))
      return { ok: true }
    },
  },
  {
    method: 'POST', path: '/roles/assign',
    permission: 'roles',
    run: async (t, b) => {
      await t.directory.setRole(String(b.username ?? ''), String(b.roleId ?? ''))
      return { ok: true }
    },
  },
  {
    method: 'GET', path: '/permissions',
    permission: 'roles',
    run: async (t) => t.permissionCatalog(),
  },
  {
    method: 'GET', path: '/sessions',
    permission: 'sessions',
    run: async (t) => (t.gatewaySessions?.() ?? []).map((s) => ({
      handle: s.identity.handle,
      subjectId: s.identity.subjectId,
      roles: s.identity.roles,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    })),
  },
  {
    method: 'GET', path: '/quota',
    permission: 'policies',
    run: async (t, b) => t.usageOf(subjectId(String(b.subjectId ?? ''))),
  },
  {
    method: 'POST', path: '/quota/reset',
    permission: 'policies',
    run: async (t, b) => {
      await t.resetUsage(subjectId(String(b.subjectId ?? '')))
      return { ok: true }
    },
  },
  {
    method: 'GET', path: '/policies',
    permission: 'policies',
    run: async (t, b) => {
      const id = subjectId(String(b.subjectId ?? ''))
      return t.directory.listPolicies(id)
    },
  },
  {
    method: 'POST', path: '/policies',
    permission: 'policies',
    run: async (t, b) => {
      const name = String(b.name ?? '')
      if (name !== 'workspace_root_dir' && name !== 'token_quota' && name !== 'max_agents') {
        throw new DirectoryError('bad-credentials', `unknown policy: ${name}`)
      }
      await t.directory.setPolicy(
        subjectId(String(b.subjectId ?? '')),
        name,
        b.value === undefined || b.value === null ? undefined : String(b.value),
      )
      return { ok: true }
    },
  },
]

/** Build the two gateway route registrations for this tenancy. */
export function createAdminRoutes(tenancy: TentacleTenancy): GatewayRoute[] {
  return [
    {
      prefix: ADMIN_PREFIX,
      handler: async (req, res, context) => {
        const path = (req.url ?? '/').split('?', 1)[0]!.slice(ADMIN_PREFIX.length) || '/'
        const action = ADMIN_ACTIONS.find((a) => a.method === req.method && a.path === path)
        if (!action) {
          writeJson(res, 404, { error: 'no such admin action' })
          return
        }
        // Admin bypass, then the action's own permission key (design 05 §3).
        const identity = context.identity
        const allowed = identity !== undefined && (
          identity.roles?.includes('admin') === true
          || identity.permissions?.includes(action.permission) === true
          || (action.alsoAllowedWith?.some((key) => identity.permissions?.includes(key)) ?? false)
        )
        if (!allowed) {
          writeJson(res, 403, { error: `permission required: ${action.permission}` })
          return
        }
        try {
          // GET actions read their input from the query string; others from JSON.
          const query = Object.fromEntries(new URL(req.url ?? '/', 'http://x').searchParams)
          const body = req.method === 'GET' ? query : await readJson(req)
          writeJson(res, 200, await action.run(tenancy, body))
        } catch (error) {
          const { status, code } = errorStatus(error)
          writeJson(res, status, { error: code })
        }
      },
    },
    {
      prefix: ME_CHANGE_PASSWORD_PATH,
      handler: async (req, res, context) => {
        // Self-service password change (any authenticated user): verifies the
        // old password, so a stolen session alone cannot lock the owner out.
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const identity = context.identity
        if (!identity?.handle) {
          writeJson(res, 401, { error: 'authentication required' })
          return
        }
        try {
          const body = await readJson(req)
          await tenancy.directory.changePassword(
            identity.handle,
            String(body.oldPassword ?? ''),
            String(body.newPassword ?? ''),
          )
          writeJson(res, 200, { ok: true })
        } catch (error) {
          const { status, code } = errorStatus(error)
          writeJson(res, status, { error: code })
        }
      },
    },
    {
      prefix: ME_PATH,
      handler: async (req, res, context) => {
        // Self-service read for the browser client half: the caller's own
        // identity plus their workspace fence. The gateway already enforced
        // authentication on this non-public route, but a passthrough-mode
        // composition hands every caller the operator identity — answer
        // honestly in both cases, the client decides what to shadow.
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const identity = context.identity
        if (!identity) {
          writeJson(res, 401, { error: 'authentication required' })
          return
        }
        writeJson(res, 200, {
          identity,
          workspaceRootDir: tenancy.directory.getPolicy(identity.subjectId, 'workspace_root_dir'),
        })
      },
    },
    {
      prefix: SIGNUP_PATH,
      public: true,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const body = await readJson(req)
          const user = await tenancy.directory.redeemInvite(
            String(body.code ?? ''),
            String(body.username ?? ''),
            String(body.password ?? ''),
          )
          writeJson(res, 201, { subjectId: user.subjectId, username: user.username, role: user.role })
        } catch (error) {
          const { status, code } = errorStatus(error)
          writeJson(res, status, { error: code })
        }
      },
    },
    {
      // First-run wizard status — public so the login page can offer
      // "create the admin account" instead of a dead-end login form.
      prefix: SETUP_STATUS_PATH,
      public: true,
      handler: async (_req, res) => {
        writeJson(res, 200, { required: tenancy.directory.needsSetup() })
      },
    },
    {
      // One-shot bootstrap: creates the first admin, then closes forever.
      // The emptiness check and the write are one synchronous mutation in
      // UserDirectory.setupAdmin, so concurrent attempts cannot both win.
      prefix: SETUP_PATH,
      public: true,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const body = await readJson(req)
          const password = String(body.password ?? '')
          if (password.length < 8) throw new DirectoryError('bad-credentials', 'password too short')
          const user = await tenancy.directory.setupAdmin(String(body.username ?? ''), password)
          writeJson(res, 201, { subjectId: user.subjectId, username: user.username, role: user.role })
        } catch (error) {
          const { status, code } = errorStatus(error)
          writeJson(res, status, { error: code })
        }
      },
    },
  ]
}

export type { Role }
