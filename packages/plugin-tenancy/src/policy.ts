/**
 * TenancyPolicy — the workspace fence at the gateway's execution point
 * (design 03 §4 layer 1). Wraps the gateway's DefaultPolicy and adds:
 *
 * - `session.create` with a caller-chosen `cwd`: a non-admin user holding a
 *   `workspace_root_dir` policy may only create sessions inside that root
 *   (realpath-checked, so symlink escapes fail). Users without the policy
 *   are unfenced by design — fencing is an explicit admin decision.
 * - `session.create` also enforces `max_agents`; `prompt` enforces
 *   `token_quota` (design 05 §2.4) — both read the live ledger through the
 *   quota gate, so a denied decision never reaches the upstream agent.
 * - everything else defers to the default deny-list (privileged RPC etc.).
 */
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { DefaultPolicy, type PermissionPolicy, type PolicyDecision, type RouteFact } from '@tentacle/gateway'
import type { Identity } from '@tentacle/identity'
import type { UserDirectory } from './directory.js'
import type { QuotaGate } from './quota.js'

function realpathOrResolved(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

export function isWithin(child: string, root: string): boolean {
  const c = realpathOrResolved(child)
  const r = realpathOrResolved(root)
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

export class TenancyPolicy implements PermissionPolicy {
  private readonly fallback = new DefaultPolicy()

  constructor(
    private readonly directory: UserDirectory,
    private readonly gate?: QuotaGate,
  ) {}

  async resolve(identity: Identity | undefined, fact: RouteFact): Promise<PolicyDecision> {
    const base = await this.fallback.resolve(identity, fact)
    if (!base.allow || !identity || identity.roles?.includes('admin')) return base

    if (fact.rpcEndpoint === 'session.create') {
      const decision = this.gate?.canStartAgent(identity.subjectId)
      if (decision !== undefined && !decision.ok) {
        return { allow: false, status: 403, reason: decision.reason ?? 'max_agents quota exceeded' }
      }
      const root = this.directory.getPolicy(identity.subjectId, 'workspace_root_dir')
      if (root !== undefined) {
        const cwd = (fact.body as { args?: { cwd?: string }; cwd?: string } | undefined)?.args?.cwd
          ?? (fact.body as { cwd?: string } | undefined)?.cwd
        if (typeof cwd !== 'string' || !isWithin(cwd, root)) {
          return { allow: false, status: 403, reason: 'workspace_root_dir fence: cwd outside the user root' }
        }
      }
    }
    if (fact.rpcEndpoint === 'prompt') {
      const decision = this.gate?.canUseTokens(identity.subjectId)
      if (decision !== undefined && !decision.ok) {
        return { allow: false, status: 403, reason: decision.reason ?? 'token_quota exceeded' }
      }
    }
    return base
  }
}
