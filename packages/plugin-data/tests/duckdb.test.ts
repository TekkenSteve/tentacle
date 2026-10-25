import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as dataPlugin from '../src/index.js'
import { DuckDbConnectors, DuckDbConnectorError } from '../src/connectors/duckdb.js'
import type { TentacleData } from '../src/service.js'

async function makeDatabase(): Promise<{ file: string; base64: string }> {
  const file = join(mkdtempSync(join(tmpdir(), 'tentacle-duckdb-')), 'sales.duckdb')
  const instance = await DuckDBInstance.create(file)
  const connection = await instance.connect()
  await connection.run('CREATE TABLE sales (month VARCHAR, revenue DOUBLE)')
  await connection.run("INSERT INTO sales VALUES ('Jan', 10), ('Feb', 20)")
  await connection.run('CREATE TABLE regions (region VARCHAR)')
  connection.closeSync()
  instance.closeSync()
  return { file, base64: readFileSync(file).toString('base64') }
}

describe('DuckDB connector', () => {
  it('lists tables and reads rows', async () => {
    const db = await makeDatabase()
    const connectors = new DuckDbConnectors(mkdtempSync(join(tmpdir(), 'tentacle-duckdb-root-')))
    const handle = await connectors.open(db.base64)
    expect(handle.tables).toEqual(['regions', 'sales'])
    const rows = await connectors.read(handle.id, 'sales')
    expect(rows.columns).toEqual([
      { name: 'month', type: 'string' },
      { name: 'revenue', type: 'number' },
    ])
    expect(rows.rows).toEqual([{ month: 'Jan', revenue: 10 }, { month: 'Feb', revenue: 20 }])
    await expect(connectors.read(handle.id, 'nope')).rejects.toThrowError(DuckDbConnectorError)
    connectors.close(handle.id)
  })

  it('rejects non-DuckDB uploads', async () => {
    const connectors = new DuckDbConnectors(mkdtempSync(join(tmpdir(), 'tentacle-duckdb-root-')))
    await expect(connectors.open(Buffer.from('not a duckdb file').toString('base64'))).rejects.toThrowError(DuckDbConnectorError)
  })

  it('imports a DuckDB table through the service', async () => {
    const db = await makeDatabase()
    const app = new Context()
    const fiber = app.plugin(dataPlugin, { stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-data-')) })
    await fiber
    const service = app.tentacleData as TentacleData
    await service.ready
    const workspace = service.stateSnapshot().workspaces[0]!
    const handle = await service.openDuckDb(db.base64)
    const dataset = await service.importDuckDb({ connectorId: handle.id, table: 'sales', workspaceId: workspace.id, name: 'DuckDB sales' })
    expect(dataset.rowCount).toBe(2)
    expect((await service.datasetRows(dataset.id)).rows[0]).toMatchObject({ month: 'Jan', revenue: 10 })
    service.closeDuckDb(handle.id)
  })
})
