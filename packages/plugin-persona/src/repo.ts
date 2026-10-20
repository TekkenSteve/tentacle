/**
 * Repo port + adapters (king-bcolor's ports-and-adapters pattern, mirrored
 * from @tentacle/tenancy): the domain core is pure and testable against
 * MemoryRepo; the Host mounts JsonFileRepo for persistence.
 *
 * JsonFileRepo: atomic write (tmp + rename) with a serialized write chain —
 * no interleaved partial states, no fs locks needed single-process.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emptyState, type Expert, type ExpertState } from './types.js'

interface LegacyExpertRow {
  readonly id?: unknown
  readonly name?: unknown
  readonly description?: unknown
  readonly icon?: unknown
  readonly color?: unknown
  readonly agentPreset?: unknown
  readonly model?: unknown
  readonly permissionPreset?: unknown
  readonly templateId?: unknown
  readonly builtin?: unknown
  readonly createdAt?: unknown
  readonly updatedAt?: unknown
}

/**
 * Normalize persisted rows to the v3 model: an expert **selects** a preset
 * (`agentPreset`). Pre-v3 rows embedded their persona/composition rows, which
 * the v3 model no longer carries; those rows adopt the deployment default
 * preset (`standard`) and lose the embedded persona (expert identity/workspace
 * skills remain the composition surface for new installs).
 */
function migrateState(raw: { version?: number; seeded?: boolean; experts?: unknown }): ExpertState {
  const rows = Array.isArray(raw.experts) ? raw.experts as LegacyExpertRow[] : []
  const experts: Expert[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '') continue
    const explicitPreset = typeof row.agentPreset === 'string' && row.agentPreset.trim() !== ''
    experts.push({
      id: row.id,
      name: row.name as Expert['name'],
      description: row.description as Expert['description'],
      ...(typeof row.icon === 'string' && row.icon !== '' ? { icon: row.icon } : {}),
      ...(typeof row.color === 'string' && row.color !== '' ? { color: row.color } : {}),
      agentPreset: explicitPreset ? row.agentPreset as string : 'standard',
      ...(row.model === undefined || row.model === null ? {} : { model: row.model as Expert['model'] }),
      ...(typeof row.permissionPreset === 'string' && row.permissionPreset !== ''
        ? { permissionPreset: row.permissionPreset }
        : {}),
      ...(typeof row.templateId === 'string' && row.templateId !== '' ? { templateId: row.templateId } : {}),
      builtin: row.builtin === true,
      createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
    })
  }
  return { version: 3, seeded: raw.seeded === true, experts }
}

export interface ExpertRepo {
  load(): Promise<ExpertState>
  save(state: ExpertState): Promise<void>
}

export class MemoryRepo implements ExpertRepo {
  private state: ExpertState
  constructor(initial?: ExpertState) {
    this.state = initial ?? emptyState()
  }
  async load(): Promise<ExpertState> {
    return structuredClone(this.state)
  }
  async save(state: ExpertState): Promise<void> {
    this.state = structuredClone(state)
  }
}

export class JsonFileRepo implements ExpertRepo {
  private readonly file: string
  private chain: Promise<unknown> = Promise.resolve()

  constructor(root: string) {
    this.file = join(root, 'experts.json')
  }

  async load(): Promise<ExpertState> {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: number; seeded?: boolean; experts?: unknown }
      if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) {
        throw new Error(`unsupported experts version: ${String(raw.version)}`)
      }
      return migrateState(raw)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
  }

  async save(state: ExpertState): Promise<void> {
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
