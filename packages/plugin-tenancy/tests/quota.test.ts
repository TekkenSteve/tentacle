/**
 * Quota enforcement (design 05 §2.4): the live-agent ledger and the two
 * policy decisions the gateway consults — `max_agents` at session.create,
 * `token_quota` at prompt. Values are admin-entered strings, so every
 * non-numeric or negative form must be ignored instead of guessed.
 */
import { describe, expect, it } from 'vitest'
import { UserDirectory } from '../src/directory.js'
import { MemoryRepo } from '../src/repo.js'
import { AgentLedger, intPolicy, QuotaGate } from '../src/quota.js'
import { TenancyPolicy } from '../src/policy.js'
import type { RouteFact } from '@tentacle/gateway'

async function harness(policies: Record<string, string> = {}) {
  const directory = new UserDirectory({ repo: new MemoryRepo() })
  await directory.boot()
  const admin = await directory.createUser({ username: 'root', password: 'pw', role: 'admin' })
  const user = await directory.createUser({ username: 'alice', password: 'pw' })
  for (const [name, value] of Object.entries(policies)) {
    await directory.setPolicy(user.subjectId, name as 'token_quota' | 'max_agents', value)
  }
  const ledger = new AgentLedger()
  const gate = new QuotaGate(directory, ledger)
  const policy = new TenancyPolicy(directory, gate)
  return { directory, ledger, gate, policy, admin, user }
}

const createFact: RouteFact = {
  channel: 'rpc', method: 'POST', path: '/api/session.create', rpcEndpoint: 'session.create', body: { args: { cwd: '/tmp' } },
}
const promptFact: RouteFact = { channel: 'rpc', method: 'POST', path: '/api/prompt', rpcEndpoint: 'prompt' }

describe('intPolicy', () => {
  it('accepts non-negative integers only', () => {
    expect(intPolicy('5')).toBe(5)
    expect(intPolicy('0')).toBe(0)
    expect(intPolicy(' 12 ')).toBe(12)
    expect(intPolicy(undefined)).toBeUndefined()
    expect(intPolicy('')).toBeUndefined()
    expect(intPolicy('-1')).toBeUndefined()
    expect(intPolicy('1.5')).toBeUndefined()
    expect(intPolicy('many')).toBeUndefined()
  })
})

describe('AgentLedger', () => {
  it('counts live sessions per subject and releases them on dispose', () => {
    const ledger = new AgentLedger()
    ledger.register('did:key:a' as never, 's1')
    ledger.register('did:key:a' as never, 's2')
    ledger.register('did:key:b' as never, 's3')
    expect(ledger.activeCount('did:key:a' as never)).toBe(2)
    expect(ledger.activeCount('did:key:b' as never)).toBe(1)
    // Idempotent per session id, and unknown disposals are no-ops.
    ledger.register('did:key:a' as never, 's1')
    expect(ledger.activeCount('did:key:a' as never)).toBe(2)
    ledger.dispose('s1')
    ledger.dispose('missing')
    expect(ledger.activeCount('did:key:a' as never)).toBe(1)
  })
})

describe('max_agents at session.create', () => {
  it('refuses the creating agent past the limit and allows under it', async () => {
    const h = await harness({ max_agents: '1' })
    const id = await h.directory.authenticate('alice', 'pw')
    expect((await h.policy.resolve(id, createFact)).allow).toBe(true)
    h.ledger.register(h.user.subjectId, 's1')
    const denied = await h.policy.resolve(id, createFact)
    expect(denied.allow).toBe(false)
    expect(denied.reason).toMatch(/max_agents/)
    // Admins bypass quotas, like every other privileged decision.
    expect((await h.policy.resolve(await h.directory.authenticate('root', 'pw'), createFact)).allow).toBe(true)
  })
})

describe('token_quota at prompt', () => {
  it('refuses once accumulated spend reaches the quota', async () => {
    const h = await harness({ token_quota: '100' })
    const id = await h.directory.authenticate('alice', 'pw')
    expect((await h.policy.resolve(id, promptFact)).allow).toBe(true)
    await h.directory.recordUsage(h.user.subjectId, 60, 40)
    const denied = await h.policy.resolve(id, promptFact)
    expect(denied.allow).toBe(false)
    expect(denied.reason).toMatch(/token_quota/)
    // Admins bypass quotas (the same rule as every privileged decision).
    expect((await h.policy.resolve(await h.directory.authenticate('root', 'pw'), promptFact)).allow).toBe(true)
  })

  it('resets by clearing the ledger row', async () => {
    const h = await harness({ token_quota: '10' })
    const id = await h.directory.authenticate('alice', 'pw')
    await h.directory.recordUsage(h.user.subjectId, 5, 5)
    expect((await h.policy.resolve(id, promptFact)).allow).toBe(false)
    await h.directory.resetUsage(h.user.subjectId)
    expect((await h.policy.resolve(id, promptFact)).allow).toBe(true)
    expect(h.directory.usageOf(h.user.subjectId)).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})

describe('no policy means no gate', () => {
  it('leaves a user without quotas unrestricted', async () => {
    const h = await harness()
    const id = await h.directory.authenticate('alice', 'pw')
    expect((await h.policy.resolve(id, createFact)).allow).toBe(true)
    expect((await h.policy.resolve(id, promptFact)).allow).toBe(true)
  })
})
