/**
 * Channel instance domain (design 07 §1, §3): strict config validation, tenant
 * fencing, name uniqueness, the serialized create path, and the credential
 * record mapping. Pure unit tests — no cordis, no HTTP.
 */
import { describe, expect, it } from 'vitest'
import { tenantId } from '@tentacle/identity'
import {
  ChannelError,
  normalizeName,
  normalizeTenant,
  normalizeTokenRef,
  requireChannelType,
  validateConfig,
} from '../src/instances.js'
import { ChannelRegistry, type ChannelActor } from '../src/registry.js'
import { MemoryStore } from '../src/repo.js'
import { RecordCredentials, UnavailableCredentials, channelCredentialKey } from '../src/credentials.js'

const LOCAL = tenantId('local')
const OTHER = tenantId('other')
const admin: ChannelActor = { tenant: LOCAL, isAdmin: true }
const alice: ChannelActor = { tenant: LOCAL, isAdmin: false }

describe('instance validation', () => {
  it('trims and validates display names', () => {
    expect(normalizeName('  main bot  ')).toBe('main bot')
    expect(() => normalizeName('   ')).toThrowError(ChannelError)
    expect(() => normalizeName('x'.repeat(65))).toThrowError(ChannelError)
    expect(() => normalizeName('bad\u0007name')).toThrowError(ChannelError)
  })

  it('only knows the channel types this build ships', () => {
    expect(requireChannelType('telegram')).toBe('telegram')
    expect(() => requireChannelType('slack')).toThrowError(ChannelError)
  })

  it('applies declared defaults and rejects unknown config keys', () => {
    expect(validateConfig('telegram', {})).toEqual({ pollTimeoutSec: 30, typing: true })
    expect(validateConfig('telegram', { typing: false })).toEqual({ pollTimeoutSec: 30, typing: false })
    expect(() => validateConfig('telegram', { tokenn: 'x' })).toThrowError(ChannelError)
    expect(() => validateConfig('telegram', { pollTimeoutSec: 'fast' })).toThrowError(ChannelError)
    expect(() => validateConfig('telegram', { typing: 'yes' })).toThrowError(ChannelError)
  })

  it('accepts only real credential reference names', () => {
    expect(normalizeTokenRef('TELEGRAM_BOT_TOKEN')).toBe('TELEGRAM_BOT_TOKEN')
    expect(normalizeTokenRef('')).toBeUndefined()
    expect(normalizeTokenRef(undefined)).toBeUndefined()
    expect(() => normalizeTokenRef('not a name')).toThrowError(ChannelError)
  })

  it('validates tenant ids instead of trusting a header', () => {
    expect(normalizeTenant('local')).toBe(LOCAL)
    expect(normalizeTenant(undefined)).toBeUndefined()
    expect(() => normalizeTenant('Not A Tenant')).toThrowError(ChannelError)
  })
})

describe('ChannelRegistry', () => {
  function registry() {
    const store = new MemoryStore()
    let counter = 0
    const registry = new ChannelRegistry(store, { now: () => 1000, newId: () => `id-${++counter}` })
    return { store, registry }
  }

  it('creates an enabled instance owned by the acting tenant', async () => {
    const { registry: channels } = registry()
    const instance = await channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'main', tokenRef: 'TELEGRAM_BOT_TOKEN'  }, alice)
    expect(instance).toMatchObject({
      id: 'id-1',
      tenant: LOCAL,
      channelType: 'telegram',
      name: 'main',
      enabled: true,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      createdAt: 1000,
      updatedAt: 1000,
    })
    expect(instance.config).toEqual({ pollTimeoutSec: 30, typing: true })
  })

  it('refuses a duplicate name inside one tenant but allows it in another', async () => {
    const { registry: channels } = registry()
    await channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'main'  }, admin)
    await expect(channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'main'  }, admin))
      .rejects.toMatchObject({ code: 'name-taken' })
    const other = await channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'main', tenant: OTHER  }, admin)
    expect(other.tenant).toBe(OTHER)
  })

  it('lets only an admin target another tenant', async () => {
    const { registry: channels } = registry()
    await expect(channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'x', tenant: OTHER  }, alice))
      .rejects.toMatchObject({ code: 'forbidden-tenant' })
  })

  it('fences reads and writes to the acting tenant', async () => {
    const { registry: channels } = registry()
    const mine = await channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'mine'  }, alice)
    const theirs = await channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'theirs', tenant: OTHER  }, admin)
    expect(channels.list(alice).map((instance) => instance.id)).toEqual([mine.id])
    expect(channels.list(admin)).toHaveLength(2)
    expect(() => channels.get(theirs.id, alice)).toThrowError(ChannelError)
    await expect(channels.update(theirs.id, { name: 'hijack' }, alice)).rejects.toMatchObject({ code: 'forbidden-tenant' })
    await expect(channels.remove(theirs.id, alice)).rejects.toMatchObject({ code: 'forbidden-tenant' })
  })

  it('updates partial fields, bumps updatedAt, and can clear tokenRef', async () => {
    const { registry: channels } = registry()
    const instance = await channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'main', tokenRef: 'A'  }, admin)
    const renamed = await channels.update(instance.id, { name: 'renamed', config: { typing: false } }, admin)
    expect(renamed).toMatchObject({ id: instance.id, name: 'renamed', tokenRef: 'A', createdAt: 1000 })
    expect(renamed.config).toEqual({ pollTimeoutSec: 30, typing: false })
    const cleared = await channels.update(instance.id, { tokenRef: null }, admin)
    expect(cleared.tokenRef).toBeUndefined()
  })

  it('rejects a rename that collides, and an unknown channel id', async () => {
    const { registry: channels } = registry()
    await channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'a'  }, admin)
    const second = await channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'b'  }, admin)
    await expect(channels.update(second.id, { name: 'a' }, admin)).rejects.toMatchObject({ code: 'name-taken' })
    await expect(channels.update('nope', { name: 'c' }, admin)).rejects.toMatchObject({ code: 'no-such-channel' })
    await expect(channels.remove('nope', admin)).rejects.toMatchObject({ code: 'no-such-channel' })
  })

  it('serializes concurrent creates so one name is claimed exactly once', async () => {
    const { registry: channels } = registry()
    const results = await Promise.allSettled([
      channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'race'  }, admin),
      channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'race'  }, admin),
      channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'race'  }, admin),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    for (const rejected of results.filter((result) => result.status === 'rejected')) {
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'name-taken' })
    }
  })

  it('requires an expert binding and refuses to clear it on update', async () => {
    const { registry: channels } = registry()
    await expect(channels.create({ channelType: 'telegram', name: 'unbound' }, admin))
      .rejects.toMatchObject({ code: 'invalid-config' })
    const instance = await channels.create({ channelType: 'telegram', name: 'bound', target: { kind: 'expert', id: 'general-assistant' } }, admin)
    expect(instance.target).toEqual({ kind: 'expert', id: 'general-assistant' })
    await expect(channels.update(instance.id, { target: null }, admin))
      .rejects.toMatchObject({ code: 'invalid-config' })
    expect((await channels.update(instance.id, { target: { kind: 'expert', id: 'ops' } }, admin)).target)
      .toEqual({ kind: 'expert', id: 'ops' })
  })

  it('returns the removed record so the host can compensate', async () => {
    const { registry: channels } = registry()
    const instance = await channels.create({ channelType: 'telegram', target: { kind: 'expert', id: 'general-assistant' }, name: 'gone'  }, admin)
    const removed = await channels.remove(instance.id, admin)
    expect(removed.id).toBe(instance.id)
    expect(channels.list(admin)).toHaveLength(0)
  })
})

describe('instance credentials', () => {
  /** Minimal official-provider stand-in: grant records map + writability switch. */
  function provider(records = new Map<string, { kind: 'grant'; payload: unknown }>(), writable = true) {
    return {
      records,
      writable,
      async readRecord(key: string) { return records.get(key) },
      async describeRecord(key: string) { return { configured: records.has(key), writable, ...(records.has(key) ? { kind: 'grant' as const } : {}) } },
      async modifyRecord(key: string, mutate: (current: { kind: 'grant'; payload: unknown } | undefined) => Promise<{ kind: 'grant'; payload: unknown } | undefined>) {
        const next = await mutate(records.get(key))
        if (next === undefined) return undefined
        records.set(key, next)
        return next
      },
      async deleteRecord(key: string) { records.delete(key) },
    }
  }

  it('stores, reports and removes one record per instance', async () => {
    const fake = provider()
    const credentials = new RecordCredentials(fake as never)
    await credentials.write('chan-1', { token: 'secret-token', encryptKey: 'enc-1' })
    expect(fake.records.get(channelCredentialKey('chan-1'))).toEqual({ kind: 'grant', payload: { token: 'secret-token', encryptKey: 'enc-1' } })
    expect(await credentials.read('chan-1')).toEqual({ token: 'secret-token', encryptKey: 'enc-1' })
    expect(await credentials.describe('chan-1')).toEqual({ stored: true, writable: true })
    await credentials.remove('chan-1')
    expect(await credentials.read('chan-1')).toBeUndefined()
    expect(await credentials.describe('chan-1')).toEqual({ stored: false, writable: true })
  })

  it('refuses to store an empty secret map', async () => {
    const credentials = new RecordCredentials(provider() as never)
    await expect(credentials.write('chan-1', {})).rejects.toThrowError()
  })

  it('reports a read-only store instead of silently failing later', async () => {
    const fake = provider(new Map(), false)
    const credentials = new RecordCredentials(fake as never)
    expect(await credentials.describe('chan-1')).toEqual({ stored: false, writable: false })
  })

  it('says plainly why a deployment without credentials cannot store a secret', async () => {
    await expect(new UnavailableCredentials().write('chan-1', { token: 'x' })).rejects.toMatchObject({ code: 'credentials-unavailable' })
    expect(await new UnavailableCredentials().read('chan-1')).toBeUndefined()
  })
})
