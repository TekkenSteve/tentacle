/**
 * Binding store rules (design 06 §5, 07 §1): a binding must point at a real
 * tenant user, an identity maps to at most one user PER INSTANCE, a subject
 * from another tenant is refused, and unbinding is explicit.
 */
import { describe, expect, it } from 'vitest'
import { tenantId } from '@tentacle/identity'
import { BindingStore, BindingsError } from '../src/bindings.js'
import { MemoryStore, bindingKey } from '../src/repo.js'

const USERS = [
  { subjectId: 'did:key:zAlice', username: 'alice', tenant: 'local' },
  { subjectId: 'did:key:zBob', username: 'bob', tenant: 'local' },
  { subjectId: 'did:key:zCarol', username: 'carol', tenant: 'other' },
]

const LOCAL = tenantId('local')

function store(directory: readonly { subjectId: string; username: string; tenant: string }[] = USERS) {
  const backing = new MemoryStore()
  const bindings = new BindingStore(backing, { listUsers: () => directory })
  return { bindings, backing }
}

describe('BindingStore', () => {
  it('binds an identity to an existing tenant user durably', async () => {
    const { bindings, backing } = store()
    const binding = await bindings.bind({ channelId: 'bot-a', channelType: 'telegram', platformId: ' 7 ', subjectId: 'did:key:zAlice', tenant: LOCAL })
    expect(binding).toMatchObject({ channelId: 'bot-a', channelType: 'telegram', platformId: '7', subjectId: 'did:key:zAlice' })
    expect(backing.bindings.get(bindingKey({ channelId: 'bot-a', platformId: '7' }))).toEqual(binding)
    expect(bindings.resolve('bot-a', '7')).toEqual(binding)
    expect(bindings.resolve('bot-a', '8')).toBeUndefined()
  })

  it('keeps the same platform identity apart across two instances', async () => {
    const { bindings } = store()
    await bindings.bind({ channelId: 'bot-a', channelType: 'telegram', platformId: '7', subjectId: 'did:key:zAlice', tenant: LOCAL })
    await bindings.bind({ channelId: 'bot-b', channelType: 'telegram', platformId: '7', subjectId: 'did:key:zBob', tenant: LOCAL })
    expect(bindings.resolve('bot-a', '7')?.subjectId).toBe('did:key:zAlice')
    expect(bindings.resolve('bot-b', '7')?.subjectId).toBe('did:key:zBob')
    expect(bindings.list('bot-a')).toHaveLength(1)
    expect(bindings.list()).toHaveLength(2)
  })

  it('refuses a subject the tenancy directory does not know', async () => {
    const { bindings, backing } = store()
    await expect(bindings.bind({ channelId: 'bot-a', channelType: 'telegram', platformId: '7', subjectId: 'did:key:zGhost', tenant: LOCAL }))
      .rejects.toThrowError(BindingsError)
    expect(backing.bindings.size).toBe(0)
    expect(bindings.list()).toHaveLength(0)
  })

  it("refuses a subject from another tenant (the instance's fence)", async () => {
    const { bindings } = store()
    await expect(bindings.bind({ channelId: 'bot-a', channelType: 'telegram', platformId: '7', subjectId: 'did:key:zCarol', tenant: LOCAL }))
      .rejects.toMatchObject({ code: 'channel-tenant-mismatch' })
    expect(bindings.list()).toHaveLength(0)
  })

  it('refuses an empty platform id', async () => {
    const { bindings } = store()
    await expect(bindings.bind({ channelId: 'bot-a', channelType: 'telegram', platformId: '   ', subjectId: 'did:key:zAlice', tenant: LOCAL }))
      .rejects.toMatchObject({ code: 'invalid-binding' })
  })

  it('refuses to re-point an identity: unbind first', async () => {
    const { bindings } = store()
    await bindings.bind({ channelId: 'bot-a', channelType: 'telegram', platformId: '7', subjectId: 'did:key:zAlice', tenant: LOCAL })
    await expect(bindings.bind({ channelId: 'bot-a', channelType: 'telegram', platformId: '7', subjectId: 'did:key:zBob', tenant: LOCAL }))
      .rejects.toMatchObject({ code: 'already-bound' })
    // The original binding is untouched.
    expect(bindings.resolve('bot-a', '7')?.subjectId).toBe('did:key:zAlice')
  })

  it('unbinds exactly the addressed identity and reports misses', async () => {
    const { bindings } = store()
    await bindings.bind({ channelId: 'bot-a', channelType: 'telegram', platformId: '7', subjectId: 'did:key:zAlice', tenant: LOCAL })
    await bindings.bind({ channelId: 'bot-a', channelType: 'telegram', platformId: '8', subjectId: 'did:key:zBob', tenant: LOCAL })
    expect(await bindings.unbind('bot-a', '7')).toBe(true)
    expect(bindings.resolve('bot-a', '7')).toBeUndefined()
    expect(bindings.resolve('bot-a', '8')).toBeDefined()
    expect(await bindings.unbind('bot-a', '7')).toBe(false)
  })

  it('drops every binding of a deleted instance and leaves others alone', async () => {
    const { bindings } = store()
    await bindings.bind({ channelId: 'bot-a', channelType: 'telegram', platformId: '7', subjectId: 'did:key:zAlice', tenant: LOCAL })
    await bindings.bind({ channelId: 'bot-a', channelType: 'telegram', platformId: '8', subjectId: 'did:key:zBob', tenant: LOCAL })
    await bindings.bind({ channelId: 'bot-b', channelType: 'telegram', platformId: '9', subjectId: 'did:key:zBob', tenant: LOCAL })
    expect(await bindings.removeChannel('bot-a')).toBe(2)
    expect(bindings.list('bot-a')).toHaveLength(0)
    expect(bindings.list('bot-b')).toHaveLength(1)
  })

  it('reports whether a subject is a real user', async () => {
    const { bindings } = store()
    expect(bindings.hasUser('did:key:zAlice')).toBe(true)
    expect(bindings.hasUser('did:key:zGhost')).toBe(false)
  })
})
