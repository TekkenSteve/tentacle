/**
 * @tentacle/gateway — authenticating reverse proxy in front of the loopback
 * DSH control plane (design: docs/design/02-access-control.md).
 */
import type { Context } from '@deepseek-ai/cordis'
import { TentacleGateway } from './service.js'
import type { GatewayConfig } from './types.js'

export const name = 'tentacle-gateway'
export const inject = ['tentacleIdentity', 'webServer', 'connection']

export { TentacleGateway }
export { SessionStore } from './sessions.js'
export { DefaultPolicy, isPrivilegedRpc } from './policy.js'
export { POLICY_BODY_ENDPOINTS } from './types.js'
export { hashPassword, verifyPassword } from '@tentacle/crypto'
export type { Authenticator, GatewayConfig, GatewayRoute, GatewaySession, PermissionPolicy, PolicyDecision, RouteFact } from './types.js'

export function apply(ctx: Context, config?: GatewayConfig): void {
  ctx.plugin(TentacleGateway, config)
}
