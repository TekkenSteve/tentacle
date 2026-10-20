/**
 * Permission policies (design 02 §5).
 *
 * `defaultPolicy` is the M1 baseline: authenticated users may do everything
 * EXCEPT the privileged surface identified by the #853 report — permission
 * flips, approval answering, session export, settings/credentials, plugin
 * management. Admin is a role on the identity and bypasses the deny-list.
 *
 * The deny-list is deliberately small and explicit; tenancy-aware narrowing
 * (cwd fences etc.) lands with plugin-tenancy registering its own policy.
 */
import type { Identity, PermissionPolicy, PolicyDecision, RouteFact } from './types.js'

const ALLOW: PolicyDecision = { allow: true }
const deny = (reason: string): PolicyDecision => ({ allow: false, status: 403, reason })

/**
 * RPC endpoints ordinary users must never reach (design 02 §5, sourced from
 * the #853 high-risk surface), each mapped to the Tentacle permission key
 * that unlocks it. An entry WITHOUT a key is an escalation path that is
 * never delegable — only the admin bypass reaches it.
 */
interface PrivilegedEndpoint {
  readonly prefix: string
  /** Tentacle permission key (packages/plugin-tenancy permissions.ts). */
  readonly permission?: string
  /** Why it is privileged — kept next to the rule so reviews stay honest. */
  readonly reason: string
}

const PRIVILEGED_RPC: readonly PrivilegedEndpoint[] = [
  { prefix: 'commands/execute', reason: 'permission-mode escalation (/permission danger-full-access)' },
  { prefix: 'respond', reason: 'answers approval prompts — self-approval of sandbox escalation' },
  { prefix: 'session.export', permission: 'sessions', reason: 'full session-log download' },
  { prefix: 'dynamicCordisRunner/', permission: 'plugins', reason: 'dynamic plugin execution' },
  { prefix: 'settings.', permission: 'settings', reason: 'privileged settings writes' },
  { prefix: 'credentials.', permission: 'credentials', reason: 'credential store access' },
  { prefix: 'llm.discoverModels', permission: 'credentials', reason: 'sends stored provider keys to caller-chosen URLs' },
  { prefix: 'host.openPath', reason: 'opens paths on the host' },
  { prefix: 'plugin_manager', permission: 'plugins', reason: 'plugin install/remove' },
]

/** Match a request path against the privileged table; undefined when unrelated. */
export function privilegedRule(path: string): PrivilegedEndpoint | undefined {
  const endpoint = path.replace(/^\/api\//, '')
  return PRIVILEGED_RPC.find((rule) => endpoint === rule.prefix || endpoint.startsWith(rule.prefix))
}

/** True when the endpoint is on the privileged surface at all. */
export function isPrivilegedRpc(path: string): boolean {
  return privilegedRule(path) !== undefined
}

export class DefaultPolicy implements PermissionPolicy {
  resolve(identity: Identity | undefined, fact: RouteFact): PolicyDecision {
    if (!identity) return deny('authentication required')
    if (fact.channel !== 'rpc') return ALLOW
    const rule = privilegedRule(fact.path)
    if (!rule) return ALLOW
    // D1: authorization consults roles + effective permissions, never handles.
    if (identity.roles?.includes('admin')) return ALLOW
    if (rule.permission !== undefined && identity.permissions?.includes(rule.permission)) return ALLOW
    return deny(`privileged endpoint: ${fact.path}`)
  }
}
