# @tentacle/gateway

[English](README.md) | 中文

DSH loopback 控制面之前的认证反向代理——Tentacle 插件包的鉴权横截面。

DSH 保持 loopback 绑定、原生 launch token 围栏不动。Gateway 是唯一外部入口：启动时通过官方 `ctx.connection.authenticatedUrl` 把进程 launch token 一次性换成上游 `dsh-auth-*` cookie 持有在内存里，之后每个请求走统一管道：

```
认证（Tentacle 会话 cookie）→ 权限策略 → 透明转发
```

HTTP、RPC（`/api/*`）、WebSocket upgrade 共用同一条管道——这正是 [discussion #2679](https://github.com/deepseek-ai/deepseek-harness/discussions/2679) 诉求的横截面，只是实现位置在网络边界（DSH 进程内没有可挂的钩子）。

- **模式**：`passthrough`（本地开发直通）/ `required`（必须持会话 cookie；`/tentacle/api/login` 管理员登录）。
- **策略**：默认拒绝清单守住 #853 高危面（`/api/commands/execute`、`/api/respond`、`session.export`、`settings.*`、`credentials.*` 等）；可用 `ctx.tentacleGateway.registerPolicy()` 整体替换。
- **会话**：只存 sha256 指纹、TTL、AbortSignal 级联吊销——吊销立即销毁该会话的全部活动连接。
- **卫生**：出站头白名单（剥掉客户端 cookie/auth/x-*）、写操作 CSRF 围栏、只给握手加超时（流不设总时长）。

设计文档：[docs/design/02-access-control.md](../../docs/design/02-access-control.md)。

## 用法

```yaml
- id: tentacle-gateway
  name: '@tentacle/gateway'
  config:
    listen: 127.0.0.1:8180
    mode: required   # 首次访问打开一次性 setup 向导（配合 @tentacle/tenancy）
```

无需改配置文件、无需命令行造信封：挂载 `@tentacle/tenancy` 后，全新安装的网关地址会提供首启向导——在浏览器里创建 admin 账号，一次完成，向导随即永久关闭。headless/CI 场景仍可用 `adminPasswordEnvelope` 预置。

## 许可证

MIT
