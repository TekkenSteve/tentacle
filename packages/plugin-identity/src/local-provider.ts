/**
 * LocalProvider — the zero-config default identity provider (D2).
 *
 * First boot generates an Ed25519 keypair under the state root (0600) and
 * derives `subjectId = did:key:<public key>`. A single-user deployment runs
 * the same multi-tenant code path from day one — the user simply never
 * notices the identity layer exists.
 *
 * Private key never leaves this process and is never exposed through any
 * Remote surface (D4).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { join } from 'node:path'
import { didKeyFromPublicKey, generateEd25519, rawEd25519PublicKey } from './did-key.js'
import { subjectId, tenantId, type Identity, type IdentityProvider } from './types.js'

const PRIVATE_KEY_FILE = 'local-identity.pkcs8.pem'
const IDENTITY_FILE = 'identity.json'

interface StoredIdentity {
  subjectId: string
  tenant: string
  handle?: string
  createdAt: number
}

export class LocalProvider implements IdentityProvider {
  readonly kind = 'local'
  private identity: Identity | undefined

  constructor(
    /** State root, e.g. `$DSH_HOME/tentacle/<profile>/identity`. */
    private readonly stateRoot: string,
    private readonly defaultTenant = 'local',
  ) {}

  async boot(): Promise<void> {
    mkdirSync(this.stateRoot, { recursive: true, mode: 0o700 })
    chmodSync(this.stateRoot, 0o700)

    const keyPath = join(this.stateRoot, PRIVATE_KEY_FILE)
    const identityPath = join(this.stateRoot, IDENTITY_FILE)

    if (existsSync(keyPath) && existsSync(identityPath)) {
      const stored = JSON.parse(readFileSync(identityPath, 'utf8')) as StoredIdentity
      // Verify the stored identity still matches the key on disk — a mismatch
      // means manual tampering; fail closed rather than impersonate.
      const publicKey = createPublicKey(readFileSync(keyPath, 'utf8'))
      const derived = didKeyFromPublicKey(rawEd25519PublicKey(publicKey))
      if (derived !== stored.subjectId) {
        throw new Error(`tentacle identity: ${IDENTITY_FILE} does not match ${PRIVATE_KEY_FILE}; refusing to boot`)
      }
      this.identity = {
        subjectId: subjectId(stored.subjectId),
        tenant: tenantId(stored.tenant),
        handle: stored.handle,
        createdAt: stored.createdAt,
      }
      return
    }

    const { publicKey, privateKey } = generateEd25519()
    const did = didKeyFromPublicKey(rawEd25519PublicKey(publicKey))
    const created: Identity = {
      subjectId: subjectId(did),
      tenant: tenantId(this.defaultTenant),
      createdAt: Date.now(),
    }

    // Write key first (0600), then the public identity record.
    writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    chmodSync(keyPath, 0o600)
    writeFileSync(join(this.stateRoot, IDENTITY_FILE), JSON.stringify({
      subjectId: created.subjectId,
      tenant: created.tenant,
      createdAt: created.createdAt,
    } satisfies StoredIdentity, null, 2) + '\n', { mode: 0o600 })

    this.identity = created
  }

  async current(): Promise<Identity> {
    if (!this.identity) throw new Error('tentacle identity: provider not booted')
    return this.identity
  }

  async resolve(id: import('./types.js').SubjectId): Promise<Identity | undefined> {
    const current = await this.current()
    return current.subjectId === id ? current : undefined
  }

  /**
   * Sign a payload with the local identity key. Host-only by design — never
   * expose this through a Remote method (signing-oracle risk, D4).
   */
  async sign(payload: Uint8Array): Promise<Uint8Array> {
    const { sign } = await import('node:crypto')
    const privateKey = createPrivateKey(readFileSync(join(this.stateRoot, PRIVATE_KEY_FILE), 'utf8'))
    return new Uint8Array(sign(null, Buffer.from(payload), privateKey))
  }
}
