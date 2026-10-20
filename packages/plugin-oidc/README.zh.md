# @tentacle/oidc

tentacle 网关的 OIDC 浏览器 SSO 登录（设计 01 D3）：用户名/密码之外的第二条登录路径。协议由官方 `openid-client` 承担（发现、授权码 + PKCE、签名 ID 令牌校验）；登录成功后经网关自身的会话库签发会话——与内置登录同 cookie、同吊销级联。

## 工作方式

- `GET /tentacle/auth/oidc/start` → 303 跳到 IdP，附带全新 PKCE 事务（state/verifier/nonce 只存 host 内存，绑定 HttpOnly cookie，10 分钟 TTL，容量封顶）。
- `GET /tentacle/auth/oidc/callback` → 对签名 ID 令牌校验 PKCE + state + nonce，随后签发会话并跳回 `/`。
- 身份映射：`(iss, sub)` 稳定映射到非密钥 DID `did:oidc:<sha256(iss|sub)[:40]>`——刻意不做合成 `did:key`（背后没有密钥对）。租户/角色来自配置（默认 `local` / `member`），或配置的租户 claim。
- 未配置（无 `issuer`/`clientId`）时插件保持惰性：不注册路由、不失败启动——没有 SSO 网关也完全可用。配置了但不可达的 issuer 在启动时大声失败。

## 启用

bundle 以惰性方式插入本插件。补丁该条目的 config 即可启用：

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

完整流程见 `tests/oidc.test.ts`（对真实 HTTP 假 IdP 验证，含 RS256 签名 ID 令牌与 JWKS 端点）。
