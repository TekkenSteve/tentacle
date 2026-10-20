/**
 * did:key encoding for Ed25519 keys (multibase base58btc + multicodec).
 *
 * A `did:key` is self-contained: the public key is embedded in the DID string,
 * so verification needs no network resolution — the right default for local
 * zero-config identity. See docs/design/01-identity.md (D1).
 *
 * Zero-dependency implementation: base58btc + the two-byte multicodec prefix
 * 0xed 0x01 ("ed25519-pub", varint-encoded).
 */
import { generateKeyPairSync } from 'node:crypto'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE = BigInt(58)
const ED25519_MULTICODEC = [0xed, 0x01]

export function base58btcEncode(bytes: Uint8Array): string {
  // Count leading zero bytes — each becomes a leading '1'.
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++

  let value = BigInt(0)
  for (const byte of bytes) value = value * BigInt(256) + BigInt(byte)

  let encoded = ''
  while (value > 0n) {
    const mod = value % BASE
    encoded = ALPHABET[Number(mod)]! + encoded
    value = value / BASE
  }
  return '1'.repeat(zeros) + (encoded || (zeros === bytes.length ? '' : ''))
}

export function base58btcDecode(text: string): Uint8Array {
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros++

  let value = BigInt(0)
  for (const char of text) {
    const digit = ALPHABET.indexOf(char)
    if (digit < 0) throw new Error(`invalid base58btc character: ${JSON.stringify(char)}`)
    value = value * BASE + BigInt(digit)
  }

  const bytes: number[] = []
  while (value > 0n) {
    bytes.unshift(Number(value % BigInt(256)))
    value = value / BigInt(256)
  }
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...bytes])
}

/** Raw 32-byte Ed25519 public key from a KeyObject (SPKI DER tail). */
export function rawEd25519PublicKey(key: import('node:crypto').KeyObject): Uint8Array {
  const der = key.export({ format: 'der', type: 'spki' })
  if (der.length !== 44) throw new Error(`unexpected Ed25519 SPKI length: ${der.length}`)
  return new Uint8Array(der.subarray(12))
}

/** did:key string from a raw Ed25519 public key. */
export function didKeyFromPublicKey(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== 32) throw new Error(`Ed25519 public key must be 32 bytes, got ${rawPublicKey.length}`)
  return `did:key:z${base58btcEncode(new Uint8Array([...ED25519_MULTICODEC, ...rawPublicKey]))}`
}

/** Recover the raw Ed25519 public key from a did:key string. */
export function publicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) throw new Error(`not an ed25519 did:key: ${did}`)
  const bytes = base58btcDecode(did.slice('did:key:z'.length))
  if (bytes.length !== 34 || bytes[0] !== ED25519_MULTICODEC[0] || bytes[1] !== ED25519_MULTICODEC[1]) {
    throw new Error(`did:key does not carry an ed25519-pub multicodec: ${did}`)
  }
  return bytes.subarray(2)
}

export interface Ed25519Keypair {
  publicKey: import('node:crypto').KeyObject
  privateKey: import('node:crypto').KeyObject
}

export function generateEd25519(): Ed25519Keypair {
  return generateKeyPairSync('ed25519')
}
