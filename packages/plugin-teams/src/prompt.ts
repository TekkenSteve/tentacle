/**
 * Collaboration-contract renderer (design 10 §5) — the ONE place a Team's
 * data becomes the host prompt the official agent-team runtime executes.
 *
 * Why a renderer and not workspace files (the reference implementation's `teams/template/SOUL.md`):
 * `dsh-persona` reads its text from the PRESET row's config
 * (`Config.prefix`), never from workspace files, so the contract must be
 * rendered into the preset registration. Keeping the discipline text here —
 * one pure function over structured data — means the contract stays data
 * (editable, restorable, exportable) and the wording cannot drift between
 * the workspace copy and the mounted prompt.
 *
 * Inheritance reality: teammates are continuable children that compose from
 * the Lead, so they inherit this same persona prefix. The prompt is
 * therefore written for BOTH audiences: the shared contract sections apply
 * to everyone, and the host-only / member-only sections are explicitly
 * fenced so a spawned member ignores the coordinator duties it never had.
 */
import type { LocalizedText, Team, TeamMember } from './types.js'
import { joinLocalized } from './types.js'

/** One member row as the renderer sees it: the team's roster entry plus the
 * expert facts the service resolves from the persona library. */
export interface HostPromptMember {
  readonly expertId: string
  /** Display name (locales joined by the service). */
  readonly name: string
  /** One-line expert description — the member's persona summary. */
  readonly description: string
  readonly role: LocalizedText
}


function bullets(items: readonly LocalizedText[]): string {
  return items.map((item) => `- ${joinLocalized(item)}`).join('\n')
}

/** The member table: pinned teammate names, persona summary, per-team role. */
function memberTable(members: readonly HostPromptMember[]): string {
  return members
    .map((m) => `- \`${m.expertId}\` — 人格：${m.description}；在本团队的职责：${joinLocalized(m.role)}`)
    .join('\n')
}

function collaborationSection(mode: Team['collaboration']): string {
  return mode === 'auto'
    ? [
      '**自动协作**：成员之间可以直接互相询问、分工协作，任何成员都可以给其他成员发消息。',
      '仍然只有你能创建新成员；收口总结依旧由你负责。',
    ].join('\n')
    : [
      '**普通协作（默认）**：只有你可以往这个房间派工。成员之间可以同步互相询问，',
      '但不能再拉新成员；收口总结由你负责。',
    ].join('\n')
}

/**
 * Render the host prompt for one team. Pure function: the service calls it
 * on every team write and feeds the result into the preset registration
 * (`preset.ts`); tests assert the contract data lands in the right sections.
 */
export function renderHostPrompt(team: Team, members: readonly HostPromptMember[]): string {
  const sections: string[] = []

  sections.push([
    `# 团队契约：${joinLocalized(team.name)}`,
    '',
    '你是这个专家团队的主持人（Lead）。本提示词由全团队共享：主持人读全篇；',
    '通过 `spawn_teammate` 创建的成员只读「团队契约」各节与「成员须知」，',
    '忽略「主持人职责」和「工具用法」两节。',
  ].join('\n'))

  if (team.contract.goal !== undefined) {
    sections.push(['## 团队目标', '', joinLocalized(team.contract.goal)].join('\n'))
  }

  sections.push(['## 成员', '', memberTable(members)].join('\n'))

  if (team.contract.constraints.length > 0) {
    sections.push(['## 共享约束', '', bullets(team.contract.constraints)].join('\n'))
  }

  if (team.contract.delivery !== undefined) {
    sections.push(['## 交付要求', '', joinLocalized(team.contract.delivery)].join('\n'))
  }

  if (team.contract.examples.length > 0) {
    sections.push(['## 示例任务', '', bullets(team.contract.examples)].join('\n'))
  }

  sections.push(['## 协作模式', '', collaborationSection(team.collaboration)].join('\n'))

  sections.push([
    '# 主持人职责（仅主持人；成员忽略本节）',
    '',
    '1. **先消化**：弄清意图、范围、约束、交付物；缺关键信息先问一句，不要空派。',
    '2. **再改写**：派工消息必须是给该成员的任务说明书——目标、范围/不做、交付格式、必要上下文；',
    '   禁止原样粘贴用户原话，也不要广播同一句话给所有成员。',
    '3. **按人定制**：不同成员拿不同任务；用户 `@` 了某位成员时优先派给对方。',
    '4. **寒暄/澄清自己答**：不需要专业产出时不要派工，一两句直接回答。',
    '5. **收口**：成员回来后只判断「要不要再派人 / 是否收工」；收工总结不超过三句，',
    '   不复述成员已完成的全文，不编造成员没有给出的结论。',
  ].join('\n'))

  sections.push([
    '# 工具用法（仅主持人；成员忽略本节）',
    '',
    '- `spawn_teammate`：创建成员。**name 必须用「成员」一节里钉死的成员名**（成员专家 id）；',
    '  description 写该成员的职责首句；初始 prompt 必须以「你是成员 `<id>`，职责：<职责全文>」开头，',
    '  接着给出第一个任务说明书。每个成员只 spawn 一次；spawn 失败不要换名重试，向用户说明并改派。',
    '- `send_message`：给成员派工（异步，发完即返回），或成员间同步询问。',
    '- `wait_agent`：派工后等待成员回话再收口；不要空转轮询。',
    '- `team_task_create` / `team_task_update`：多成员分工时建共享任务板，写明依赖与交付物。',
    '- `list_agents` / `interrupt_agent`：查看花名册 / 打断某个成员的当前回合。',
  ].join('\n'))

  sections.push([
    '# 成员须知（仅成员；主持人忽略本节）',
    '',
    '你是通过 `spawn_teammate` 创建的团队成员，你的启动消息说明了你是谁、职责是什么。',
    '你只做自己的专业工作：不调度、不派工、不代表主持人发言。',
    '「团队契约」各节（目标/约束/交付要求）对你同样有效——按它们的要求交付。',
    '完成后用 `send_message` 把结果发回主持人；需要其他成员配合时可以直接询问对方。',
  ].join('\n'))

  sections.push([
    '# 红线',
    '',
    '- 主持人不是成员本人，不要用成员的口吻冒充发言，也不要替成员重做专业工作。',
    '- 派工消息必须自带目标、约束和上下文：成员看不到本提示词，把他们需要知道的共识摘进消息。',
    '- 成员看不到主持人的工作区文件；需要材料时复制进派工正文。',
  ].join('\n'))

  return sections.join('\n\n')
}

/** The member table rows a renderer call needs, resolved from team + experts. */
export function hostPromptMembers(
  team: Team,
  experts: readonly { readonly id: string; readonly name: string; readonly description: string }[],
): HostPromptMember[] {
  const byId = new Map(experts.map((e) => [e.id, e]))
  return team.members.map((member: TeamMember) => {
    const expert = byId.get(member.expertId)
    return {
      expertId: member.expertId,
      name: expert?.name ?? member.expertId,
      description: expert?.description ?? member.expertId,
      role: member.role,
    }
  })
}
