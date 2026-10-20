/**
 * Password envelopes and session-token fingerprints.
 *
 * Envelope: `scrypt$<saltHex>$<hashHex>` — verification never throws, anything
 * malformed fails closed. Session tokens are random 32 bytes; only their
 * sha256 fingerprint is ever persisted (mirrors the DSH launch-token hygiene).
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const KEYLEN = 32

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, KEYLEN).toString('hex')}`
}

export function verifyPassword(password: string, envelope: string): boolean {
  const parts = envelope.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1]!, 'hex')
  const expected = Buffer.from(parts[2]!, 'hex')
  if (salt.length !== 16 || expected.length !== KEYLEN) return false
  return timingSafeEqual(scryptSync(password, salt, KEYLEN), expected)
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
