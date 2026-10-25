import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as dataPlugin from '../src/index.js'
import type { DatabaseDriver } from '../src/connectors/database.js'
import type { ObjectStoreDriver } from '../src/connectors/objectstore.js'
import type { CredentialsLike } from '../src/service.js'
import type { TentacleData } from '../src/service.js'

function fakeCredentials(): CredentialsLike & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    async resolve(ref) { const value = values.get(ref); return value === undefined ? undefined : { value } },
    async set(ref, value) { values.set(ref, value) },
    async unset(ref) { values.delete(ref) },
  }
}

async function boot(input: { credentials?: CredentialsLike; databaseDriver?: DatabaseDriver; objectStoreDriver?: ObjectStoreDriver }): Promise<TentacleData> {
  const app = new Context()
  const fiber = app.plugin(dataPlugin, {
    stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-data-')),
    ...input,
  })
  await fiber
  const service = app.tentacleData as TentacleData
  await service.ready
  return service
}

const dbConfig = { engine: 'postgres' as const, host: 'db', port: 5432, database: 'analytics', user: 'reader' }

describe('saved connections', () => {
  it('stores the secret outside state and resolves it for imports', async () => {
    const credentials = fakeCredentials()
    let seenPassword = ''
    const driver: DatabaseDriver = {
      async listTables() { return [] },
      async readTable(config) {
        seenPassword = config.password
        return { columns: [{ name: 'a', type: 'number' }], rows: [{ a: 1 }] }
      },
      async readQuery() { return { columns: [], rows: [] } },
    }
    const service = await boot({ credentials, databaseDriver: driver })
    const workspace = service.stateSnapshot().workspaces[0]!
    const profile = await service.saveConnection({ kind: 'database', name: 'Prod', config: dbConfig, secret: 's3cret' })
    expect(profile.credentialRef).toMatch(/^TENTACLE_DATA_CONN_/)
    expect(credentials.values.get(profile.credentialRef)).toBe('s3cret')
    expect(JSON.stringify(service.stateSnapshot().connections)).not.toContain('s3cret')
    expect(JSON.stringify(profile.config)).not.toContain('password')
    const dataset = await service.importDatabase({
      connectionId: profile.id,
      table: { schema: 'public', name: 'sales', label: 'public.sales' },
      workspaceId: workspace.id,
      name: 'Saved query',
    })
    expect(seenPassword).toBe('s3cret')
    expect(dataset.rowCount).toBe(1)
    await service.removeConnection(profile.id)
    expect(credentials.values.has(profile.credentialRef)).toBe(false)
    await expect(service.importDatabase({
      connectionId: profile.id,
      table: { name: 'sales', label: 'sales' },
      workspaceId: workspace.id,
      name: 'gone',
    })).rejects.toMatchObject({ code: 'no-such-connection' })
  })

  it('saves object-store profiles and injects the secret', async () => {
    const credentials = fakeCredentials()
    let seenSecret = ''
    const driver: ObjectStoreDriver = {
      async listObjects() { return [] },
      async readObject(config) {
        seenSecret = config.provider === 's3' ? config.secretAccessKey : config.connectionString
        return { content: 'a\n1\n', format: 'csv' }
      },
    }
    const service = await boot({ credentials, objectStoreDriver: driver })
    const workspace = service.stateSnapshot().workspaces[0]!
    const profile = await service.saveConnection({
      kind: 'objectstore',
      name: 'Bucket',
      config: { provider: 's3', bucket: 'b', region: 'us-east-1', accessKeyId: 'key' },
      secret: 'topsecret',
    })
    const dataset = await service.importObject({ connectionId: profile.id, key: 'x.csv', workspaceId: workspace.id, name: 'obj' })
    expect(seenSecret).toBe('topsecret')
    expect(dataset.rowCount).toBe(1)
    expect(JSON.stringify(service.stateSnapshot().connections)).not.toContain('topsecret')
  })

  it('reports missing credential service', async () => {
    const service = await boot({})
    await expect(service.saveConnection({ kind: 'database', name: 'x', config: dbConfig, secret: 's' })).rejects.toMatchObject({ code: 'connections-unavailable' })
  })
})
