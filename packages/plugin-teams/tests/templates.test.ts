/**
 * Team template catalog tests (design 10 §10): the four bundled templates
 * load, planting filters missing experts and never kills boot, and a broken
 * manifest is reported instead of thrown.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { TeamLibrary } from '../src/library.js'
import { MemoryRepo } from '../src/repo.js'
import { loadTeamTemplates, plantTeamTemplates } from '../src/templates.js'

const TEMPLATES_ROOT = fileURLToPath(new URL('../templates', import.meta.url))
const EXPERTS = ['general-assistant', 'code-reviewer', 'translator', 'ops-engineer']

afterAll(() => {})

describe('bundled team templates', () => {
  it('loads four templates with bilingual identity, roster and contract', () => {
    const { templates, errors } = loadTeamTemplates(TEMPLATES_ROOT)
    expect(errors).toEqual([])
    expect(templates.map((t) => t.manifest.id)).toEqual([
      'content-planning',
      'data-analysis',
      'product-review',
      'tech-review',
    ])
    for (const template of templates) {
      expect(template.manifest.members.length).toBeGreaterThanOrEqual(2)
      for (const member of template.manifest.members) {
        expect(EXPERTS).toContain(member.expertId)
        expect(member.role.zh).not.toBe('')
        expect(member.role.en).not.toBe('')
      }
      expect(template.manifest.contract?.goal?.zh).toBeTruthy()
      expect(template.manifest.collaboration).toBe('dispatch')
    }
  })

  it('plants one builtin instance per template', async () => {
    const { templates } = loadTeamTemplates(TEMPLATES_ROOT)
    const library = new TeamLibrary({ repo: new MemoryRepo(), knownExpert: (id) => EXPERTS.includes(id) })
    await library.boot()
    const planted = await plantTeamTemplates(library, templates, (id) => EXPERTS.includes(id))
    expect(planted).toHaveLength(4)
    const team = library.get('product-review')!
    expect(team.builtin).toBe(true)
    expect(team.templateId).toBe('product-review')
    expect(team.members.map((m) => m.expertId)).toEqual(['code-reviewer', 'general-assistant'])
    expect(team.contract.goal?.zh).toContain('通过')
  })

  it('drops members whose expert is missing and skips an unplantable roster', async () => {
    const { templates } = loadTeamTemplates(TEMPLATES_ROOT)
    const library = new TeamLibrary({ repo: new MemoryRepo(), knownExpert: () => true })
    await library.boot()
    // Only one expert exists: every template's filtered roster falls below
    // the minimum, so nothing is planted and boot survives.
    const planted = await plantTeamTemplates(library, templates, (id) => id === 'code-reviewer')
    expect(planted).toEqual([])
    expect(library.list()).toEqual([])

    // Two of three experts present: the roster shrinks but the team survives.
    const plantedPartial = await plantTeamTemplates(
      library,
      templates,
      (id) => id === 'code-reviewer' || id === 'general-assistant',
    )
    expect(plantedPartial.length).toBeGreaterThan(0)
    for (const team of library.list()) {
      expect(team.members.every((m) => ['code-reviewer', 'general-assistant'].includes(m.expertId))).toBe(true)
    }
  })

  it('is idempotent: a second plant creates nothing', async () => {
    const { templates } = loadTeamTemplates(TEMPLATES_ROOT)
    const library = new TeamLibrary({ repo: new MemoryRepo(), knownExpert: () => true })
    await library.boot()
    await plantTeamTemplates(library, templates, () => true)
    const again = await plantTeamTemplates(library, templates, () => true)
    expect(again).toEqual([])
    expect(library.list()).toHaveLength(4)
  })

  it('reports a broken manifest without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'tentacle-teams-tpl-'))
    try {
      mkdirSync(join(root, 'broken'), { recursive: true })
      writeFileSync(join(root, 'broken', 'manifest.json'), '{ not json')
      const { templates, errors } = loadTeamTemplates(root)
      expect(templates).toEqual([])
      expect(errors[0]).toContain('broken')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
