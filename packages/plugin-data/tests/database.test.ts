import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as dataPlugin from '../src/index.js'
import { DatabaseConnectorError, normalizeDatabaseConfig, normalizeDatabaseRows, normalizeReadOnlyQuery, type DatabaseDriver } from '../src/connectors/database.js'
import type { TentacleData } from '../src/service.js'

const config = { engine: 'postgres' as const, host: 'db.local', port: 5432, database: 'analytics', user: 'reader', password: 'secret' }

const fakeDriver: DatabaseDriver = {
  async listTables() {
    return [{ schema: 'public', name: 'sales', label: 'public.sales' }]
  },
  async readTable(_config, table) {
    expect(table.name).toBe('sales')
    return {
      columns: [
        { name: 'month', type: 'string' },
        { name: 'revenue', type: 'number' },
      ],
      rows: [
        { month: 'Jan', revenue: 10 },
        { month: 'Feb', revenue: 20 },
      ],
    }
  },
  async readQuery(_config, query) {
    expect(query).toBe('SELECT month, SUM(revenue) AS revenue FROM sales GROUP BY month')
    return {
      columns: [
        { name: 'month', type: 'string' },
        { name: 'revenue', type: 'number' },
      ],
      rows: [{ month: 'Jan', revenue: 30 }],
    }
  },
}

async function boot(driver?: DatabaseDriver): Promise<TentacleData> {
  const app = new Context()
  const fiber = app.plugin(dataPlugin, {
    stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-data-')),
    ...(driver === undefined ? {} : { databaseDriver: driver }),
  })
  await fiber
  const service = app.tentacleData as TentacleData
  await service.ready
  return service
}

describe('database connector', () => {
  it('normalizes config defaults and rejects invalid fields', () => {
    expect(normalizeDatabaseConfig({ engine: 'mysql', host: ' localhost ', database: 'db', user: 'root', password: '' })).toMatchObject({ port: 3306, host: 'localhost' })
    expect(normalizeDatabaseConfig({ engine: 'mssql', host: 'db.local', database: 'analytics', user: 'reader', password: 'secret' })).toMatchObject({ port: 1433 })
    expect(() => normalizeDatabaseConfig({ ...config, engine: 'oracle' as never })).toThrowError(DatabaseConnectorError)
    expect(() => normalizeDatabaseConfig({ ...config, host: ' ' })).toThrowError(DatabaseConnectorError)
    expect(() => normalizeDatabaseConfig({ ...config, port: 0 })).toThrowError(DatabaseConnectorError)
  })

  it('accepts only one SELECT/WITH statement', () => {
    expect(normalizeReadOnlyQuery('SELECT 1;')).toBe('SELECT 1')
    expect(normalizeReadOnlyQuery('WITH x AS (SELECT 1) SELECT * FROM x')).toMatch(/^WITH/)
    expect(() => normalizeReadOnlyQuery('DELETE FROM sales')).toThrowError(/SELECT/)
    expect(() => normalizeReadOnlyQuery('SELECT 1; SELECT 2')).toThrowError(/one statement/)
    expect(() => normalizeReadOnlyQuery('  ')).toThrowError(/empty/)
  })

  it('normalizes database rows and infers columns', () => {
    const rows = normalizeDatabaseRows([
      { name: 'a', when: new Date('2026-01-01T00:00:00Z'), big: 1n, bytes: new Uint8Array([1, 2]) },
      { name: 'b', when: new Date('2026-01-02T00:00:00Z'), big: 2n, bytes: new Uint8Array([3]) },
    ])
    expect(rows.columns.map((column) => column.name)).toEqual(['name', 'when', 'big', 'bytes'])
    expect(rows.rows[0]).toEqual({ name: 'a', when: '2026-01-01T00:00:00.000Z', big: 1, bytes: 'AQI=' })
  })

  it('lists tables and imports one through the service', async () => {
    const service = await boot(fakeDriver)
    const workspace = service.stateSnapshot().workspaces[0]!
    const tables = await service.listDatabaseTables({ config })
    expect(tables[0]?.label).toBe('public.sales')
    const dataset = await service.importDatabase({ config, table: tables[0]!, workspaceId: workspace.id, name: 'DB sales' })
    expect(dataset.rowCount).toBe(2)
    expect(dataset.columns.map((column) => column.name)).toEqual(['month', 'revenue'])
    expect((await service.datasetRows(dataset.id)).rows[1]).toMatchObject({ month: 'Feb', revenue: 20 })
  })

  it('imports a custom SQL query through the service', async () => {
    const service = await boot(fakeDriver)
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDatabaseQuery({
      config,
      query: 'SELECT month, SUM(revenue) AS revenue FROM sales GROUP BY month',
      workspaceId: workspace.id,
      name: 'Monthly SQL',
    })
    expect(dataset.rowCount).toBe(1)
    expect((await service.datasetRows(dataset.id)).rows[0]).toMatchObject({ month: 'Jan', revenue: 30 })
    await expect(service.importDatabaseQuery({ config, query: 'DROP TABLE sales', workspaceId: workspace.id, name: 'bad' })).rejects.toMatchObject({ code: 'invalid-database' })
  })

  it('maps driver failures to a data error', async () => {
    const service = await boot({
      listTables: async () => { throw new DatabaseConnectorError('connection-failed', 'refused') },
      readTable: async () => { throw new DatabaseConnectorError('query-failed', 'bad query') },
    })
    await expect(service.listDatabaseTables({ config })).rejects.toMatchObject({ code: 'database-failed' })
  })
})
