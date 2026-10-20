import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  base58btcDecode,
  base58btcEncode,
  didKeyFromPublicKey,
  generateEd25519,
  publicKeyFromDidKey,
  rawEd25519PublicKey,
} from '../src/did-key.js'
import { LocalProvider } from '../src/local-provider.js'

describe('base58btc', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3, 250, 255])
    expect(base58btcDecode(base58btcEncode(bytes))).toEqual(bytes)
  })

  it('rejects invalid characters', () => {
    expect(() => base58btcDecode('0OIl')).toThrow()
  })
})

describe('did:key', () => {
  it('round-trips an ed25519 public key', () => {
    const { publicKey } = generateEd25519()
    const raw = rawEd25519PublicKey(publicKey)
    const did = didKeyFromPublicKey(raw)
    expect(did.startsWith('did:key:z')).toBe(true)
    expect(publicKeyFromDidKey(did)).toEqual(raw)
  })

  it('rejects non-did:key strings', () => {
    expect(() => publicKeyFromDidKey('did:web:example.com')).toThrow()
  })
})

describe('LocalProvider', () => {
  it('provisions a stable identity on first boot and reloads it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-identity-'))
    const first = new LocalProvider(root)
    await first.boot()
    const a = await first.current()
    expect(a.subjectId.startsWith('did:key:z')).toBe(true)
    expect(a.tenant).toBe('local')

    const second = new LocalProvider(root)
    await second.boot()
    expect((await second.current()).subjectId).toBe(a.subjectId)

    // Key material is 0600.
    const keyMode = statSync(join(root, 'local-identity.pkcs8.pem')).mode & 0o777
    expect(keyMode).toBe(0o600)
  })

  it('fails closed when identity record and key diverge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-identity-'))
    await new LocalProvider(root).boot()
    // Tamper: re-provision only the identity record against the old key.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(root, 'identity.json'), JSON.stringify({
      subjectId: 'did:key:zForged', tenant: 'local', createdAt: 0,
    }))
    await expect(new LocalProvider(root).boot()).rejects.toThrow(/refusing to boot/)
  })

  it('signs payloads verifiable by the embedded public key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-identity-'))
    const provider = new LocalProvider(root)
    await provider.boot()
    const identity = await provider.current()
    const payload = new TextEncoder().encode('hello tentacle')
    const signature = await provider.sign(payload)

    const { createPublicKey, verify } = await import('node:crypto')
    const pem = readFileSync(join(root, 'local-identity.pkcs8.pem'), 'utf8')
    expect(verify(null, Buffer.from(payload), createPublicKey(pem), Buffer.from(signature))).toBe(true)
    expect(identity.subjectId).toContain('did:key:z')
  })
})
