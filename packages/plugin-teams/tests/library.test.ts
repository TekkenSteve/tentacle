/**
 * TeamLibrary domain tests (design 10 §2): roster validation, contract
 * normalization, builtin protection, removal vetoes. The expert-existence
 * seam is injected, so the library is exercised without the persona plugin.
 */
import { describe, expect, it } from 'vitest'
import { TeamLibrary, TeamError } from '../src/library.js'
import { MemoryRepo } from '../src/repo.js'
import type { TeamMemberInput } from '../src/types.js'

const EXPERTS = ['general-assistant', 'code-reviewer', 'translator', 'ops-engineer']

function bootLibrary(known: readonly string[] = EXPERTS): TeamLibrary {
  const library = new TeamLibrary({ repo: new MemoryRepo(), knownExpert: (id) => known.includes(id) })
  return library
}

const TWO_MEMBERS: TeamMemberInput[] = [
  { expertId: 'code-reviewer', role: '工程评审' },
  { expertId: 'general-assistant', role: { zh: '产品视角', en: 'Product view' } },
]

describe('TeamLibrary roster validation', () => {
  it('creates a team with a bilingual roster and contract', async () => {
    const library = bootLibrary()
    await library.boot()
    const team = await library.create({
      id: 'product-review',
      name: '产品评审',
      description: '双视角评审',
      members: TWO_MEMBERS,
      contract: {
        goal: '给出通过/驳回结论',
        constraints: ['结论先行'],
        delivery: '每人一段结论',
        examples: ['评审这个 PR'],
      },
    })
    expect(team.id).toBe('product-review')
    expect(team.name).toEqual({ zh: '产品评审', en: '产品评审' })
    expect(team.members).toHaveLength(2)
    expect(team.members[1]!.role).toEqual({ zh: '产品视角', en: 'Product view' })
    expect(team.contract.constraints[0]).toEqual({ zh: '结论先行', en: '结论先行' })
    expect(team.collaboration).toBe('dispatch')
    expect(team.builtin).toBe(false)
    expect(library.list()).toHaveLength(1)
  })

  it('derives a slug id from an ASCII English name', async () => {
    const library = bootLibrary()
    await library.boot()
    const team = await library.create({ name: 'Tech Review Crew', description: 'x', members: TWO_MEMBERS })
    expect(team.id).toBe('tech-review-crew')
  })

  it('rejects a roster below the minimum, above the maximum, or with unknown experts', async () => {
    const library = bootLibrary()
    await library.boot()
    await expect(library.create({ name: 'Solo', description: 'x', members: [TWO_MEMBERS[0]!] }))
      .rejects.toThrowError(TeamError)
    const nine = Array.from({ length: 9 }, (_, i) => ({ expertId: `e${i}`, role: 'r' }))
    const wide = new TeamLibrary({
      repo: new MemoryRepo(),
      knownExpert: (id) => /^e[0-8]$/.test(id),
    })
    await wide.boot()
    await expect(wide.create({ name: 'Crowd', description: 'x', members: nine }))
      .rejects.toMatchObject({ code: 'members-too-many' })
    await expect(library.create({
      name: 'Ghost', description: 'x',
      members: [{ expertId: 'code-reviewer', role: 'a' }, { expertId: 'nobody', role: 'b' }],
    })).rejects.toMatchObject({ code: 'member-invalid' })
  })

  it('rejects duplicate members and duplicate team ids', async () => {
    const library = bootLibrary()
    await library.boot()
    await expect(library.create({
      name: 'Dup', description: 'x',
      members: [{ expertId: 'code-reviewer', role: 'a' }, { expertId: 'code-reviewer', role: 'b' }],
    })).rejects.toMatchObject({ code: 'member-invalid' })
    await library.create({ id: 'team-a', name: 'A', description: 'x', members: TWO_MEMBERS })
    await expect(library.create({ id: 'team-a', name: 'B', description: 'x', members: TWO_MEMBERS }))
      .rejects.toMatchObject({ code: 'duplicate-team' })
  })

  it('rejects an empty role or invalid slug id', async () => {
    const library = bootLibrary()
    await library.boot()
    await expect(library.create({
      name: 'NoRole', description: 'x',
      members: [{ expertId: 'code-reviewer', role: '' }, TWO_MEMBERS[1]!],
    })).rejects.toMatchObject({ code: 'invalid-team' })
    await expect(library.create({ id: 'Bad_Id', name: 'X', description: 'x', members: TWO_MEMBERS }))
      .rejects.toMatchObject({ code: 'invalid-team' })
  })
})

describe('TeamLibrary contract bounds', () => {
  it('rejects too many constraints or examples', async () => {
    const library = bootLibrary()
    await library.boot()
    const constraints = Array.from({ length: 9 }, (_, i) => `c${i}`)
    await expect(library.create({ name: 'C', description: 'x', members: TWO_MEMBERS, contract: { constraints } }))
      .rejects.toMatchObject({ code: 'invalid-contract' })
    const examples = Array.from({ length: 4 }, (_, i) => `e${i}`)
    await expect(library.create({ name: 'E', description: 'x', members: TWO_MEMBERS, contract: { examples } }))
      .rejects.toMatchObject({ code: 'invalid-contract' })
  })

  it('normalizes an absent contract to empty lists', async () => {
    const library = bootLibrary()
    await library.boot()
    const team = await library.create({ name: 'Bare', description: 'x', members: TWO_MEMBERS })
    expect(team.contract).toEqual({ constraints: [], examples: [] })
  })

  it('validates the collaboration mode', async () => {
    const library = bootLibrary()
    await library.boot()
    await expect(library.create({
      name: 'M', description: 'x', members: TWO_MEMBERS,
      collaboration: 'telepathy' as never,
    })).rejects.toMatchObject({ code: 'invalid-collaboration' })
    const team = await library.create({ name: 'M', description: 'x', members: TWO_MEMBERS, collaboration: 'auto' })
    expect(team.collaboration).toBe('auto')
  })
})

describe('TeamLibrary update semantics', () => {
  it('replaces the whole roster on patch', async () => {
    const library = bootLibrary()
    await library.boot()
    const team = await library.create({ name: 'T', description: 'x', members: TWO_MEMBERS })
    const updated = await library.update(team.id, {
      members: [
        { expertId: 'translator', role: '本地化' },
        { expertId: 'ops-engineer', role: '运维' },
      ],
    })
    expect(updated.members.map((m) => m.expertId)).toEqual(['translator', 'ops-engineer'])
  })

  it('keeps builtin identity fixed but allows roster/contract/routing edits', async () => {
    const library = bootLibrary()
    await library.boot()
    const team = await library.create({ name: 'Built', description: 'x', members: TWO_MEMBERS, builtin: true })
    await expect(library.update(team.id, { name: 'Renamed' }))
      .rejects.toMatchObject({ code: 'builtin-protected' })
    await expect(library.update(team.id, { description: 'Renamed' }))
      .rejects.toMatchObject({ code: 'builtin-protected' })
    const edited = await library.update(team.id, {
      members: TWO_MEMBERS,
      contract: { goal: '新目标' },
      collaboration: 'auto',
      permissionPreset: 'standard',
      model: { provider: 'p', model: 'm' },
    })
    expect(edited.contract.goal).toEqual({ zh: '新目标', en: '新目标' })
    expect(edited.collaboration).toBe('auto')
    expect(edited.permissionPreset).toBe('standard')
  })

  it('clears optional routes with null and drops the welcome message', async () => {
    const library = bootLibrary()
    await library.boot()
    const team = await library.create({
      name: 'R', description: 'x', members: TWO_MEMBERS,
      welcomeMessage: '你好',
      model: { provider: 'p', model: 'm' },
      permissionPreset: 'standard',
    })
    const cleared = await library.update(team.id, { model: null, permissionPreset: null, welcomeMessage: null })
    expect(cleared.model).toBeUndefined()
    expect(cleared.permissionPreset).toBeUndefined()
    expect(cleared.welcomeMessage).toBeUndefined()
  })
})

describe('TeamLibrary removal', () => {
  it('refuses builtin deletion and honors registered guards', async () => {
    const library = bootLibrary()
    await library.boot()
    const builtin = await library.create({ name: 'B', description: 'x', members: TWO_MEMBERS, builtin: true })
    await expect(library.remove(builtin.id)).rejects.toMatchObject({ code: 'builtin-protected' })

    const team = await library.create({ name: 'U', description: 'x', members: TWO_MEMBERS })
    const dispose = library.registerRemovalGuard((id) => (id === team.id ? 'bound by channel x' : undefined))
    await expect(library.remove(team.id)).rejects.toMatchObject({ code: 'team-in-use' })
    dispose()
    await library.remove(team.id)
    expect(library.get(team.id)).toBeUndefined()
  })
})
