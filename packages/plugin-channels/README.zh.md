# @tentacle/channels

[English](README.md) | 中文

DSH 的 IM 频道层——**租户级、可运行时管理的频道实例**
（设计：[07-channel-admin.md](../../docs/design/07-channel-admin.md)；运行时契约：[06-channels.md](../../docs/design/06-channels.md)）。

入站 IM 消息会变成一次正常的 DSH 会话，agent 的回答再流回平台。一个刻意为之的设计原则：IM 身份**绝不**隐式等于 agent owner。平台 id 必须**按频道实例**绑定到真实的租户用户，未绑定的发送者默认被拒绝（并回复一条指引）。

## 什么是「频道实例」

- **可管理的资源**：在控制台（侧栏「**频道**」面板，仅 admin）或管理 API 上创建/编辑/启停/删除——不需要改 profile，也不需要重启。
- **必须路由到一个专家**（设计 09 §3.3）：`expertId` 创建时必填、更新只能改绑不能清空。专家决定会话的 preset/model/权限档与**共享工作区**（所以频道会话不受该用户 `workspace_root_dir` 围栏约束）。注意这让本插件硬依赖 `@tentacle/persona`：没有 persona 就不存在可路由的目标。
- **租户级**：所有读写都按调用者身份的租户围栏；admin 可显式指定其他租户。同平台的多个实例完全独立（各自的绑定、会话、游标）。
- **秘密不进记录**：bot token 是官方凭据存储里的一条**实例 record**（`ctx.credentials`）；实例行只有非密配置与可选的部署 `tokenRef`。API 只报 `{configured, writable}`，永不返回值。
- **持久化**走官方 storage domain（`ctx.storageDomain`），zod schema 校验 + 原子 read-modify-write。
- **停用 ≠ 删除**：停用只停适配器，保留配置/绑定/游标；只有删除实例才清理它们。

## 运行时

- **消息契约**（`src/types.ts`）：平台无关的 `InboundMessage` 与 `ChannelAdapter` 端口。`channelId` 就是实例 id，因此同一平台的两个 bot 不可能共享会话、绑定或游标。
- **Telegram 适配器**（`src/adapter/telegram.ts`）：Bot API 长轮询（无需公网回调），`apiBaseUrl` 是配置；回复按 4096 字符分段，Markdown 被拒时回退纯文本。
- **飞书（Lark）适配器**（`src/adapter/feishu.ts`）：webhook 推送——service 注册一条 **public** 回调路由（`/tentacle/hooks/feishu/<instanceId>`，依赖 gateway），平台侧的验证全部在适配器内完成（`url_verification` 挑战回显、可选 `verificationToken` 校验、配置了 `encryptKey` 时的 AES-256-CBC 解密 + `X-Lark-Signature` 验签）。只有 `im.message.receive_v1` 进入消息流；群消息只在 @机器人 时路由；事件按 `event_id` 去重（内存 LRU——重启可能重放，属已知取舍）。凭据是 `appId`/`appSecret` 一对（外加可选回调密钥），存实例级凭据 record；回复按 4000 字符分段，话题（thread）会话走 reply API 落回话题内。
- **钉钉适配器**（`src/adapter/dingtalk.ts`）：Stream WebSocket（`connections/open`+ticket 握手、心跳/ACK、断线指数退避并归零）；群消息只在 @机器人 时路由，丢弃自身回环；回复优先 sessionWebhook。凭据 `clientId`/`clientSecret`（可选 `robotCode`）。
- **企微适配器**（`src/adapter/wecom.ts`）：aibot WebSocket（30s 心跳、指数退避重连）；回复优先回复帧，无 `req_id` 时主动 Markdown 发送。凭据 `botId`/`secret`；群回调平台已按 @ 过滤。
- **QQ 适配器**（`src/adapter/qq.ts`）：官方网关 WebSocket（`/gateway/bot` 取址、IDENTIFY/RESUME/心跳序号、op=7 轮换 RESUME、op=9 强刷 token、LRU 去重）；OAuth 401 重试一次；凭据 `appId`/`secret`。
- **微信 iLink 适配器**（`src/adapter/weixin.ts`）：35s HTTP 长轮询，不透明 `buf` 游标持久化（offset store 为 `number | string`）；会话过期（-14）记 `failure` 并暂停重试；凭据 `accountId`/`token`，配置 `baseUrl` 与可选 `botUin`。
- **元宝适配器**（`src/adapter/yuanbao.ts`）：二进制 WebSocket 私有协议（sign-token→auth-bind、msg_id future、need_ack ACK、30s ping、分档重连）；探活只验 sign-token（平台只允许一条有效 WS）；凭据 `appKey`/`appSecret`。

- **Discord 适配器**（`src/adapter/discord.ts`）：网关 WebSocket v10（HELLO/最小 intent 掩码 IDENTIFY、READY/RESUMED、带序号心跳、op=7 恢复、4004/4013/4014 致命 close 码）；群消息只在被 @（或 @everyone）时路由；回复按 Discord 的 2000 字符上限分段；凭据为开发者后台 Bot Token。

- **扫码快捷配置**（`src/provision/`）：飞书（官方 `@larksuiteoapi/node-sdk` 的 registerApp）、钉钉设备码、企微 scode、QQ 绑定任务（AES-256-GCM）、微信扫码长轮询登录、元宝扫码绑定。秘密全程不出 host，成功后由 host 直接创建并启用实例。
- **Router**（`src/router/`）：按 `(channelId, platformId)` 查绑定 → 用频道的专家解析出 preset/model/权限/工作区 → `ctx.webhookRuntime.dispatch(...)`。专家解析失败按派发失败回复（绝不静默回落部署默认）。runtime 不返回 sessionId，因此新建会话只能按规范化工作区路径回关联——所以**同一 workspace 同时只允许一个 in-flight 派发**，其余排队。出站把整轮聚合后在 `turn/end` 一次发回。
- **部署种子**：旧版 `config.telegram`（以及旧的 `channels.json`）只在首次 boot 时 materialize 成实例 `telegram-legacy`，直填 token 会被移进凭据 store；此后以实例表为准——在控制台里删掉的实例不会在重启后复活。

## 管理 API

前缀 `/tentacle/api/admin/channels`，权限 key 为 `channels`（admin 绕过），带租户围栏：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` | 实例 + 运行态 + 凭据状态 + 绑定 + 会话关联 |
| GET | `/schema` | 每类型的表单 schema（`config` 字段 + 凭据字段） |
| GET | `/users?channelId=` | 该实例租户内可绑定的用户 |
| POST | `/create` · `/update` · `/enable` · `/disable` · `/remove` | 实例生命周期（create → 201） |
| POST | `/test` · `/probe` | 探测已存实例，或探测**不落库**的草稿配置 |
| POST | `/bind` · `/unbind` | 按实例绑定/解绑平台身份 ↔ 租户用户 |

错误是固定词表（`name-taken`、`no-such-channel`、`invalid-config`、`forbidden-tenant`、`credentials-unavailable`、`already-bound`、`channel-tenant-mismatch` 等），不泄漏堆栈或内部细节。

## 用法

控制台按平台分组账号（图标/账号数/添加账号），支持搜索；「新建频道」先打开平台目录，再进入该平台的 schema 表单（单平台部署直接进表单）。

bundle 插入的条目默认关闭。部署方可以用 config 预置一个实例：

```yaml
- id: tentacle-channels
  config:
    telegram:
      enabled: true
      tokenRef: TELEGRAM_BOT_TOKEN   # 秘密留在凭据 store
    workspaceRoot: /srv/tentacle-channels   # 每用户策略优先于此
    agentPreset: standard
```

其余都在控制台（或上面的 API）完成，包括创建更多带各自 token 的实例：

```bash
curl -b cookies.txt -X POST http://127.0.0.1:8180/tentacle/api/admin/channels/create \
  -H 'content-type: application/json' \
  -d '{"channelType":"telegram","name":"support-bot","expertId":"general-assistant","token":"123:ABC"}'

curl -b cookies.txt -X POST http://127.0.0.1:8180/tentacle/api/admin/channels/bind \
  -H 'content-type: application/json' \
  -d '{"channelId":"ch-…","platformId":"1234567","subjectId":"did:key:z6Mk…"}'
```

## 测试

`pnpm test` 会用本地假 Bot API 跑适配器、用注入的 webhook/agent/session 假件跑 router（含多实例隔离守卫）、直接跑 registry/存储/凭据域，并在 jsdom 里跑控制台视图——不启动 DSH 运行时。

## 许可证

MIT
