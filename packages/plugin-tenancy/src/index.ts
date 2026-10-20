/**
 * @tentacle/tenancy — tenant × user namespaces for DSH
 * (design: docs/design/03-tenancy.md, 05-admin-users.md).
 */
import type { Context } from '@deepseek-ai/cordis'
import { TentacleTenancy, type TentacleTenancyConfig } from './service.js'

export const name = 'tentacle-tenancy'
export const inject = ['tentacleIdentity']

export { TentacleTenancy, type TentacleTenancyConfig }
export { UserDirectory, DirectoryError, MAX_LOGIN_FAILURES, LOGIN_LOCK_MS } from './directory.js'
export { MemoryRepo, JsonFileRepo, type DirectoryRepo } from './repo.js'
export { PERMISSIONS, PERMISSION_KEYS, isPermissionKey, ADMIN_ROLE, USER_ROLE, type PermissionDef } from './permissions.js'
export { TenancyPolicy, isWithin } from './policy.js'
export { createAdminRoutes } from './admin-api.js'
export { createAdminPageRoute, ADMIN_PAGE_PREFIX } from './admin-page.js'
export * from './types.js'

export function apply(ctx: Context, config?: TentacleTenancyConfig): void {
  ctx.plugin(TentacleTenancy, config)
}
