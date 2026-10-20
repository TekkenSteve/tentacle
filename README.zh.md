# Tentacle

[English](README.md) | 中文

Tentacle 是为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 打造的插件包。

名字就是定位。DSH 是一个单用户本地 agent，Tentacle 帮它把触手伸向外部世界——多用户身份与隔离、8 个平台的 IM 频道、专家库、专家团队、SSO，以及之后一切能让它触达更多人、服务与数据的能力。安装一个包，单用户本地 agent 就变成多用户、多频道、多专家的协作工作台，并且这个包会持续长出新的触手。

**凡是能让 DSH 连接更多的，都是这个项目的目标。** 把某个数据源、工具或平台变成 DSH 一等公民的新插件都在范围内；重复实现 DSH 自身已有的能力则不在。

**多租户优先设计。** 身份、鉴权、按用户隔离是地基，其他一切从这里长出来——而非事后补丁。

## 仓库结构

```
packages/
  bundle/             dsh-tentacle-bundle —— 用户唯一直接安装的包
  profile/            profile 模板，一键初始化
  plugin-identity/    可插拔身份（本地单用户默认、登录门、DID）
  plugin-crypto/      共享密码学信封（scrypt 密码、token 指纹）
  plugin-gateway/     认证反向代理：HTTP/RPC/WS 三通道统一的 resolver→policy→forward 管道
  plugin-tenancy/     租户/用户命名空间：用户目录、邀请、资源策略、管理控制台
  plugin-channels/    IM 频道网关（飞书、Telegram、钉钉、企微、QQ、微信、元宝、Discord）
  plugin-persona/     专家库：模板、工作区、Agent 预设选择
  plugin-teams/       专家团队：团队对象、模板与频道绑定，运行在官方 agent-team runtime 上
  plugin-oidc/        OIDC 浏览器 SSO 登录
examples/             最小可运行 profile 示例
tests/                e2e：用 dsh headless profile 验证安装/启用链路
```

## 状态

早期开发阶段，端到端可用：所有包构建与 typecheck 全绿，单测通过，e2e 在真实 DSH 进程上跑通「安装 → 登录 → 多租户 → 频道 → 专家 → 团队」全链路。API 与包结构仍可能调整。

## 许可证

MIT
