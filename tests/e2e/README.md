# Tentacle e2e 测试方案

目标：验证"安装/启用链路"——用户从干净状态到 bundle 生效的全过程。

## 环境

- 使用独立 `$DSH_HOME`（如 `tests/.tmp/dsh-home`），不触碰用户真实 `~/.dsh`。
- 用 `dsh headless` profile 跑自动化（无浏览器依赖），web profile 的验证另配 Playwright（二期）。

## 链路用例（一期）

1. **初始化**：`dsh --profile tentacle-e2e --from-default-profile web`。✅ 已实现（`e2e.sh` 步骤 1）
2. **安装**：`dsh plugin --profile tentacle-e2e add <本地包路径>`（leaf 插件 + bundle）。✅ 步骤 2
   - 实证发现：`dsh plugin add` 非 bundle 包只装依赖不进组合树；**bundle 包的 patch 层才是入口**。
3. **组合验证**：`--dump-config` 断言 Tentacle 条目出现在 `== @tentacle/bundle` 层。✅ 步骤 3
4. **启动冒烟**：打补丁换端口启动，断言 gateway 监听、identity 自动 provisioning 出 did:key、gateway 转发 200、直连 loopback 无 token 401。✅ 步骤 4-5
   - 实证发现：patch 的 config 是**整体替换**（webserver 漏写 host 导致启动失败）；cookie authority 绑定要求上游 Host 头带端口（e2e 抓到的真 bug）。
5. **隔离冒烟**（待 M1）：建两个用户，A 的会话列表对 B 不可见；B 直连 loopback 无 token 被拒。

运行：`pnpm test:e2e`（即 `bash tests/e2e/e2e.sh`）。

## 可视化检查（客户端界面）

`e2e.sh` 只能证明 client bundle **被提供**（`__DSH_BOOT__` 有条目、`/plugins/` 能取到）；证明它**能运行、长什么样**需要浏览器。`shot.mjs` 用无头 Chrome + 原始 CDP（本仓没有 Playwright）完成这件事，并把截图与页面文本落盘，供人工复核或对比改动前后。

```bash
# 1. 起一个可访问的实例（独立 DSH_HOME + 已装 bundle 的 profile；见 e2e.sh 步骤 1-2）
#    patch：webserver 换端口 + tentacle-gateway listen 127.0.0.1:18190 mode required
#    + tentacle-channels seed 一个 telegram 实例（apiBaseUrl 指向 tests/e2e/fake-bot-api.mjs）
# 2. 建管理员（首次）：
curl -s -X POST http://127.0.0.1:18190/tentacle/api/setup \
  -H 'content-type: application/json' -d '{"username":"admin","password":"e2e-admin-secret"}'
# 3. 截图（自行登录、注入会话 cookie、关掉首次引导弹窗、点开指定面板）
node tests/e2e/shot.mjs --url http://127.0.0.1:18190 --user admin --password e2e-admin-secret \
  --click 频道 --out tests/.tmp/shot/panel.png --text-out tests/.tmp/shot/panel.txt
```

实证要点：`/tmp` 在命令沙箱里是**每次调用独立的 tmpfs**，截图与日志必须写到工作区内（如 `tests/.tmp/`）；无头 Chrome 与 `dsh` 都要以托管后台任务启动，否则随父 shell 退出被杀。

## 非目标

- 不在 e2e 里测业务功能（那是各包单测的职责）。
- 不测官方未发布的横截面（不存在的东西测不了）。
