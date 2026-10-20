/**
 * @tentacle/identity — pluggable identity for DSH (design: docs/design/01-identity.md).
 *
 * Cordis plugin entry: mounts the `tentacleIdentity` service. The local
 * provider is built in and zero-config; third-party providers are separate
 * packages declaring `inject: ['tentacleIdentity']`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { TentacleIdentity, type TentacleIdentityConfig } from './service.js'

export const name = 'tentacle-identity'
export { TentacleIdentity, type TentacleIdentityConfig }
export * from './types.js'
export { LocalProvider } from './local-provider.js'
export { didKeyFromPublicKey, publicKeyFromDidKey, base58btcDecode, base58btcEncode, generateEd25519, rawEd25519PublicKey } from './did-key.js'

export function apply(ctx: Context, config?: TentacleIdentityConfig): void {
  ctx.plugin(TentacleIdentity, config)
}
