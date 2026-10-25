/**
 * External SQL database connectors (PostgreSQL / MySQL).
 *
 * Credentials travel with one request and are never persisted: the dialog is a
 * one-shot "connect → list tables → import one table" flow. Drivers load
 * lazily so the host starts without them until a database request arrives.
 */
import { inferType } from '../parser.js'
import type { DataColumn, DatasetRows, Scalar } from '../types.js'

const MAX_ROWS = 20_000

export type DatabaseEngine = 'postgres' | 'mysql' | 'mssql'

export interface DatabaseConfig {
  readonly engine: DatabaseEngine
  readonly host: string
  readonly port?: number
  readonly database: string
  readonly user: string
  readonly password: string
  readonly ssl?: boolean
}

export interface DatabaseTable {
  readonly schema?: string
  readonly name: string
  /** Human-readable `schema.table` or `table`. */
  readonly label: string
}

export interface DatabaseDriver {
  listTables(config: DatabaseConfig): Promise<readonly DatabaseTable[]>
  readTable(config: DatabaseConfig, table: DatabaseTable): Promise<DatasetRows>
  readQuery(config: DatabaseConfig, query: string): Promise<DatasetRows>
}

export class DatabaseConnectorError extends Error {
  constructor(readonly code: 'invalid-config' | 'connection-failed' | 'query-failed' | 'too-many-rows', message: string) {
    super(message)
    this.name = 'DatabaseConnectorError'
  }
}

const ENGINES: readonly DatabaseEngine[] = ['postgres', 'mysql', 'mssql']

/** Validate and normalize an untrusted configuration object. */
export function normalizeDatabaseConfig(input: DatabaseConfig): DatabaseConfig {
  if (!ENGINES.includes(input.engine)) throw new DatabaseConnectorError('invalid-config', `unsupported engine: ${String(input.engine)}`)
  const host = input.host.trim()
  const database = input.database.trim()
  const user = input.user.trim()
  if (host === '' || database === '' || user === '') throw new DatabaseConnectorError('invalid-config', 'host, database and user are required')
  const port = input.port ?? (input.engine === 'postgres' ? 5432 : input.engine === 'mssql' ? 1433 : 3306)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new DatabaseConnectorError('invalid-config', 'port is invalid')
  return {
    engine: input.engine,
    host,
    port,
    database,
    user,
    password: input.password,
    ...(input.ssl === true ? { ssl: true } : {}),
  }
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

/** Convert driver rows into Data Studio's normalized row shape. */
export function normalizeDatabaseRows(
  rawRows: readonly Record<string, unknown>[],
  fieldNames?: readonly string[],
): DatasetRows {
  if (rawRows.length > MAX_ROWS) throw new DatabaseConnectorError('too-many-rows', `table exceeds ${MAX_ROWS} rows`)
  const headers = fieldNames !== undefined && fieldNames.length > 0
    ? [...fieldNames]
    : [...new Set(rawRows.flatMap((row) => Object.keys(row)))]
  const rows = rawRows.map((raw) => {
    const row: Record<string, Scalar> = {}
    for (const header of headers) row[header] = normalize(raw[header])
    return row
  })
  const columns: DataColumn[] = headers.map((name) => ({ name, type: inferType(rows.map((row) => row[name]!)) }))
  return { columns, rows }
}

/** Only a single read-only SELECT/WITH statement is accepted. */
export function normalizeReadOnlyQuery(query: string): string {
  const trimmed = query.trim().replace(/;+$/g, '').trim()
  if (trimmed === '') throw new DatabaseConnectorError('invalid-config', 'query must not be empty')
  if (trimmed.includes(';')) throw new DatabaseConnectorError('invalid-config', 'only one statement is supported')
  if (!/^(select|with)\b/i.test(trimmed)) throw new DatabaseConnectorError('invalid-config', 'only SELECT/WITH queries are supported')
  return trimmed
}

function wrapQuery(engine: DatabaseEngine, query: string): string {
  const normalized = normalizeReadOnlyQuery(query)
  if (engine === 'mssql') return `SELECT TOP ${MAX_ROWS + 1} * FROM (${normalized}) AS tentacle_query`
  return `SELECT * FROM (${normalized}) AS tentacle_query LIMIT ${MAX_ROWS + 1}`
}

function quotePostgres(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function quoteMysql(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``
}

function quoteMssql(name: string): string {
  return `[${name.replaceAll(']', ']]')}]`
}

/** PostgreSQL driver (lazy `pg` import). */
export const postgresDriver: DatabaseDriver = {
  async listTables(config) {
    const pg = await import('pg')
    const client = new pg.Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ...(config.ssl === true ? { ssl: { rejectUnauthorized: false } } : {}),
      connectionTimeoutMillis: 10_000,
      query_timeout: 15_000,
    })
    try {
      await client.connect()
      const result = await client.query(
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name",
      )
      return result.rows.map((row: { table_schema: string; table_name: string }) => ({
        schema: row.table_schema,
        name: row.table_name,
        label: `${row.table_schema}.${row.table_name}`,
      }))
    } catch (error) {
      if (error instanceof DatabaseConnectorError) throw error
      throw new DatabaseConnectorError('connection-failed', error instanceof Error ? error.message : String(error))
    } finally {
      await client.end().catch(() => undefined)
    }
  },
  async readTable(config, table) {
    const pg = await import('pg')
    const client = new pg.Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ...(config.ssl === true ? { ssl: { rejectUnauthorized: false } } : {}),
      connectionTimeoutMillis: 10_000,
      query_timeout: 15_000,
    })
    try {
      await client.connect()
      const qualified = table.schema === undefined ? quotePostgres(table.name) : `${quotePostgres(table.schema)}.${quotePostgres(table.name)}`
      const result = await client.query(`SELECT * FROM ${qualified} LIMIT ${MAX_ROWS + 1}`)
      return normalizeDatabaseRows(result.rows, result.fields.map((field) => field.name))
    } catch (error) {
      if (error instanceof DatabaseConnectorError) throw error
      throw new DatabaseConnectorError('query-failed', error instanceof Error ? error.message : String(error))
    } finally {
      await client.end().catch(() => undefined)
    }
  },
  async readQuery(config, query) {
    const pg = await import('pg')
    const client = new pg.Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ...(config.ssl === true ? { ssl: { rejectUnauthorized: false } } : {}),
      connectionTimeoutMillis: 10_000,
      query_timeout: 15_000,
    })
    try {
      await client.connect()
      const result = await client.query(wrapQuery('postgres', query))
      return normalizeDatabaseRows(result.rows, result.fields.map((field) => field.name))
    } catch (error) {
      if (error instanceof DatabaseConnectorError) throw error
      throw new DatabaseConnectorError('query-failed', error instanceof Error ? error.message : String(error))
    } finally {
      await client.end().catch(() => undefined)
    }
  },
}

/** MySQL/MariaDB driver (lazy `mysql2/promise` import). */
export const mysqlDriver: DatabaseDriver = {
  async listTables(config) {
    const mysql = await import('mysql2/promise')
    try {
      const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ...(config.ssl === true ? { ssl: {} } : {}),
        connectTimeout: 10_000,
      })
      try {
        const [rows] = await connection.query('SHOW TABLES')
        return (rows as Record<string, string>[]).map((row) => {
          const name = Object.values(row)[0] ?? ''
          return { name, label: name }
        }).filter((table) => table.name !== '')
      } finally {
        await connection.end().catch(() => undefined)
      }
    } catch (error) {
      throw new DatabaseConnectorError('connection-failed', error instanceof Error ? error.message : String(error))
    }
  },
  async readTable(config, table) {
    const mysql = await import('mysql2/promise')
    try {
      const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ...(config.ssl === true ? { ssl: {} } : {}),
        connectTimeout: 10_000,
      })
      try {
        const [rows, fields] = await connection.query(`SELECT * FROM ${quoteMysql(table.name)} LIMIT ${MAX_ROWS + 1}`)
        return normalizeDatabaseRows(
          rows as Record<string, unknown>[],
          (fields as { name: string }[] | undefined)?.map((field) => field.name),
        )
      } finally {
        await connection.end().catch(() => undefined)
      }
    } catch (error) {
      if (error instanceof DatabaseConnectorError) throw error
      throw new DatabaseConnectorError('query-failed', error instanceof Error ? error.message : String(error))
    }
  },
  async readQuery(config, query) {
    const mysql = await import('mysql2/promise')
    try {
      const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ...(config.ssl === true ? { ssl: {} } : {}),
        connectTimeout: 10_000,
      })
      try {
        const [rows, fields] = await connection.query(wrapQuery('mysql', query))
        return normalizeDatabaseRows(
          rows as Record<string, unknown>[],
          (fields as { name: string }[] | undefined)?.map((field) => field.name),
        )
      } finally {
        await connection.end().catch(() => undefined)
      }
    } catch (error) {
      if (error instanceof DatabaseConnectorError) throw error
      throw new DatabaseConnectorError('query-failed', error instanceof Error ? error.message : String(error))
    }
  },
}

/** SQL Server driver (lazy `mssql` import). */
export const mssqlDriver: DatabaseDriver = {
  async listTables(config) {
    const sql = await import('mssql')
    const pool = new sql.ConnectionPool({
      server: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      options: { encrypt: config.ssl === true, trustServerCertificate: true },
      connectionTimeout: 10_000,
      requestTimeout: 15_000,
    })
    try {
      await pool.connect()
      const result = await pool.request().query(
        'SELECT s.name AS [schema], t.name AS [name] FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id ORDER BY s.name, t.name',
      )
      return result.recordset.map((row: { schema: string; name: string }) => ({
        schema: row.schema,
        name: row.name,
        label: `${row.schema}.${row.name}`,
      }))
    } catch (error) {
      throw new DatabaseConnectorError('connection-failed', error instanceof Error ? error.message : String(error))
    } finally {
      await pool.close().catch(() => undefined)
    }
  },
  async readTable(config, table) {
    const sql = await import('mssql')
    const pool = new sql.ConnectionPool({
      server: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      options: { encrypt: config.ssl === true, trustServerCertificate: true },
      connectionTimeout: 10_000,
      requestTimeout: 15_000,
    })
    try {
      await pool.connect()
      const qualified = table.schema === undefined
        ? quoteMssql(table.name)
        : `${quoteMssql(table.schema)}.${quoteMssql(table.name)}`
      const result = await pool.request().query(`SELECT TOP ${MAX_ROWS + 1} * FROM ${qualified}`)
      return normalizeDatabaseRows(result.recordset, Object.keys(result.recordset.columns ?? {}))
    } catch (error) {
      if (error instanceof DatabaseConnectorError) throw error
      throw new DatabaseConnectorError('query-failed', error instanceof Error ? error.message : String(error))
    } finally {
      await pool.close().catch(() => undefined)
    }
  },
  async readQuery(config, query) {
    const sql = await import('mssql')
    const pool = new sql.ConnectionPool({
      server: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      options: { encrypt: config.ssl === true, trustServerCertificate: true },
      connectionTimeout: 10_000,
      requestTimeout: 15_000,
    })
    try {
      await pool.connect()
      const result = await pool.request().query(wrapQuery('mssql', query))
      return normalizeDatabaseRows(result.recordset, Object.keys(result.recordset.columns ?? {}))
    } catch (error) {
      if (error instanceof DatabaseConnectorError) throw error
      throw new DatabaseConnectorError('query-failed', error instanceof Error ? error.message : String(error))
    } finally {
      await pool.close().catch(() => undefined)
    }
  },
}

export function createDatabaseDriver(engine: DatabaseEngine): DatabaseDriver {
  return engine === 'postgres' ? postgresDriver : engine === 'mssql' ? mssqlDriver : mysqlDriver
}
