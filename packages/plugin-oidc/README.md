# @tentacle/oidc

OIDC browser SSO login for the tentacle gateway (design 01 D3): a second login
path beside username/password. The OFFICIAL `openid-client` library owns the
protocol (discovery, authorization-code + PKCE, signed-ID-token verification);
a successful login mints a gateway session through the gateway's own session
store — same cookie, same revocation cascade as the built-in login.

## How it works

- `GET /tentacle/auth/oidc/start` → 303 to the IdP with a fresh PKCE
  transaction (state/verifier/nonce in host memory, bound to an HttpOnly
  cookie, 10-minute TTL, capped table).
- `GET /tentacle/auth/oidc/callback` → verifies PKCE + state + nonce against
  the signed ID token, then mints the session and redirects to `/`.
- Identity: `(iss, sub)` maps to the stable, non-key DID
  `did:oidc:<sha256(iss|sub)[:40]>` — deliberately not a synthesized
  `did:key` (there is no keypair behind it). Tenant/role come from config
  (defaults `local` / `member`), or a configured tenant claim.
- Unconfigured (no `issuer`/`clientId`) the plugin stays INERT: no routes, no
  boot failure — the gateway is fully usable without SSO. A configured-but-
  unreachable issuer fails loudly at boot.

## Activation

The bundle inserts the plugin inert. Patch the entry's config to activate:

```yaml
- id: tentacle-oidc
  name: '@tentacle/oidc'
  config:
    issuer: https://accounts.example.com
    clientId: tentacle
    clientSecret: ...
    # tenantClaim: tentacle_tenant   # optional claim → tenant
    # role: member                   # default
    # allowInsecureIssuer: false     # plain-HTTP issuers opt in explicitly
```

See `tests/oidc.test.ts` for the full flow against a real-HTTP fake IdP
(RS256-signed ID tokens and a JWKS endpoint included).
