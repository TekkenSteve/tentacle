/**
 * Per-instance credentials (design: docs/design/07-channel-admin.md §3).
 *
 * Secrets never enter the instance record, the profile or the admin API: they
 * live in the official credential store as plugin-owned records keyed by the
 * instance id (`credentialKey('tentacle-channels', id)`), which is exactly what
 * that seam exists for. A platform may need SEVERAL secrets (an app secret plus
 * callback verification keys), so one record holds the whole named map — the
 * official `GrantRecord` shape, whose payload is opaque to the seam and
 * interpreted only here. Values are write-only from the management surface's
 * point of view: `describe` reports `{stored, writable}` and nothing else.
 */
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { ChannelError } from './instances.js'

/** Credential scope: one record namespace for the whole channels plugin. */
export const CREDENTIAL_SCOPE = 'tentacle-channels'

export function channelCredentialKey(instanceId: string) {
  return credentialKey(CREDENTIAL_SCOPE, instanceId)
}

/** Presence facts for one instance credential, safe for the UI (never values). */
export interface CredentialStatus {
  /** Whether a record is stored at all. */
  readonly stored: boolean
  readonly writable: boolean
}

/** The secret map one instance stores: credential field name → value. */
export type CredentialValues = Record<string, string>

/**
 * The credential face the Registry/Service depend on. Kept as a port so the
 * domain core is testable without a DSH runtime; the Host injects
 * {@link RecordCredentials}, which wraps the official store.
 */
export interface InstanceCredentials {
  /** The stored field map at adapter start; never cached. */
  read(instanceId: string): Promise<CredentialValues | undefined>
  /**
   * Store field values. The payload REPLACES the map: callers merge the
   * previous values themselves when only some fields rotate.
   */
  write(instanceId: string, values: CredentialValues): Promise<void>
  /** Remove the record when its instance is deleted. */
  remove(instanceId: string): Promise<void>
  /** Status only — the values never cross this surface. */
  describe(instanceId: string): Promise<CredentialStatus>
}

/** Wraps the official `ctx.credentials` record half. */
export class RecordCredentials implements InstanceCredentials {
  constructor(private readonly credentials: CredentialProvider) {}

  async read(instanceId: string): Promise<CredentialValues | undefined> {
    const record = await this.credentials.readRecord(channelCredentialKey(instanceId))
    return record !== undefined && record.kind === 'grant' && typeof record.payload === 'object' && record.payload !== null
      ? record.payload as CredentialValues
      : undefined
  }

  async write(instanceId: string, values: CredentialValues): Promise<void> {
    if (Object.keys(values).length === 0) throw new Error('refusing to store an empty credential map')
    await this.credentials.modifyRecord(channelCredentialKey(instanceId), async () => ({ kind: 'grant', payload: values }))
  }

  async remove(instanceId: string): Promise<void> {
    await this.credentials.deleteRecord(channelCredentialKey(instanceId))
  }

  async describe(instanceId: string): Promise<CredentialStatus> {
    const info = await this.credentials.describeRecord(channelCredentialKey(instanceId))
    return { stored: info.configured, writable: info.writable }
  }
}

/**
 * Stand-in for a composition with no credentials service mounted. Reading is
 * reported as "no credential" through the normal failure path; writing says
 * exactly why it cannot work instead of surfacing a bare 400.
 */
export class UnavailableCredentials implements InstanceCredentials {
  async read(): Promise<CredentialValues | undefined> {
    return undefined
  }

  async write(): Promise<void> {
    throw new ChannelError(
      'credentials-unavailable',
      'this deployment mounts no credentials service, so instance secrets cannot be stored',
    )
  }

  async remove(): Promise<void> {}

  async describe(): Promise<CredentialStatus> {
    return { stored: false, writable: false }
  }
}
