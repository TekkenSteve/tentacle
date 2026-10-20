# @tentacle/gateway

English | [中文](README.zh.md)

Authenticating reverse proxy in front of the loopback DSH control plane — the Tentacle bundle's access cross-section.

DSH stays bound to loopback with its native launch-token fence intact. The gateway is the only external entry: it exchanges the process launch token for the upstream `dsh-auth-*` cookie once (via the official `ctx.connection.authenticatedUrl`), then every request passes one uniform pipeline:

```
authenticate (Tentacle session cookie) → permission policy → opaque forward
```

HTTP, RPC (`/api/*`), and WebSocket upgrades all share the same pipe — the cross-section that [discussion #2679](https://github.com/deepseek-ai/deepseek-harness/discussions/2679) asks for, implemented at the network boundary.

- **Modes**: `passthrough` (loopback dev) / `required` (session cookie; admin login at `/tentacle/api/login`).
- **Policy**: default deny-list guards the #853 privileged surface (`/api/commands/execute`, `/api/respond`, `session.export`, `settings.*`, `credentials.*`, …); replaceable via `ctx.tentacleGateway.registerPolicy()`.
- **Sessions**: sha256 fingerprints only, TTL, AbortSignal-cascaded revocation destroys live connections immediately.
- **Hygiene**: outbound header allow-list (client cookies/auth/x-* stripped), CSRF fence on state-changing requests, handshake-only timeouts.

Design: [docs/design/02-access-control.md](../../docs/design/02-access-control.md).

## Usage

```yaml
- id: tentacle-gateway
  name: '@tentacle/gateway'
  config:
    listen: 127.0.0.1:8180
    mode: required   # first visit opens the one-shot setup wizard (with @tentacle/tenancy)
```

No config files or CLI envelope minting needed: with `@tentacle/tenancy` mounted, a fresh install serves a setup wizard at the gateway address — create the admin account in the browser, once, and the wizard closes forever. `adminPasswordEnvelope` remains available for headless/CI provisioning.

## License

MIT
