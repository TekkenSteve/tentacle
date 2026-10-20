/**
 * Team workspace tests (design 10 §4): generated artifacts are seeded from
 * team data, member skills are materialized under per-member subtrees, and
 * the materialized tree is a full rebuild (a removed member's skills leave).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Team } from '../src/types.js'
import {
  listMaterializedSkills,
  materializeMemberSkills,
  seedTeamWorkspace,
  teamManifestSnapshot,
  teamWorkspacePath,
} from '../src/workspace.js'

let root: string
let workspace: string

const TEAM: Team = {
  id: 'product-review',
  name: { zh: '产品评审', en: 'Product Review' },
  description: { zh: '双视角', en: 'Two angles' },
  members: [
    { expertId: 'code-reviewer', role: { zh: '工程评审', en: 'Engineering review' } },
    { expertId: 'general-assistant', role: { zh: '产品评审', en: 'Product review' } },
  ],
  quickPrompts: [{ title: { zh: '评审', en: 'Review' }, prompt: { zh: '评审这个 PR', en: 'Review this PR' } }],
  contract: {
    goal: { zh: '结论', en: 'Verdict' },
    constraints: [],
    examples: [],
  },
  collaboration: 'dispatch',
  builtin: true,
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tentacle-teams-ws-'))
  workspace = teamWorkspacePath(root, 'product-review')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Plant one member expert's skills root the way the persona library would. */
function plantExpertSkills(expertId: string, skills: Record<string, string>): string {
  const skillsRoot = join(root, 'experts', expertId, 'workspace', '.dsh', 'skills')
  mkdirSync(skillsRoot, { recursive: true })
  for (const [name, body] of Object.entries(skills)) {
    mkdirSync(join(skillsRoot, name), { recursive: true })
    writeFileSync(join(skillsRoot, name, 'SKILL.md'), body)
  }
  return skillsRoot
}

describe('team workspace layout', () => {
  it('places each instance under <root>/agents/<id>/workspace', () => {
    expect(teamWorkspacePath('/state', 'abc')).toBe('/state/agents/abc/workspace')
  })
})

describe('seedTeamWorkspace', () => {
  it('writes the generated SOUL.md and the manifest snapshot', () => {
    seedTeamWorkspace(workspace, TEAM, '# 团队契约：产品评审')
    const soul = readFileSync(join(workspace, 'SOUL.md'), 'utf8')
    expect(soul).toContain('由团队数据生成')
    expect(soul).toContain('# 团队契约：产品评审')
    const manifest = JSON.parse(
      readFileSync(join(workspace, '.tentacle', 'manifest.json'), 'utf8'),
    ) as ReturnType<typeof teamManifestSnapshot>
    expect(manifest.id).toBe('product-review')
    expect(manifest.members).toHaveLength(2)
    expect(manifest.quickPrompts[0]!.title.zh).toBe('评审')
    expect(manifest.collaboration).toBe('dispatch')
  })
})

describe('materializeMemberSkills', () => {
  it('copies each member expert\'s skills under its own subtree', () => {
    const reviewer = plantExpertSkills('code-reviewer', { 'pr-review': '---\ndescription: PR 评审\n---\nbody' })
    const assistant = plantExpertSkills('general-assistant', { 'pr-review': '---\ndescription: 通用\n---\nbody' })
    const materialized = materializeMemberSkills(workspace, [
      { expertId: 'code-reviewer', skillsRoot: reviewer },
      { expertId: 'general-assistant', skillsRoot: assistant },
    ])
    // Same-named skills from two members never collide.
    expect(materialized).toEqual([
      'code-reviewer/pr-review',
      'general-assistant/pr-review',
    ])
    expect(listMaterializedSkills(workspace)).toEqual(materialized)
  })

  it('is a full rebuild: a departed member\'s skills disappear', () => {
    const reviewer = plantExpertSkills('code-reviewer', { 'pr-review': 'body' })
    const assistant = plantExpertSkills('general-assistant', { 'writing': 'body' })
    materializeMemberSkills(workspace, [
      { expertId: 'code-reviewer', skillsRoot: reviewer },
      { expertId: 'general-assistant', skillsRoot: assistant },
    ])
    expect(listMaterializedSkills(workspace)).toHaveLength(2)
    const after = materializeMemberSkills(workspace, [
      { expertId: 'general-assistant', skillsRoot: assistant },
    ])
    expect(after).toEqual(['general-assistant/writing'])
  })

  it('tolerates a member whose expert has no skills root', () => {
    const materialized = materializeMemberSkills(workspace, [
      { expertId: 'code-reviewer', skillsRoot: join(root, 'nope') },
    ])
    expect(materialized).toEqual([])
    expect(listMaterializedSkills(workspace)).toEqual([])
  })
})
