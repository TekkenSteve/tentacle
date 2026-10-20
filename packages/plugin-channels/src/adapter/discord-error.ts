/**
 * Typed error codes for the Discord adapter (mirrors the reference implementation's `runtime_error`
 * taxonomy: invalid_token / intents_required / connection_failed).
 */
export type DiscordErrorCode = 'auth' | 'api' | 'transport' | 'invalid-response' | 'config' | 'intents'

export class DiscordError extends Error {
  constructor(readonly code: DiscordErrorCode, message: string, readonly status?: number) {
    super(message)
    this.name = 'DiscordError'
  }
}
