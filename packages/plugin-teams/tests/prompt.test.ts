/**
 * Host-prompt renderer tests (design 10 §5): the contract data must land in
 * the right sections, the member table must pin teammate names, and the
 * host-only discipline must be fenced so an inherited teammate ignores it.
 */
import { describe, expect, it } from 'vitest'
import { emptyTeamContract } from '../src/types.js'
import type { Team } from '../src/types.js'
import { hostPromptMembers, renderHostPrompt } from '../src/prompt.js'

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 'product-review',
    name: { zh: '产品评审', en: 'Product Review' },
    description: { zh: '双视角', en: 'Two angles' },
    members: [
      { expertId: 'code-reviewer', role: { zh: '工程评审', en: 'Engineering review' } },
      { expertId: 'general-assistant', role: { zh: '产品评审', en: 'Product review' } },
    ],
    quickPrompts: [],
    contract: {
      goal: { zh: '给出通过/驳回结论', en: 'Reach a ship / no-ship verdict' },
      constraints: [{ zh: '结论先行', en: 'Verdict first' }],
      delivery: { zh: '每人一段结论', en: 'One verdict paragraph per member' },
      examples: [{ zh: '评审这个 PR', en: 'Review this PR' }],
    },
    collaboration: 'dispatch',
    builtin: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const EXPERTS = [
  { id: 'code-reviewer', name: 'Code Reviewer', description: '严格、直接的工程评审专家' },
  { id: 'general-assistant', name: 'General Assistant', description: '通用助手，负责产品视角' },
]

describe('renderHostPrompt', () => {
  it('renders every contract section', () => {
    const prompt = renderHostPrompt(team(), hostPromptMembers(team(), EXPERTS))
    expect(prompt).toContain('# 团队契约：产品评审 / Product Review')
    expect(prompt).toContain('## 团队目标')
    expect(prompt).toContain('给出通过/驳回结论 / Reach a ship / no-ship verdict')
    expect(prompt).toContain('## 共享约束')
    expect(prompt).toContain('- 结论先行 / Verdict first')
    expect(prompt).toContain('## 交付要求')
    expect(prompt).toContain('## 示例任务')
    expect(prompt).toContain('- 评审这个 PR / Review this PR')
  })

  it('pins teammate names to member expert ids and carries role + persona', () => {
    const prompt = renderHostPrompt(team(), hostPromptMembers(team(), EXPERTS))
    expect(prompt).toContain('`code-reviewer`')
    expect(prompt).toContain('`general-assistant`')
    expect(prompt).toContain('在本团队的职责：工程评审 / Engineering review')
    expect(prompt).toContain('人格：严格、直接的工程评审专家')
  })

  it('omits empty contract sections', () => {
    const prompt = renderHostPrompt(team({ contract: emptyTeamContract() }), hostPromptMembers(team(), EXPERTS))
    expect(prompt).not.toContain('## 团队目标')
    expect(prompt).not.toContain('## 共享约束')
    expect(prompt).not.toContain('## 交付要求')
    expect(prompt).not.toContain('## 示例任务')
    expect(prompt).toContain('## 成员')
  })

  it('describes dispatch vs auto collaboration', () => {
    const dispatch = renderHostPrompt(team(), hostPromptMembers(team(), EXPERTS))
    expect(dispatch).toContain('普通协作（默认）')
    const auto = renderHostPrompt(team({ collaboration: 'auto' }), hostPromptMembers(team(), EXPERTS))
    expect(auto).toContain('自动协作')
    expect(auto).toContain('成员之间可以直接互相询问、分工协作')
  })

  it('fences host-only discipline and member notes with the real tool names', () => {
    const prompt = renderHostPrompt(team(), hostPromptMembers(team(), EXPERTS))
    expect(prompt).toContain('# 主持人职责（仅主持人；成员忽略本节）')
    expect(prompt).toContain('# 工具用法（仅主持人；成员忽略本节）')
    expect(prompt).toContain('# 成员须知（仅成员；主持人忽略本节）')
    for (const tool of ['spawn_teammate', 'send_message', 'wait_agent', 'team_task_create', 'list_agents', 'interrupt_agent']) {
      expect(prompt).toContain(tool)
    }
    // The spawn discipline pins the member name from the table.
    expect(prompt).toContain('name 必须用「成员」一节里钉死的成员名')
  })

  it('hostPromptMembers falls back to the expert id when the expert is unknown', () => {
    const rows = hostPromptMembers(team(), [])
    expect(rows[0]!.expertId).toBe('code-reviewer')
    expect(rows[0]!.name).toBe('code-reviewer')
    expect(rows[0]!.description).toBe('code-reviewer')
  })
})
