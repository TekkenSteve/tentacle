# @tentacle/tenancy

[English](README.md) | 中文

DSH 的租户 × 用户命名空间——Tentacle 插件包的多用户核心（设计：[docs/design/03-tenancy.md](../../docs/design/03-tenancy.md)、[05-admin-users.md](../../docs/design/05-admin-users.md)）。

- **用户目录**：用户持有 did:key subjectId、scrypt 密码信封、角色（admin/user）、登录限速（5 次失败锁 15 分钟）。无默认弱密码——bootstrap admin 来自显式配置，且仅在目录为空时播种。
- **邀请**：一次性邀请码（只存 sha256 指纹），带 TTL 与预绑定角色。
- **资源策略**：按用户的命名策略（`workspace_root_dir` / `token_quota` / `max_agents`）。
- **ReBAC-ready**：memberships 从第一天按 `(subject, relation, object)` tuple 落库——二期升级 ReBAC 引擎零迁移。
- **Gateway 集成**：注册为 gateway 的 `Authenticator`；禁用用户立即吊销其会话（活动连接当场销毁）。

## 用法

默认零配置：状态落在 `$DSH_HOME/tentacle/tenancy`，目录为空时网关开放一次性 setup 向导（`/tentacle/api/setup`，登录页自动变为"创建 admin 账号"）。headless 预置可用 `bootstrapAdmin`：

```yaml
- id: tentacle-tenancy
  name: '@tentacle/tenancy'
  config:
    bootstrapAdmin:
      username: admin
      passwordEnvelope: scrypt$<saltHex>$<hashHex>   # 用 @tentacle/crypto 的 hashPassword() 生成
```

领域核心（`UserDirectory`）是纯实现、零 cordis 依赖——用 `MemoryRepo` 单测，用 `JsonFileRepo`（原子写，0600）持久化。

## 许可证

MIT
