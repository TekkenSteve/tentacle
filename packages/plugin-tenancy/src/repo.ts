/**
 * Repo port + adapters (king-bcolor's ports-and-adapters pattern):
 * the domain service is pure and testable against MemoryRepo; the Host
 * mounts JsonFileRepo for persistence.
 *
 * JsonFileRepo: atomic write (tmp + rename) with a serialized write chain —
 * no interleaved partial states, no fs locks needed single-process.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emptyState, type DirectoryState } from './types.js'

export interface DirectoryRepo {
  load(): Promise<DirectoryState>
  save(state: DirectoryState): Promise<void>
}

export class MemoryRepo implements DirectoryRepo {
  private state: DirectoryState
  constructor(initial?: DirectoryState) {
    this.state = initial ?? emptyState()
  }
  async load(): Promise<DirectoryState> {
    return structuredClone(this.state)
  }
  async save(state: DirectoryState): Promise<void> {
    this.state = structuredClone(state)
  }
}

export class JsonFileRepo implements DirectoryRepo {
  private readonly file: string
  private chain: Promise<unknown> = Promise.resolve()

  constructor(root: string) {
    this.file = join(root, 'directory.json')
  }

  async load(): Promise<DirectoryState> {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as DirectoryState
      if (raw.version !== 1) throw new Error(`unsupported directory version: ${raw.version}`)
      return raw
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
  }

  async save(state: DirectoryState): Promise<void> {
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
