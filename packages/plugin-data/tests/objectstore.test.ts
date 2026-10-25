import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as dataPlugin from '../src/index.js'
import { normalizeObjectStoreConfig, ObjectStoreError, type ObjectStoreDriver } from '../src/connectors/objectstore.js'
import type { TentacleData } from '../src/service.js'

const s3Config = { provider: 's3' as const, bucket: 'b', region: 'us-east-1', accessKeyId: 'key', secretAccessKey: 'secret' }

const fakeDriver: ObjectStoreDriver = {
  async listObjects() {
    return [{ key: 'exports/sales.csv', size: 20 }]
  },
  async readObject(_config, key) {
    expect(key).toBe('exports/sales.csv')
    return { content: 'month,revenue\nJan,10\nFeb,20\n', format: 'csv' }
  },
}

async function boot(driver?: ObjectStoreDriver): Promise<TentacleData> {
  const app = new Context()
  const fiber = app.plugin(dataPlugin, {
    stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-data-')),
    ...(driver === undefined ? {} : { objectStoreDriver: driver }),
  })
  await fiber
  const service = app.tentacleData as TentacleData
  await service.ready
  return service
}

describe('object store connector', () => {
  it('validates S3 and Azure configs', () => {
    expect(normalizeObjectStoreConfig({ ...s3Config, bucket: ' b ' })).toMatchObject({ bucket: 'b' })
    expect(() => normalizeObjectStoreConfig({ ...s3Config, bucket: '' })).toThrowError(ObjectStoreError)
    expect(() => normalizeObjectStoreConfig({ provider: 'azure', container: '', connectionString: 'x' })).toThrowError(/required/)
    expect(normalizeObjectStoreConfig({ provider: 'azure', container: 'c', connectionString: 's', prefix: 'p' })).toMatchObject({ prefix: 'p' })
  })

  it('lists and imports an object through the service', async () => {
    const service = await boot(fakeDriver)
    const workspace = service.stateSnapshot().workspaces[0]!
    expect(await service.listObjectStore({ config: s3Config })).toEqual([{ key: 'exports/sales.csv', size: 20 }])
    const dataset = await service.importObject({ config: s3Config, key: 'exports/sales.csv', workspaceId: workspace.id, name: 'S3 sales' })
    expect(dataset.rowCount).toBe(2)
    expect((await service.datasetRows(dataset.id)).rows[1]).toMatchObject({ month: 'Feb', revenue: 20 })
  })

  it('maps driver failures to object-store errors', async () => {
    const service = await boot({
      listObjects: async () => { throw new ObjectStoreError('connection-failed', 'denied') },
      readObject: async () => { throw new ObjectStoreError('object-failed', 'missing') },
    })
    await expect(service.listObjectStore({ config: s3Config })).rejects.toMatchObject({ code: 'object-store-failed' })
  })
})
