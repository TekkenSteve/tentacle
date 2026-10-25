# @tentacle/bundle (dsh-tentacle-bundle)

English | [中文](README.zh.md)

The one package users install. It aggregates all Tentacle plugins with tuned defaults via its bundle patch layer — enable it and DSH transforms.

```bash
dsh plugin --profile web add dsh-tentacle-bundle
```

## What you get

<img src="assets/experts.png" alt="Expert library: built-in and user experts">

<table>
  <tr>
    <td width="50%">
      <img src="assets/channels.png" alt="Channel instances bound to experts">
      <br><sub><b>Channels</b> — eight IM platforms, platform identities become tenant sessions.</sub>
    </td>
    <td width="50%">
      <img src="assets/data-studio.png" alt="Data Studio: datasets, threads and charts">
      <br><sub><b>Data Studio</b> — datasets, branchable threads, charts and reports.</sub>
    </td>
  </tr>
</table>

The patch layer inserts, in dependency order:

| Entry | Package | Role |
|---|---|---|
| `tentacle-identity` | `@tentacle/identity` | Pluggable identity (local zero-config default) |
| `tentacle-gateway` | `@tentacle/gateway` | Authenticating reverse proxy (passthrough by default) |
| `tentacle-tenancy` | `@tentacle/tenancy` | User directory, invites, resource policies, ReBAC memberships |
| `tentacle-persona` | `@tentacle/persona` | Expert library — experts select a shared Agent preset and own workspace skills/routing/channels |
| `tentacle-teams` | `@tentacle/teams` | First-class expert teams — roster + collaboration contract mounted as one managed team preset |
| `tentacle-data` | `@tentacle/data` | Data Studio — imported datasets, branchable data threads and chart cards |
| `tentacle-channels` | `@tentacle/channels` | IM channels (Feishu, Telegram, DingTalk, WeCom, QQ, WeChat, Yuanbao, Discord) — bound platform identities become tenant sessions. Adapters ship **disabled** |

Override any entry's config in your profile's `cordis.patch.yml` (config replaces wholesale — restate the fields you keep).

Design: [docs/design/04-architecture.md](../../docs/design/04-architecture.md).

## License

MIT
