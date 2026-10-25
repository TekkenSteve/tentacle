/**
 * Persistence for Data Studio: one small state JSON plus one normalized-rows
 * file per dataset. Writes are atomic (tmp + rename) and serialized per file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emptyState, type DataState, type DatasetRows } from './types.js'

export class DataRepo {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly root: string) {}

  private get stateFile(): string { return join(this.root, 'state.json') }

  private datasetFile(id: string): string { return join(this.root, 'datasets', `${id}.json`) }

  async loadState(): Promise<DataState> {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as DataState
      if (raw.version !== 1) throw new Error(`unsupported data state version: ${String(raw.version)}`)
      return { ...emptyState(), ...raw }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
  }

  async saveState(state: DataState): Promise<void> {
    await this.writeJson(this.stateFile, state)
  }

  async readDataset(id: string): Promise<DatasetRows> {
    const raw = JSON.parse(readFileSync(this.datasetFile(id), 'utf8')) as DatasetRows
    return raw
  }

  async writeDataset(id: string, rows: DatasetRows): Promise<void> {
    await this.writeJson(this.datasetFile(id), rows)
  }

  async removeDataset(id: string): Promise<void> {
    const { rmSync } = await import('node:fs')
    rmSync(this.datasetFile(id), { force: true })
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const write = this.chain.then(() => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 })
      renameSync(tmp, file)
    })
    this.chain = write.catch(() => undefined)
    await write
  }
}
