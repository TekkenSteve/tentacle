# @tentacle/identity

[English](README.md) | 中文

DeepSeek Harness 的可插拔身份层——Tentacle 插件包的地基。

- **subjectId**：每个身份是一对 Ed25519 密钥，公钥派生出自包含的 `did:key` subjectId，无需网络解析。
- **provider 注册表**：内置 `LocalProvider` 零配置默认（首次启动自动配发，0600 落盘）。第三方 provider 以独立包注册：`inject: ['tentacleIdentity']` + `ctx.tentacleIdentity.registerProvider()`。
- **秘密不出 Host**：跨边界只传公开 `Identity` DTO；签名能力永不暴露为 Remote。

设计文档：[docs/design/01-identity.md](../../docs/design/01-identity.md)。

## 用法

```yaml
- id: tentacle-identity
  name: '@tentacle/identity'
  config:
    stateRoot: /path/to/state   # 默认：<cwd>/.tentacle/identity
    tenant: local               # 默认租户
```

```ts
const identity = await ctx.tentacleIdentity.current()
// { subjectId: 'did:key:z6Mk…', tenant: 'local', createdAt: … }
```

## 许可证

MIT
