/**
 * Quota enforcement state (design 05 §2.4): the live-agent ledger plus the two
 * policy readers. Policy values are stored as strings on purpose (they are
 * admin-entered); anything non-numeric or negative is ignored, never guessed.
 *
 * The ledger is deliberately in-memory: it counts LIVE agents, and a restart
 * ends every live agent — persisting it would resurrect dead counts.
 */
import type { SubjectId } from '@tentacle/identity'
import type { UserDirectory } from './directory.js'

export interface QuotaDecision {
  readonly ok: boolean
  readonly reason?: string
  readonly used?: number
  readonly limit?: number
}

/** Parse a policy value as a non-negative integer; undefined when unusable. */
export function intPolicy(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : undefined
}

/** Which subject each live session belongs to (sessionId → subjectId). */
export class AgentLedger {
  private readonly bySession = new Map<string, SubjectId>()
  private readonly counts = new Map<SubjectId, number>()

  /** Bind a session to its owner; idempotent per session id. */
  register(subjectId: SubjectId, sessionId: string): void {
    if (this.bySession.has(sessionId)) return
    this.bySession.set(sessionId, subjectId)
    this.counts.set(subjectId, (this.counts.get(subjectId) ?? 0) + 1)
  }

  /** A session was disposed: drop its count (unknown ids are no-ops). */
  dispose(sessionId: string): void {
    const subject = this.bySession.get(sessionId)
    if (subject === undefined) return
    this.bySession.delete(sessionId)
    const next = (this.counts.get(subject) ?? 0) - 1
    if (next <= 0) this.counts.delete(subject)
    else this.counts.set(subject, next)
  }

  subjectOf(sessionId: string): SubjectId | undefined {
    return this.bySession.get(sessionId)
  }

  activeCount(subjectId: SubjectId): number {
    return this.counts.get(subjectId) ?? 0
  }
}

export class QuotaGate {
  constructor(
    private readonly directory: UserDirectory,
    private readonly ledger: AgentLedger,
  ) {}

  /** May this subject start one more agent? */
  canStartAgent(subjectId: SubjectId): QuotaDecision {
    const limit = intPolicy(this.directory.getPolicy(subjectId, 'max_agents'))
    if (limit === undefined) return { ok: true }
    const used = this.ledger.activeCount(subjectId)
    return used >= limit
      ? { ok: false, reason: `max_agents quota: ${used} of ${limit} agents are live`, used, limit }
      : { ok: true, used, limit }
  }

  /** May this subject run another prompt under their token budget? */
  canUseTokens(subjectId: SubjectId): QuotaDecision {
    const quota = intPolicy(this.directory.getPolicy(subjectId, 'token_quota'))
    if (quota === undefined) return { ok: true }
    const usage = this.directory.usageOf(subjectId)
    const used = usage.inputTokens + usage.outputTokens
    return used >= quota
      ? { ok: false, reason: `token_quota exceeded: ${used} of ${quota} tokens`, used, limit: quota }
      : { ok: true, used, limit: quota }
  }
}
