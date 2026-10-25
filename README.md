# Tentacle

English | [中文](README.zh.md)

Tentacle is a curated plugin bundle for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

The name is the mission. DSH is a single-user local agent; Tentacle gives it arms into the world — identity and isolation for many users, IM channels for eight platforms, an expert library, expert teams, SSO, and whatever else lets it reach people, services and data. Installing one bundle turns the local agent into a multi-user, multi-channel, multi-expert workspace, and the bundle keeps growing.

Scope is open by design: **anything that helps DSH connect is a candidate package.** A new data source, tool or platform integration that makes DSH a first-class citizen somewhere is in scope; re-implementing what DSH already does is not.

**Multi-tenant by design.** Identity, authorization, and per-user isolation are the foundation everything else grows from — not an afterthought.

## What you get

<img src="packages/bundle/assets/experts.png" alt="Expert library with built-in and user experts">

<table>
  <tr>
    <td width="50%">
      <img src="packages/bundle/assets/channels.png" alt="IM channel instances bound to experts">
      <br><sub><b>Channels</b> — Feishu, Telegram, DingTalk, WeCom, QQ, WeChat, Yuanbao, Discord; platform identities become tenant sessions.</sub>
    </td>
    <td width="50%">
      <img src="packages/bundle/assets/data-studio.png" alt="Data Studio with datasets, threads, charts and inspector">
      <br><sub><b>Data Studio</b> — datasets, branchable threads, 39 chart templates, AI refinement and reports.</sub>
    </td>
  </tr>
</table>

- **Identity & tenancy** — login gate, user directory, invites, policies, ReBAC memberships, admin console.
- **Experts & teams** — expert library, shared Agent presets, workspace skills, channel routing, first-class expert teams.
- **Channels** — one gateway for eight IM platforms, with adapters disabled until configured.
- **Data Studio** — imports and connectors, branching analysis threads, native + Flint charts, reports.
- **SSO & isolation** — OIDC browser login, per-user workspaces, authenticated HTTP/RPC/WS proxy.

## Repository layout

```
packages/
  bundle/             dsh-tentacle-bundle — the one package users install
  profile/            profile templates for one-command setup
  plugin-identity/    pluggable identity (local single-user default, login gate, DID)
  plugin-crypto/      shared crypto envelopes (scrypt passwords, token fingerprints)
  plugin-gateway/     authenticating reverse proxy: one resolver→policy→forward pipe for HTTP/RPC/WS
  plugin-tenancy/     tenant/user namespaces: user directory, invites, policies, admin console
  plugin-channels/    IM channel gateway (Feishu, Telegram, DingTalk, WeCom, QQ, WeChat, Yuanbao, Discord)
  plugin-persona/     expert library: templates, workspaces, agent-preset selection
  plugin-teams/       expert teams: team objects, templates and channel bindings, on the official agent-team runtime
  plugin-oidc/        OIDC browser SSO login
examples/             minimal runnable profiles
tests/                e2e: install/enable chain via dsh headless profiles
```

## Status

Early development, usable end to end: every package builds and typechecks cleanly, the unit suite passes, and the e2e suite drives the full install → login → multi-tenant → channel → expert → team path against a real DSH process. APIs and package layout may still change.

## License

MIT
