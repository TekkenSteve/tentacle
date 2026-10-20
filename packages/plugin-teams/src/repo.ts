/**
 * Team persistence ports and adapters (mirrors @tentacle/persona/src/repo.ts:
 * king-bcolor's ports-and-adapters pattern). The domain core is pure and
 * testable against {@link MemoryRepo}; the Host mounts {@link JsonFileRepo}.
 *
 * JsonFileRepo: atomic write (tmp + rename) on a serialized write chain — no
 * interleaved partial states, no fs locks needed single-process.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emptyState, type Team, type TeamState } from './types.js'

export interface TeamRepo {
  load(): Promise<TeamState>
  save(state: TeamState): Promise<void>
}

export class MemoryRepo implements TeamRepo {
  private state: TeamState
  constructor(initial?: TeamState) {
    this.state = initial ?? emptyState()
  }
  async load(): Promise<TeamState> {
    return structuredClone(this.state)
  }
  async save(state: TeamState): Promise<void> {
    this.state = structuredClone(state)
  }
}

export class JsonFileRepo implements TeamRepo {
  private readonly file: string
  private chain: Promise<unknown> = Promise.resolve()

  constructor(root: string) {
    this.file = join(root, 'teams.json')
  }

  async load(): Promise<TeamState> {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: number; teams?: unknown }
      if (raw.version !== 1) {
        throw new Error(`unsupported teams version: ${String(raw.version)}`)
      }
      return migrateState(raw)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
  }

  async save(state: TeamState): Promise<void> {
    // Serialize writes: each save runs after the previous settles.
    const write = this.chain.then(() => {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    })
    this.chain = write.catch(() => undefined)
    await write
  }
}

/**
 * Normalize persisted rows defensively: a hand-edited or forward-dated file
 * must never crash boot, but it also must never invent data. Unknown member
 * shapes are dropped; a roster that falls below the minimum is kept as-is —
 * the library refuses to SAVE it, and the console surfaces it for repair
 * (the same posture as the expert repo's v3 migration).
 */
function migrateState(raw: { version?: number; seeded?: boolean; teams?: unknown }): TeamState {
  const rows = Array.isArray(raw.teams) ? raw.teams as Record<string, unknown>[] : []
  const teams: Team[] = []
  for (const row of rows) {
    if (typeof row['id'] !== 'string' || row['id'] === '') continue
    const members = Array.isArray(row['members'])
      ? (row['members'] as Record<string, unknown>[])
        .filter((m) => typeof m['expertId'] === 'string' && m['expertId'] !== '')
        .map((m) => ({ expertId: m['expertId'] as string, role: m['role'] as Team['members'][number]['role'] }))
      : []
    teams.push({
      id: row['id'],
      name: row['name'] as Team['name'],
      description: row['description'] as Team['description'],
      ...(typeof row['icon'] === 'string' && row['icon'] !== '' ? { icon: row['icon'] } : {}),
      ...(typeof row['color'] === 'string' && row['color'] !== '' ? { color: row['color'] } : {}),
      members,
      contract: (row['contract'] ?? { constraints: [], examples: [] }) as Team['contract'],
      ...(row['welcomeMessage'] === undefined || row['welcomeMessage'] === null
        ? {}
        : { welcomeMessage: row['welcomeMessage'] as Team['welcomeMessage'] }),
      quickPrompts: Array.isArray(row['quickPrompts']) ? row['quickPrompts'] as Team['quickPrompts'] : [],
      ...(row['model'] === undefined || row['model'] === null ? {} : { model: row['model'] as Team['model'] }),
      ...(typeof row['permissionPreset'] === 'string' && row['permissionPreset'] !== ''
        ? { permissionPreset: row['permissionPreset'] }
        : {}),
      collaboration: row['collaboration'] === 'auto' ? 'auto' : 'dispatch',
      ...(typeof row['templateId'] === 'string' && row['templateId'] !== '' ? { templateId: row['templateId'] } : {}),
      builtin: row['builtin'] === true,
      createdAt: typeof row['createdAt'] === 'number' ? row['createdAt'] : Date.now(),
      updatedAt: typeof row['updatedAt'] === 'number' ? row['updatedAt'] : Date.now(),
    })
  }
  return { version: 1, seeded: raw.seeded === true, teams }
}
