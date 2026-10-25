# @tentacle/bundle (dsh-tentacle-bundle)

English | [中文](README.zh.md)

The one package users install. It aggregates all Tentacle plugins with tuned defaults via its bundle patch layer — enable it and DSH transforms.

```bash
dsh plugin --profile web add dsh-tentacle-bundle
```

The patch layer inserts, in dependency order:

| Entry | Package | Role |
|---|---|---|
| `tentacle-identity` | `@tentacle/identity` | Pluggable identity (local zero-config default) |
| `tentacle-gateway` | `@tentacle/gateway` | Authenticating reverse proxy (passthrough by default) |
| `tentacle-tenancy` | `@tentacle/tenancy` | User directory, invites, resource policies, ReBAC memberships |
| `tentacle-persona` | `@tentacle/persona` | Expert library — experts select a shared Agent preset and own workspace skills/routing/channels |
| `tentacle-teams` | `@tentacle/teams` | First-class expert teams — roster + collaboration contract mounted as one managed team preset |
| `tentacle-data` | `@tentacle/data` | Data Studio — imported datasets, branchable data threads and chart cards |
| `tentacle-channels` | `@tentacle/channels` | IM channels (Telegram) — bound platform identities become tenant sessions, replies stream back. Adapters ship **disabled** |

Override any entry's config in your profile's `cordis.patch.yml` (config replaces wholesale — restate the fields you keep).

Design: [docs/design/04-architecture.md](../../docs/design/04-architecture.md).

## License

MIT
