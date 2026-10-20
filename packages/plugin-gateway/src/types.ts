/**
 * Gateway types. See docs/design/02-access-control.md.
 *
 * The pipeline is `authenticate → policy → forward`, uniform across HTTP,
 * RPC (which is just HTTP under /api), and WebSocket upgrades. Policy is a
 * pure decision function so it can later sink into an in-process middleware
 * if DSH ever ships the official cross-section (#2679).
 */
import type { Identity, SubjectId } from '@tentacle/identity'

export interface GatewaySession {
  readonly token: string
  readonly identity: Identity
  readonly createdAt: number
  readonly expiresAt: number
  /** Abort cascades to every live connection owned by this session. */
  readonly controller: AbortController
}

/** What the policy learns about a request. Never trust client-supplied facts. */
export interface RouteFact {
  readonly channel: 'http' | 'rpc' | 'ws'
  readonly method: string
  readonly path: string
  /** RPC endpoint name when the request targets /api/<endpoint>. */
  readonly rpcEndpoint?: string
  /**
   * Parsed JSON body, attached only for allow-listed RPC endpoints (policy
   * decisions that need arguments, e.g. session.create cwd fences). The
   * gateway buffers the body under a size cap and replays it upstream.
   */
  readonly body?: unknown
}

/**
 * RPC endpoints whose JSON bodies the gateway buffers for policy inspection
 * (kept tiny — buffering has a cost, so this is an explicit allow-list).
 */
export const POLICY_BODY_ENDPOINTS = new Set(['session.create'])

export type PolicyDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly status: number; readonly reason: string }

export interface PermissionPolicy {
  resolve(identity: Identity | undefined, fact: RouteFact): PolicyDecision | Promise<PolicyDecision>
}

export type GatewayMode =
  /** Forward everything unauthenticated — loopback dev mode only. */
  | 'passthrough'
  /** A valid Tentacle session cookie is required for every request. */
  | 'required'

export interface GatewayConfig {
  /** Listen address, `host:port`. Default `127.0.0.1:8180`. */
  listen?: string
  mode?: GatewayMode
  /** scrypt envelope for the bootstrap admin password (mode=required). */
  adminPasswordEnvelope?: string
  /** Session lifetime in hours. Default 72. */
  sessionTtlHours?: number
}

export interface AuthenticatedRequest {
  readonly identity: Identity | undefined
  readonly session: GatewaySession | undefined
}

/**
 * A gateway-local route (design 05 §2.2): answered by a Tentacle plugin at
 * the proxy layer, never forwarded upstream. The handler receives the
 * already-authenticated session (undefined only on `public` routes), so
 * per-user decisions happen with a real identity — no header forging
 * surface into the upstream.
 */
export interface GatewayRoute {
  /** Path prefix, e.g. '/tentacle/api/admin'. Longest prefix wins. */
  readonly prefix: string
  /** Public routes skip session authentication (login, invite signup). */
  readonly public?: boolean
  readonly handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    context: {
      /** Present on authenticated non-public routes. */
      readonly session?: GatewaySession
      /**
       * The caller's identity. In passthrough mode (loopback dev) this is
       * the operator identity with the admin role — anyone who can reach a
       * passthrough gateway is the machine owner by definition.
       */
      readonly identity?: Identity
    },
  ) => void | Promise<void>
}

/**
 * Credential checker for the login endpoint (design 02 §3, 05 §2).
 * plugin-tenancy registers one backed by the user directory; without any
 * registration the gateway falls back to the config admin envelope.
 */
export interface Authenticator {
  /** The user directory this authenticator answers for (e.g. 'tenancy'). */
  readonly kind: string
  /** Verify credentials; undefined means "no such user / wrong password". */
  authenticate(username: string, password: string): Promise<Identity | undefined>
  /** Revoke every session of a subject (wired to the session store). */
  onRevoke?(subjectId: SubjectId): void
}

export type { Identity, SubjectId }
