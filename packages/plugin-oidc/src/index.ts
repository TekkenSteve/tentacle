/**
 * @tentacle/oidc — OIDC browser SSO login for the tentacle gateway.
 *
 * Composition: after @tentacle/gateway. Two public routes
 * (`/tentacle/auth/oidc/start` and `/callback`) drive an authorization-code +
 * PKCE flow via the official openid-client library and mint a gateway session
 * on success. Secrets and transactions stay in the host process.
 */
import type { Context } from '@deepseek-ai/cordis'
import { TentacleOidc, type TentacleOidcConfig } from './oidc.js'

export const name = 'tentacle-oidc'
export const inject = ['tentacleGateway']
export * from './oidc.js'

export function apply(ctx: Context, config?: TentacleOidcConfig): void {
  ctx.plugin(TentacleOidc, config)
}
