# @tentacle/channels

English | [中文](README.zh.md)

IM channels for DSH — **tenant-scoped, runtime-managed channel instances**
(design: [07-channel-admin.md](../../docs/design/07-channel-admin.md); runtime contract: [06-channels.md](../../docs/design/06-channels.md)).

An inbound IM message becomes a normal DSH conversation and the agent's answer streams back. A deliberate design rule: an IM identity is **never** implicitly the agent owner. A platform id must be bound to a real tenant user **per channel instance**, and an unbound sender is refused (with a guidance reply) by default.

## What an instance is

- **A managed resource**: created, edited, enabled/disabled and deleted from the console (the sidebar's **Channels** panel, admin only) or the admin API — no profile edit and no restart.
- **Always routed to an expert** (design 09 §3.3): `expertId` is required on create and can only be rebound, never cleared. The expert decides the session preset/model/permission preset and the **shared workspace** (so channel sessions are not fenced by that user's `workspace_root_dir`). This makes the plugin depend on `@tentacle/persona`: without it there is no routing target.
- **Tenant-scoped**: every read and write is fenced to the acting identity's tenant; an admin may target another tenant explicitly. Same-platform instances are fully independent (own bindings, conversations and cursor).
- **Secrets never live in the record**: the bot token is a per-instance record in the official credential store (`ctx.credentials`); the instance row carries only non-secret config plus an optional deployment `tokenRef`. The API reports `{configured, writable}` and never returns a value.
- **State** (instances, bindings, conversation links, cursors) lives in an official storage domain (`ctx.storageDomain`), validated by zod schemas with atomic read-modify-write.
- **Disable ≠ delete**: disabling stops the adapter and keeps config, bindings and cursor; only removing the instance clears them.

## Runtime

- **Message contract** (`src/types.ts`): a platform-neutral `InboundMessage` plus the `ChannelAdapter` port. `channelId` is the instance id, so two bots of one platform can never share a conversation, a binding or a cursor.
- **Telegram adapter** (`src/adapter/telegram.ts`): Bot API long polling (no public callback), `apiBaseUrl` is configuration, replies split at 4096 characters and fall back from Markdown to plain text.
- **Feishu (Lark) adapter** (`src/adapter/feishu.ts`): webhook push — the service registers a **public** callback route (`/tentacle/hooks/feishu/<instanceId>`, requires the gateway) and the adapter does the platform's own verification itself (`url_verification` challenge echo, optional `verificationToken`, and AES-256-CBC decrypt + `X-Lark-Signature` check when an `encryptKey` is set). Only `im.message.receive_v1` enters the flow; group messages route only when the bot is @'d; events dedupe by `event_id` (in-memory LRU — a restart may replay). Credentials are the `appId`/`appSecret` pair (plus the optional callback keys) in the per-instance credential record; replies split at 4000 characters and use the reply API when the conversation is a thread.
- **DingTalk adapter** (`src/adapter/dingtalk.ts`): Stream WebSocket (`connections/open` + ticket, heartbeat/ACK, exponential backoff with reset on connect); group messages route only when @'d, own bot's output dropped; replies prefer the session webhook. Credentials `clientId`/`clientSecret` (+optional `robotCode`).
- **WeCom adapter** (`src/adapter/wecom.ts`): aibot WebSocket with 30s heartbeats and reconnect backoff; replies prefer the in-band reply frame, falling back to an active Markdown send when no `req_id` is available. Credentials `botId`/`secret`; group callbacks are already @-filtered by the platform.
- **QQ adapter** (`src/adapter/qq.ts`): official gateway WebSocket (`/gateway/bot` → IDENTIFY/RESUME/heartbeat with sequence, op=7 rotate-resume, op=9 forced token refresh, LRU dedupe) with OAuth 401-retry; `appId`/`secret`.
- **WeChat iLink adapter** (`src/adapter/weixin.ts`): 35s HTTP long-poll with a durable opaque `buf` cursor (the offset store is `number | string`), session-expiry (-14) recorded as `failure` with a pause; `accountId`/`token`, `baseUrl` and optional `botUin` in config.
- **Yuanbao adapter** (`src/adapter/yuanbao.ts`): binary WebSocket private protocol (sign-token → auth-bind, msg_id futures, need_ack ACKs, 30s ping, tiered reconnect); start probes only sign-token because the platform allows a single live WS; `appKey`/`appSecret`.

- **Discord adapter** (`src/adapter/discord.ts`): gateway WebSocket v10 (HELLO/IDENTIFY with the minimal intent mask, READY/RESUMED, heartbeat with last sequence, op=7 resume, close-code taxonomy 4004/4013/4014 as fatal); guild messages route only when mentioned (or @everyone); replies split at Discord's 2000-character cap; `token` from the Developer Portal.

- **Quick setup (QR) flows** (`src/provision/`): feishu (official `@larksuiteoapi/node-sdk` registerApp), DingTalk device code, WeCom scode, QQ bind-task with AES-256-GCM, WeChat QR long-poll login, Yuanbao scan-bind. All secrets stay on the host; success creates and enables the instance directly from the host.
- **Router** (`src/router/`): binding lookup by `(channelId, platformId)`, resolve the channel's expert (preset/model/permission/workspace) → `ctx.webhookRuntime.dispatch(...)`. An expert that no longer resolves is answered as a dispatch failure — never silently downgraded to deployment defaults. The runtime returns no session id, so a created session is attributed by canonical workspace path — therefore **one dispatch per workspace is in flight at a time**; the rest queue. Outbound replies aggregate a whole turn and send once at `turn/end`.
- **Deployment seed**: a pre-instances `config.telegram` block (and a legacy `channels.json`) is materialized **once** as instance `telegram-legacy`; a direct token is moved into the credential store. After that the instance table is the source of truth, so an instance deleted in the console never comes back.

## Admin API

Prefix `/tentacle/api/admin/channels`, gated by the `channels` permission key (admin bypasses), tenant-fenced:

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | instances + runtime + credential status + bindings + conversation links |
| GET | `/schema` | per-type form schema (`config` fields + the credential field) |
| GET | `/users?channelId=` | users of that instance's tenant, for binding |
| POST | `/create` · `/update` · `/enable` · `/disable` · `/remove` | instance lifecycle (create → 201) |
| POST | `/test` · `/probe` | probe a saved instance, or a draft config without persisting it |
| POST | `/bind` · `/unbind` | platform identity ↔ tenant user, per instance |

Errors are a fixed vocabulary (`name-taken`, `no-such-channel`, `invalid-config`, `forbidden-tenant`, `credentials-unavailable`, `already-bound`, `channel-tenant-mismatch`, …); no stack traces or internals leak.

## Usage

The console groups channel accounts by platform (icon, account count, add-account), offers search, and the "new channel" action opens a platform catalog before the schema-driven form (single-platform deployments skip the catalog).

The bundle inserts the entry with channels disabled. A deployment may seed one instance from config:

```yaml
- id: tentacle-channels
  config:
    telegram:
      enabled: true
      tokenRef: TELEGRAM_BOT_TOKEN   # secret stays in the credential store
    workspaceRoot: /srv/tentacle-channels   # per-user policies win over this
    agentPreset: standard
```

Everything else is done in the console (or the API above), including creating further instances with their own tokens:

```bash
curl -b cookies.txt -X POST http://127.0.0.1:8180/tentacle/api/admin/channels/create \
  -H 'content-type: application/json' \
  -d '{"channelType":"telegram","name":"support-bot","expertId":"general-assistant","token":"123:ABC"}'

curl -b cookies.txt -X POST http://127.0.0.1:8180/tentacle/api/admin/channels/bind \
  -H 'content-type: application/json' \
  -d '{"channelId":"ch-…","platformId":"1234567","subjectId":"did:key:z6Mk…"}'
```

## Tests

`pnpm test` runs the adapter against a local fake Bot API, the router against injected webhook/agent/session fakes (including the multi-instance isolation guards), the registry/storage/credential domain directly, and the console views in jsdom — no DSH runtime is started.

## License

MIT
