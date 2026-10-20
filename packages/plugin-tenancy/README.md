# @tentacle/tenancy

English | [中文](README.zh.md)

Tenant × user namespaces for DSH — the Tentacle bundle's multi-user core (design: [docs/design/03-tenancy.md](../../docs/design/03-tenancy.md), [05-admin-users.md](../../docs/design/05-admin-users.md)).

- **User directory**: users with did:key subjectIds, scrypt password envelopes, role (admin/user), login rate limiting (5 failures → 15 min lockout). No default weak passwords — the bootstrap admin comes from explicit config and is seeded only while the directory is empty.
- **Invites**: one-shot codes (sha256 fingerprints only at rest) with TTL and pre-bound roles.
- **Resource policies**: named per-user values (`workspace_root_dir` / `token_quota` / `max_agents`).
- **ReBAC-ready memberships**: relations stored as `(subject, relation, object)` tuples from day one — the M2 PDP upgrade needs no migration.
- **Gateway integration**: registers as the gateway's `Authenticator`; disabling a user revokes their sessions immediately (live connections destroyed).

## Usage

Zero config by default: state lives under `$DSH_HOME/tentacle/tenancy`, and a fresh directory opens a one-shot setup wizard at the gateway (`/tentacle/api/setup` + the login page turns into "create the admin account"). `bootstrapAdmin` remains for headless provisioning:

```yaml
- id: tentacle-tenancy
  name: '@tentacle/tenancy'
  config:
    bootstrapAdmin:
      username: admin
      passwordEnvelope: scrypt$<saltHex>$<hashHex>   # hashPassword() from @tentacle/crypto
```

The domain core (`UserDirectory`) is pure and cordis-free — test it against `MemoryRepo`, persist with `JsonFileRepo` (atomic writes, 0600).

## License

MIT
