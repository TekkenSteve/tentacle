import { describe, expect, it } from 'vitest'
import { hashPassword, newSessionToken, tokenFingerprint, verifyPassword } from '../src/index.js'

describe('password envelopes', () => {
  it('round-trips and fails closed on malformed input', () => {
    const envelope = hashPassword('s3cret')
    expect(verifyPassword('s3cret', envelope)).toBe(true)
    expect(verifyPassword('wrong', envelope)).toBe(false)
    expect(verifyPassword('s3cret', 'not-an-envelope')).toBe(false)
    expect(verifyPassword('s3cret', 'scrypt$zz$yy')).toBe(false)
    expect(verifyPassword('s3cret', '')).toBe(false)
  })

  it('uses a fresh salt per envelope', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'))
  })
})

describe('tokens', () => {
  it('mints url-safe tokens and stable fingerprints', () => {
    const token = newSessionToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(tokenFingerprint(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenFingerprint(token)).toBe(tokenFingerprint(token))
    expect(tokenFingerprint(token)).not.toBe(tokenFingerprint(newSessionToken()))
  })
})
