import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as dataPlugin from '../src/index.js'
import type { TentacleData } from '../src/service.js'

let server: Server
let base = ''
let csvBody = 'month,revenue\nJan,10\nFeb,20\n'

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/sales.csv') {
      res.writeHead(200, { 'content-type': 'text/csv' })
      res.end(csvBody)
      return
    }
    if (req.url === '/sales.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[{"month":"Jan","revenue":10},{"month":"Feb","revenue":20}]')
      return
    }
    res.writeHead(500)
    res.end('nope')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
})

async function boot(): Promise<TentacleData> {
  const app = new Context()
  const fiber = app.plugin(dataPlugin, { stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-data-')) })
  await fiber
  const service = app.tentacleData as TentacleData
  await service.ready
  return service
}

describe('URL import', () => {
  it('fetches CSV and JSON documents', async () => {
    const service = await boot()
    const workspace = service.stateSnapshot().workspaces[0]!
    const csv = await service.importUrl({ workspaceId: workspace.id, name: 'CSV sales', url: `${base}/sales.csv` })
    expect(csv.rowCount).toBe(2)
    expect(csv.columns.map((column) => column.name)).toEqual(['month', 'revenue'])
    const json = await service.importUrl({ workspaceId: workspace.id, name: 'JSON sales', url: `${base}/sales.json`, format: 'json' })
    expect(json.rowCount).toBe(2)
    expect((await service.datasetRows(json.id)).rows[0]).toMatchObject({ month: 'Jan', revenue: 10 })
    expect(csv.source).toMatchObject({ kind: 'url', format: 'csv' })

    csvBody = 'month,revenue\nJan,10\nFeb,20\nMar,30\n'
    const refreshed = await service.refreshDataset(csv.id)
    expect(refreshed.rowCount).toBe(3)
    expect(refreshed.refreshedAt).toBeTypeOf('number')
    expect((await service.datasetRows(csv.id)).rows[2]).toMatchObject({ month: 'Mar', revenue: 30 })

    const scheduled = await service.setAutoRefresh(csv.id, 60)
    expect(scheduled.autoRefreshSec).toBe(60)
    csvBody = 'month,revenue\nJan,11\nFeb,21\nMar,31\nApr,41\n'
    await service.runDueRefreshes(Date.now() + 61_000)
    const auto = service.stateSnapshot().datasets.find((dataset) => dataset.id === csv.id)
    expect(auto?.rowCount).toBe(4)
    expect(auto?.autoRefreshSec).toBe(60)
  })

  it('rejects non-http URLs and failed responses', async () => {
    const service = await boot()
    const workspace = service.stateSnapshot().workspaces[0]!
    await expect(service.importUrl({ workspaceId: workspace.id, name: 'bad', url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'invalid-dataset' })
    await expect(service.importUrl({ workspaceId: workspace.id, name: 'bad', url: `${base}/missing` })).rejects.toMatchObject({ code: 'fetch-failed' })
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'local', format: 'csv', content: 'a\n1\n' })
    await expect(service.refreshDataset(dataset.id)).rejects.toMatchObject({ code: 'not-refreshable' })
    await expect(service.setAutoRefresh(dataset.id, 60)).rejects.toMatchObject({ code: 'not-refreshable' })
    await expect(service.setAutoRefresh(dataset.id, 30)).rejects.toMatchObject({ code: 'invalid-refresh-interval' })
  })
})
