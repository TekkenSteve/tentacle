# @tentacle/persona

[English](README.md) | 中文

DSH 的专家库——Tentacle 插件包的人格/专家体验层（设计：[docs/mapping.md §3](../../docs/mapping.md)、[04-architecture.md](../../docs/design/04-architecture.md)）。

两层结构（设计 09）：**模板**是随包发布的目录（`templates/<id>/manifest.json` + 种子文件），**专家**是从模板（或空白）创建的用户实例。创建实例时把种子文件复制进其工作区并快照 manifest；模板升级不触碰已有实例（脱钩规则）。

专家是**组合配置单元**，不是预设：它**选择一个**已注册的 Agent 预设作为能力层（工具、skills provider、MCP、团队、预设人格），自身拥有身份、工作区（`.dsh/skills` 所在）、模型路由、权限档与频道绑定。多个专家可以共享同一个预设；专家既不派生也不注册预设。频道通过 `resolveForSession()` 解析实例，用所选预设 id、模型与**一个共享工作区**（`agents/<id>/workspace`）创建会话。

- **ExpertLibrary**：纯领域核心、零 cordis 依赖——`{ id, name, description, icon?, agentPreset, builtin }` 行的 CRUD。用 `MemoryRepo` 单测，用 `JsonFileRepo`（原子写，0600；默认状态根 `$DSH_HOME/tentacle/persona`）持久化。
- **内置种子**：4 个起步专家（通用助手 / 运维工程师 / 代码评审员 / 翻译官），名称、描述与种子技能双语；每个专家选择模板的 `agent_preset`（默认 `standard`）。播种每个状态根仅发生一次——此后库归用户所有，升级永不覆盖其修改。
- **内置保护**：内置专家不可删除（409）；身份字段固定，预设选择与路由可改。
- **Admin API**：`/tentacle/api/admin/experts`（GET 列表、POST 创建、POST `/update`、POST `/default`、POST `/remove`、GET `/presets`、GET/POST `/skills…`），经 gateway 的 `registerRoute` 挂载并做 admin 角色校验。gateway 是可选依赖：缺席时库照常，仅 REST 面不注册。
- **专家面板**：全局主面板（`main` + `sidebar.pannellist`，admin 专属），入口与「频道」并列——Agency Agents 式固定高度卡片网格（44px 图标、模板/预设 pill、三行描述、模型/权限/技能/频道事实、整宽操作条）、「我的专家 / 模板库」两页签、详情抽屉分页（概览 / 工作区技能 / 绑定频道 / 所选预设内联组合）、创建/编辑（**Agent 预设下拉** + **模型/权限下拉**，分别读官方 `session/modelCatalog` 与 `permissionPresets/catalog`）/模板副本/删除（被频道引用时 409）；卡片/表格两种视图（选择持久化）；「管理频道 / 新建频道」直接切到频道面板并把该专家设为当前过滤（新建时表单预选该专家）。中英双语。

## 用法

默认零配置，bundle 已代为插入；单独安装：

```yaml
- id: tentacle-persona
  name: '@tentacle/persona'
```

测试可经配置注入假 AgentPreset 类（`agentPreset`），在无 preset registry 的情况下断言挂载/卸载行为。

## 与官方 preset UI 的边界

官方 `dsh-client-ui-agent-preset` 设置分区已经负责 preset 的**读**侧：列出所有已注册 preset（包括本包挂载的）、选择新任务的默认 preset、查看某个 preset 的组合、以及会话内切换。本包**刻意不重新实现**这些——在这里再画一份 roster、默认选择器或组合查看器，都会变成与官方漂移的重复面。

本包负责官方 UI 没有的**写**侧：专家 CRUD（每个专家挂载为一个带 `dsh-persona` 前缀的官方 preset）、双语名称/描述、内置种子库，以及多租户准入所需的可见性（**待落地**：`Expert` 目前没有 tenant/owner，见 09 §6-C）。有疑问时扩展写路径，让官方 roster 去渲染。

## 路由值与删除保护（设计 09）

- `defaultExpertId`：`general-assistant`（不存在时取第一个 builtin / 第一个实例）。channels 用它迁移历史无绑定行。
- `resolveForSession(expertId)`：频道会话的 preset/model/权限/工作区来源；未知 id 返回 `undefined`，由 channels 视为派发失败。
- `registerExpertRemovalGuard(guard)`：持有 `expertId` 引用的插件（channels）注册删除 veto；被引用的专家删除返回 409 `expert-in-use`，不是级联删除。

## 许可证

MIT
