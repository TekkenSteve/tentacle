/**
 * SQLite connector (Data Formulator's "connect any data" first step).
 *
 * The browser uploads the database bytes; the host writes them to a private
 * temp file, lists the user tables and imports one table's rows as a regular
 * Data Studio dataset. The uploaded file is deleted on close/exit; only the
 * normalized rows are persisted.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inferType } from '../parser.js'
import type { DatasetRows, Scalar } from '../types.js'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_ROWS = 20_000
const SQLITE_HEADER = 'SQLite format 3\u0000'

export interface SqliteHandle {
  readonly id: string
  readonly tables: readonly string[]
}

export class SqliteConnectorError extends Error {
  constructor(readonly code: 'invalid-sqlite' | 'no-such-connector' | 'invalid-table' | 'too-many-rows', message: string) {
    super(message)
    this.name = 'SqliteConnectorError'
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
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return String(value)
}

export class SqliteConnectors {
  private readonly handles = new Map<string, { path: string; tables: readonly string[]; createdAt: number }>()

  constructor(private readonly root: string) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    // Uploads are process-local connector sessions; never resurrect them.
    for (const file of readdirSync(this.dir)) {
      if (file.endsWith('.db')) rmSync(join(this.dir, file), { force: true })
    }
  }

  private get dir(): string {
    return join(this.root, 'connectors')
  }

  /** Store uploaded bytes and return the user-table catalog. */
  open(contentBase64: string): SqliteHandle {
    const bytes = Buffer.from(contentBase64, 'base64')
    if (bytes.length === 0) throw new SqliteConnectorError('invalid-sqlite', 'empty database')
    if (bytes.length > MAX_BYTES) throw new SqliteConnectorError('invalid-sqlite', 'database is larger than 32 MB')
    if (bytes.subarray(0, 16).toString('utf8') !== SQLITE_HEADER) {
      throw new SqliteConnectorError('invalid-sqlite', 'file is not a SQLite database')
    }
    const id = `sqlite-${randomUUID()}`
    const path = join(this.dir, `${id}.db`)
    writeFileSync(path, bytes, { mode: 0o600 })
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
      const tables = rows.map((row) => row.name)
      if (tables.length === 0) throw new SqliteConnectorError('invalid-sqlite', 'database has no tables')
      this.handles.set(id, { path, tables, createdAt: Date.now() })
      return { id, tables }
    } finally {
      db.close()
    }
  }

  /** Read one table as normalized rows. */
  read(id: string, table: string): DatasetRows {
    const handle = this.handles.get(id)
    if (handle === undefined) throw new SqliteConnectorError('no-such-connector', 'connector is closed or expired')
    if (!handle.tables.includes(table)) throw new SqliteConnectorError('invalid-table', `no such table: ${table}`)
    const db = new DatabaseSync(handle.path, { readOnly: true })
    try {
      const statement = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} LIMIT ${MAX_ROWS + 1}`)
      const raw = statement.all() as Record<string, unknown>[]
      if (raw.length > MAX_ROWS) throw new SqliteConnectorError('too-many-rows', `table exceeds ${MAX_ROWS} rows`)
      const headers = statement.columns().map((column) => column.name)
      const rows = raw.map((row) => {
        const record: Record<string, Scalar> = {}
        for (const header of headers) record[header] = normalize(row[header])
        return record
      })
      const columns = headers.map((name) => ({ name, type: inferType(rows.map((row) => row[name]!)) }))
      return { columns, rows }
    } finally {
      db.close()
    }
  }

  close(id: string): void {
    const handle = this.handles.get(id)
    if (handle === undefined) return
    this.handles.delete(id)
    rmSync(handle.path, { force: true })
  }

  /** Best-effort cleanup for process exit. */
  dispose(): void {
    for (const id of [...this.handles.keys()]) this.close(id)
  }

}
