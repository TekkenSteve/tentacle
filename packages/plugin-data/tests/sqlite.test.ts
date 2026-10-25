import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as dataPlugin from '../src/index.js'
import { SqliteConnectors, SqliteConnectorError } from '../src/connectors/sqlite.js'
import type { TentacleData } from '../src/service.js'

function makeDatabase(): { file: string; base64: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tentacle-sqlite-'))
  const file = join(dir, 'sales.db')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE sales (month TEXT, revenue REAL, region TEXT)')
  db.exec("INSERT INTO sales VALUES ('Jan', 120, 'north'), ('Feb', 180, 'south'), ('Mar', 150, 'north')")
  db.exec('CREATE TABLE "regions" (region TEXT, manager TEXT)')
  db.exec("INSERT INTO regions VALUES ('north', 'Li'), ('south', 'Wang')")
  db.close()
  return { file, base64: readFileSync(file).toString('base64') }
}

describe('SQLite connector', () => {
  it('lists tables and reads normalized rows', () => {
    const db = makeDatabase()
    const connectors = new SqliteConnectors(mkdtempSync(join(tmpdir(), 'tentacle-connector-')))
    const handle = connectors.open(db.base64)
    expect(handle.tables).toEqual(['regions', 'sales'])
    const rows = connectors.read(handle.id, 'sales')
    expect(rows.columns).toEqual([
      { name: 'month', type: 'string' },
      { name: 'revenue', type: 'number' },
      { name: 'region', type: 'string' },
    ])
    expect(rows.rows).toHaveLength(3)
    expect(rows.rows[0]).toEqual({ month: 'Jan', revenue: 120, region: 'north' })
    expect(() => connectors.read(handle.id, 'nope')).toThrowError(SqliteConnectorError)
    connectors.close(handle.id)
    expect(() => connectors.read(handle.id, 'sales')).toThrowError(/closed or expired/)
  })

  it('rejects non-SQLite uploads', () => {
    const connectors = new SqliteConnectors(mkdtempSync(join(tmpdir(), 'tentacle-connector-')))
    expect(() => connectors.open(Buffer.from('not a database').toString('base64'))).toThrowError(/not a SQLite/)
  })

  it('imports a SQLite table through the service', async () => {
    const db = makeDatabase()
    const app = new Context()
    const fiber = app.plugin(dataPlugin, { stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-data-')) })
    await fiber
    const service = app.tentacleData as TentacleData
    await service.ready
    const workspace = service.stateSnapshot().workspaces[0]!
    const handle = service.openSqlite(db.base64)
    const dataset = await service.importSqlite({ connectorId: handle.id, table: 'sales', workspaceId: workspace.id, name: 'SQLite sales' })
    expect(dataset.rowCount).toBe(3)
    expect(dataset.format).toBe('json')
    expect((await service.datasetRows(dataset.id)).rows[0]).toMatchObject({ month: 'Jan', revenue: 120 })
    service.closeSqlite(handle.id)
  })
})
