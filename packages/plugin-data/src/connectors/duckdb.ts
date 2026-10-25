/**
 * DuckDB file connector.
 *
 * Like the SQLite connector, the browser uploads a database file, the host
 * writes it to a private temp file, lists the tables and imports one table as
 * normalized rows. DuckDB is also the natural future execution engine for
 * large datasets; this module keeps the file I/O boundary explicit.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { inferType } from '../parser.js'
import type { DatasetRows, Scalar } from '../types.js'

const MAX_BYTES = 64 * 1024 * 1024
const MAX_ROWS = 20_000

export interface DuckDbHandle {
  readonly id: string
  readonly tables: readonly string[]
}

export class DuckDbConnectorError extends Error {
  constructor(readonly code: 'invalid-duckdb' | 'no-such-connector' | 'invalid-table' | 'too-many-rows', message: string) {
    super(message)
    this.name = 'DuckDbConnectorError'
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function normalize(value: unknown): Scalar {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return String(value)
}

export class DuckDbConnectors {
  private readonly handles = new Map<string, { path: string; tables: readonly string[] }>()

  constructor(private readonly root: string) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    for (const file of readdirSync(this.dir)) {
      if (file.endsWith('.duckdb')) rmSync(join(this.dir, file), { force: true })
    }
  }

  private get dir(): string { return join(this.root, 'duckdb') }

  private async withConnection<T>(path: string, action: (connection: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>) => Promise<T>): Promise<T> {
    const instance = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' })
    const connection = await instance.connect()
    try {
      return await action(connection)
    } finally {
      connection.closeSync()
    }
  }

  async open(contentBase64: string): Promise<DuckDbHandle> {
    const bytes = Buffer.from(contentBase64, 'base64')
    if (bytes.length === 0) throw new DuckDbConnectorError('invalid-duckdb', 'empty database')
    if (bytes.length > MAX_BYTES) throw new DuckDbConnectorError('invalid-duckdb', 'database is larger than 64 MB')
    const id = `duckdb-${randomUUID()}`
    const path = join(this.dir, `${id}.duckdb`)
    writeFileSync(path, bytes, { mode: 0o600 })
    try {
      const tables = await this.withConnection(path, async (connection) => {
        const reader = await connection.runAndReadAll(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' ORDER BY table_name",
        )
        return (await reader.getRowObjectsJS()).map((row) => String(row['table_name'] ?? '')).filter((name) => name !== '')
      })
      if (tables.length === 0) throw new DuckDbConnectorError('invalid-duckdb', 'database has no tables')
      this.handles.set(id, { path, tables })
      return { id, tables }
    } catch (error) {
      rmSync(path, { force: true })
      if (error instanceof DuckDbConnectorError) throw error
      throw new DuckDbConnectorError('invalid-duckdb', error instanceof Error ? error.message : String(error))
    }
  }

  async read(id: string, table: string): Promise<DatasetRows> {
    const handle = this.handles.get(id)
    if (handle === undefined) throw new DuckDbConnectorError('no-such-connector', 'connector is closed or expired')
    if (!handle.tables.includes(table)) throw new DuckDbConnectorError('invalid-table', `no such table: ${table}`)
    try {
      return await this.withConnection(handle.path, async (connection) => {
        const reader = await connection.runAndReadAll(`SELECT * FROM ${quoteIdentifier(table)} LIMIT ${MAX_ROWS + 1}`)
        const raw = (await reader.getRowObjectsJS()) as Record<string, unknown>[]
        if (raw.length > MAX_ROWS) throw new DuckDbConnectorError('too-many-rows', `table exceeds ${MAX_ROWS} rows`)
        const headers = reader.columnNames()
        const rows = raw.map((record) => {
          const row: Record<string, Scalar> = {}
          for (const header of headers) row[header] = normalize(record[header])
          return row
        })
        const columns = headers.map((name) => ({ name, type: inferType(rows.map((row) => row[name]!)) }))
        return { columns, rows }
      })
    } catch (error) {
      if (error instanceof DuckDbConnectorError) throw error
      throw new DuckDbConnectorError('invalid-duckdb', error instanceof Error ? error.message : String(error))
    }
  }

  close(id: string): void {
    const handle = this.handles.get(id)
    if (handle === undefined) return
    this.handles.delete(id)
    rmSync(handle.path, { force: true })
  }

  dispose(): void {
    for (const id of [...this.handles.keys()]) this.close(id)
  }
}
