/**
 * Permission catalog (design 05 §0/§3, the reference implementation's `infra/users/permissions.py`
 * model made data-driven).
 *
 * Two rules keep this honest and low-burden:
 *
 * 1. **Every key maps to a real enforcement point.** We do not invent
 *    catalog entries for surfaces that do not exist — a permission that
 *    nothing checks is a lie in the admin UI.
 * 2. **Admin bypasses.** The `admin` role template grants everything,
 *    including keys added by later releases; other roles enumerate their
 *    keys explicitly. This mirrors the reference implementation and avoids "upgrade silently
 *    revoked the admin's new permission".
 *
 * Keys gate MANAGEMENT surfaces and privileged RPC only. Reading your own
 * sessions and chatting are never gated (05 §3) — that is what keeps the
 * per-user path cheap.
 */

export interface PermissionDef {
  readonly key: string
  readonly category: 'admin' | 'settings'
  readonly labelZh: string
  readonly labelEn: string
}

export const PERMISSIONS: readonly PermissionDef[] = [
  // ---- admin console surfaces ----
  { key: 'users', category: 'admin', labelZh: '用户管理', labelEn: 'User management' },
  { key: 'roles', category: 'admin', labelZh: '角色与权限', labelEn: 'Roles & permissions' },
  { key: 'invites', category: 'admin', labelZh: '邀请管理', labelEn: 'Invites' },
  { key: 'policies', category: 'admin', labelZh: '资源策略', labelEn: 'Resource policies' },
  { key: 'sessions', category: 'admin', labelZh: '在线会话查看', labelEn: 'Live sessions' },
  { key: 'experts', category: 'admin', labelZh: '专家库管理', labelEn: 'Expert library' },
  { key: 'teams', category: 'admin', labelZh: '团队库管理', labelEn: 'Team library' },
  {
    key: 'channels',
    category: 'admin',
    labelZh: 'IM 频道与身份绑定',
    labelEn: 'IM channels & identity binding',
  },

  // ---- privileged RPC surfaces (gateway deny-list) ----
  { key: 'settings', category: 'settings', labelZh: '特权设置', labelEn: 'Privileged settings' },
  { key: 'credentials', category: 'settings', labelZh: '凭证库', labelEn: 'Credential store' },
  { key: 'plugins', category: 'settings', labelZh: '插件管理', labelEn: 'Plugin management' },
] as const

export const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key))

export function isPermissionKey(key: string): boolean {
  return PERMISSION_KEYS.has(key)
}

/** Drop unknown keys silently? No — callers validate; this is the filter used when a catalog item is removed. */
export function knownPermissions(keys: readonly string[]): string[] {
  return [...new Set(keys.filter(isPermissionKey))]
}

/**
 * The role id that bypasses every permission check. Kept as a named constant
 * so the bypass is greppable and auditable.
 */
export const ADMIN_ROLE = 'admin'
export const USER_ROLE = 'user'
