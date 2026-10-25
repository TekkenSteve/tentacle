/**
 * Admin REST surface for Data Studio, served at the gateway seat:
 *
 *   GET  /tentacle/api/data                 full state (metadata only)
 *   GET  /tentacle/api/data/datasets        rows of one dataset (query id/limit)
 *   POST /tentacle/api/data/workspaces/*     create | rename | remove
 *   POST /tentacle/api/data/datasets/*       import | remove
 *   POST /tentacle/api/data/threads/*        create | fork | rename | remove
 *   POST /tentacle/api/data/cards/*          create | update | remove
 *
 * Like the other Tentacle admin surfaces, the gateway has already proven the
 * caller's identity; the handler authorizes on the admin role (or the `data`
 * permission key when tenancy later publishes it).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GatewayRoute } from '@tentacle/gateway'
import type { DatabaseConfig, DatabaseTable } from './connectors/database.js'
import type { ObjectStoreConfig } from './connectors/objectstore.js'
import { DataError, type AgentPlanListener, type ConnectionInput, type TentacleData } from './service.js'
import type { ChartFilter, ChartRange, ChartSpec, DataOperation } from './types.js'

export const DATA_ADMIN_PREFIX = '/tentacle/api/data'

export interface DataAdminApi {
  stateSnapshot(): unknown
  datasetRows(id: string, limit?: number): Promise<unknown>
  createWorkspace(name: string): Promise<unknown>
  renameWorkspace(id: string, name: string): Promise<unknown>
  removeWorkspace(id: string): Promise<void>
  importDataset(input: { workspaceId: string; name: string; format: 'csv' | 'json'; content: string }): Promise<unknown>
  importUrl(input: { workspaceId: string; name: string; url: string; format?: 'csv' | 'json' }): Promise<unknown>
  workspaceSources(): readonly { id: string; title: string; path: string }[]
  listWorkspaceFiles(workspaceId: string, path: string): unknown
  importWorkspaceFile(input: { dataWorkspaceId: string; dshWorkspaceId: string; path: string; name: string }): Promise<unknown>
  refreshDataset(id: string): Promise<unknown>
  setAutoRefresh(id: string, seconds: number): Promise<unknown>
  deriveDataset(input: { datasetId: string; name: string; operation: DataOperation }): Promise<unknown>
  listConnections(): readonly unknown[]
  saveConnection(input: ConnectionInput): Promise<unknown>
  removeConnection(id: string): Promise<void>
  listDatabaseTables(input: { config?: DatabaseConfig; connectionId?: string }): Promise<unknown>
  importDatabaseQuery(input: {
    config?: DatabaseConfig
    connectionId?: string
    query: string
    workspaceId: string
    name: string
  }): Promise<unknown>
  importDatabase(input: {
    config?: DatabaseConfig
    connectionId?: string
    table: DatabaseTable
    workspaceId: string
    name: string
  }): Promise<unknown>
  openSqlite(contentBase64: string): { id: string; tables: readonly string[] }
  listObjectStore(input: { config?: ObjectStoreConfig; connectionId?: string }): Promise<unknown>
  importObject(input: { config?: ObjectStoreConfig; connectionId?: string; key: string; workspaceId: string; name: string }): Promise<unknown>
  openDuckDb(contentBase64: string): Promise<{ id: string; tables: readonly string[] }>
  importDuckDb(input: { connectorId: string; table: string; workspaceId: string; name: string }): Promise<unknown>
  closeDuckDb(id: string): void
  importSqlite(input: { connectorId: string; table: string; workspaceId: string; name: string }): Promise<unknown>
  closeSqlite(id: string): void
  createRelation(input: { workspaceId: string; leftDatasetId: string; leftColumn: string; rightDatasetId: string; rightColumn: string }): Promise<unknown>
  suggestRelations(workspaceId: string): Promise<unknown>
  removeRelation(id: string): Promise<void>
  joinDatasets(input: { leftDatasetId: string; rightDatasetId: string; leftColumn: string; rightColumn: string; how: 'inner' | 'left'; name: string }): Promise<unknown>
  removeDataset(id: string): Promise<void>
  createThread(input: { workspaceId: string; name: string; datasetId?: string; copyFromThreadId?: string }): Promise<unknown>
  forkThread(id: string): Promise<unknown>
  renameThread(id: string, name: string): Promise<unknown>
  removeThread(id: string): Promise<void>
  setThreadFilters(id: string, filters: readonly ChartFilter[], ranges?: readonly ChartRange[]): Promise<unknown>
  createCard(input: {
    threadId: string
    kind: 'dataset' | 'chart' | 'note'
    title: string
    datasetId?: string
    spec?: ChartSpec
    text?: string
    parentCardId?: string
  }): Promise<unknown>
  updateCard(input: { id: string; title?: string; spec?: ChartSpec; text?: string }): Promise<unknown>
  removeCard(id: string): Promise<void>
  askAgent(input: { threadId: string; prompt: string; datasetId?: string }, onEvent?: AgentPlanListener): Promise<unknown>
  refineChart(input: { cardId: string; instruction: string }): Promise<unknown>
  createReport(input: { workspaceId: string; threadId?: string; title: string; markdown: string }): Promise<unknown>
  updateReport(input: { id: string; title?: string; markdown?: string }): Promise<unknown>
  removeReport(id: string): Promise<void>
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new DataError('invalid-dataset', 'request body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text) as Record<string, unknown>
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function formatOf(value: unknown): 'csv' | 'json' {
  return value === 'json' ? 'json' : 'csv'
}

function specOf(value: unknown): ChartSpec | undefined {
  return typeof value === 'object' && value !== null ? value as ChartSpec : undefined
}

function operationOf(value: unknown): DataOperation {
  return (typeof value === 'object' && value !== null ? value : {}) as DataOperation
}

function errorStatus(error: unknown): { status: number; code: string } {
  if (error instanceof DataError) {
    const status = {
      'invalid-workspace': 400,
      'no-such-workspace': 404,
      'workspace-in-use': 409,
      'no-such-dataset': 404,
      'invalid-dataset': 400,
      'dataset-in-use': 409,
      'no-such-thread': 404,
      'no-such-card': 404,
      'no-such-report': 404,
      'invalid-card': 400,
      'invalid-chart': 400,
      'agent-unavailable': 503,
      'agent-failed': 502,
      'no-such-relation': 404,
      'invalid-relation': 400,
      'relation-in-use': 409,
      'invalid-connector': 400,
      'fetch-failed': 502,
      'workspace-unavailable': 503,
      'invalid-workspace-path': 400,
      'not-refreshable': 400,
      'invalid-refresh-interval': 400,
      'invalid-database': 400,
      'database-failed': 502,
      'invalid-object-store': 400,
      'object-store-failed': 502,
      'connections-unavailable': 503,
      'no-such-connection': 404,
      'invalid-connection': 400,
    }[error.code]
    return { status, code: error.code }
  }
  if (error instanceof SyntaxError) return { status: 400, code: 'bad-json' }
  return { status: 500, code: 'internal-error' }
}

interface Action {
  method: 'GET' | 'POST'
  path: string
  /** Request body cap; only the SQLite upload needs a large one. */
  bodyLimit?: number
  run(service: DataAdminApi, body: Record<string, unknown>, url: URL): Promise<unknown>
}

const ACTIONS: readonly Action[] = [
  { method: 'GET', path: '/', run: async (service) => service.stateSnapshot() },
  { method: 'GET', path: '/connections', run: async (s) => s.listConnections() },
  {
    method: 'POST', path: '/connections/create',
    run: async (s, b) => s.saveConnection({
      kind: b['kind'] === 'objectstore' ? 'objectstore' : 'database',
      name: str(b['name']),
      config: typeof b['config'] === 'object' && b['config'] !== null ? b['config'] as Record<string, unknown> : {},
      secret: str(b['secret']),
    }),
  },
  { method: 'POST', path: '/connections/remove', run: async (s, b) => { await s.removeConnection(str(b['id'])); return { ok: true } } },
  { method: 'GET', path: '/workspaces', run: async (s) => s.workspaceSources() },
  {
    method: 'GET', path: '/files',
    run: async (s, _b, url) => s.listWorkspaceFiles(
      url.searchParams.get('workspaceId') ?? '',
      url.searchParams.get('path') ?? '',
    ),
  },
  {
    method: 'GET', path: '/datasets',
    run: async (service, _body, url) => service.datasetRows(
      url.searchParams.get('id') ?? '',
      Number(url.searchParams.get('limit') ?? 2000),
    ),
  },
  { method: 'POST', path: '/workspaces/create', run: async (s, b) => s.createWorkspace(str(b['name'])) },
  { method: 'POST', path: '/workspaces/rename', run: async (s, b) => s.renameWorkspace(str(b['id']), str(b['name'])) },
  { method: 'POST', path: '/workspaces/remove', run: async (s, b) => { await s.removeWorkspace(str(b['id'])); return { ok: true } } },
  {
    method: 'POST', path: '/datasets/import',
    run: async (s, b) => s.importDataset({
      workspaceId: str(b['workspaceId']),
      name: str(b['name']),
      format: formatOf(b['format']),
      content: str(b['content']),
    }),
  },
  {
    method: 'POST', path: '/datasets/import-url',
    run: async (s, b) => s.importUrl({
      workspaceId: str(b['workspaceId']),
      name: str(b['name']),
      url: str(b['url']),
      ...(b['format'] === 'csv' || b['format'] === 'json' ? { format: b['format'] } : {}),
    }),
  },
  {
    method: 'POST', path: '/datasets/import-workspace',
    run: async (s, b) => s.importWorkspaceFile({
      dataWorkspaceId: str(b['dataWorkspaceId']),
      dshWorkspaceId: str(b['dshWorkspaceId']),
      path: str(b['path']),
      name: str(b['name']),
    }),
  },
  { method: 'POST', path: '/datasets/refresh', run: async (s, b) => s.refreshDataset(str(b['id'])) },
  {
    method: 'POST', path: '/datasets/auto-refresh',
    run: async (s, b) => s.setAutoRefresh(str(b['id']), Number(b['seconds'] ?? 0)),
  },
  {
    method: 'POST', path: '/datasets/derive',
    run: async (s, b) => s.deriveDataset({
      datasetId: str(b['datasetId']),
      name: str(b['name']),
      operation: operationOf(b['operation']),
    }),
  },
  {
    method: 'POST', path: '/datasets/join',
    run: async (s, b) => s.joinDatasets({
      leftDatasetId: str(b['leftDatasetId']),
      rightDatasetId: str(b['rightDatasetId']),
      leftColumn: str(b['leftColumn']),
      rightColumn: str(b['rightColumn']),
      how: b['how'] === 'left' ? 'left' : 'inner',
      name: str(b['name']),
    }),
  },
  { method: 'POST', path: '/datasets/remove', run: async (s, b) => { await s.removeDataset(str(b['id'])); return { ok: true } } },
  {
    method: 'GET', path: '/relations/suggest',
    run: async (s, _b, url) => s.suggestRelations(url.searchParams.get('workspaceId') ?? ''),
  },
  {
    method: 'POST', path: '/relations/create',
    run: async (s, b) => s.createRelation({
      workspaceId: str(b['workspaceId']),
      leftDatasetId: str(b['leftDatasetId']),
      leftColumn: str(b['leftColumn']),
      rightDatasetId: str(b['rightDatasetId']),
      rightColumn: str(b['rightColumn']),
    }),
  },
  { method: 'POST', path: '/relations/remove', run: async (s, b) => { await s.removeRelation(str(b['id'])); return { ok: true } } },
  {
    method: 'POST', path: '/threads/create',
    run: async (s, b) => s.createThread({
      workspaceId: str(b['workspaceId']),
      name: str(b['name']),
      ...(b['datasetId'] === undefined ? {} : { datasetId: str(b['datasetId']) }),
      ...(b['copyFromThreadId'] === undefined ? {} : { copyFromThreadId: str(b['copyFromThreadId']) }),
    }),
  },
  { method: 'POST', path: '/threads/fork', run: async (s, b) => s.forkThread(str(b['id'])) },
  { method: 'POST', path: '/threads/rename', run: async (s, b) => s.renameThread(str(b['id']), str(b['name'])) },
  { method: 'POST', path: '/threads/remove', run: async (s, b) => { await s.removeThread(str(b['id'])); return { ok: true } } },
  {
    method: 'POST', path: '/threads/filters',
    run: async (s, b) => s.setThreadFilters(
      str(b['id']),
      Array.isArray(b['filters']) ? b['filters'] as ChartFilter[] : [],
      Array.isArray(b['ranges']) ? b['ranges'] as ChartRange[] : [],
    ),
  },
  {
    method: 'POST', path: '/cards/create',
    run: async (s, b) => s.createCard({
      threadId: str(b['threadId']),
      kind: b['kind'] === 'chart' ? 'chart' : b['kind'] === 'note' ? 'note' : 'dataset',
      title: str(b['title']),
      ...(b['datasetId'] === undefined ? {} : { datasetId: str(b['datasetId']) }),
      ...(b['spec'] === undefined ? {} : { spec: specOf(b['spec']) }),
      ...(b['text'] === undefined ? {} : { text: str(b['text']) }),
      ...(b['parentCardId'] === undefined ? {} : { parentCardId: str(b['parentCardId']) }),
    }),
  },
  {
    method: 'POST', path: '/cards/update',
    run: async (s, b) => s.updateCard({
      id: str(b['id']),
      ...(b['title'] === undefined ? {} : { title: str(b['title']) }),
      ...(b['spec'] === undefined ? {} : { spec: specOf(b['spec']) }),
      ...(b['text'] === undefined ? {} : { text: str(b['text']) }),
    }),
  },
  { method: 'POST', path: '/cards/remove', run: async (s, b) => { await s.removeCard(str(b['id'])); return { ok: true } } },
  {
    method: 'POST', path: '/reports/create',
    run: async (s, b) => s.createReport({
      workspaceId: str(b['workspaceId']),
      ...(b['threadId'] === undefined ? {} : { threadId: str(b['threadId']) }),
      title: str(b['title']),
      markdown: str(b['markdown']),
    }),
  },
  {
    method: 'POST', path: '/reports/update',
    run: async (s, b) => s.updateReport({
      id: str(b['id']),
      ...(b['title'] === undefined ? {} : { title: str(b['title']) }),
      ...(b['markdown'] === undefined ? {} : { markdown: str(b['markdown']) }),
    }),
  },
  { method: 'POST', path: '/reports/remove', run: async (s, b) => { await s.removeReport(str(b['id'])); return { ok: true } } },
  {
    method: 'POST', path: '/connectors/database/test',
    run: async (s, b) => s.listDatabaseTables({
      ...(typeof b['connectionId'] === 'string' ? { connectionId: b['connectionId'] } : { config: b as unknown as DatabaseConfig }),
    }),
  },
  {
    method: 'POST', path: '/connectors/database/query',
    run: async (s, b) => s.importDatabaseQuery({
      ...(typeof b['connectionId'] === 'string' ? { connectionId: b['connectionId'] } : { config: b['config'] as DatabaseConfig }),
      query: str(b['query']),
      workspaceId: str(b['workspaceId']),
      name: str(b['name']),
    }),
  },
  {
    method: 'POST', path: '/connectors/database/import',
    run: async (s, b) => s.importDatabase({
      ...(typeof b['connectionId'] === 'string' ? { connectionId: b['connectionId'] } : { config: b['config'] as DatabaseConfig }),
      table: b['table'] as DatabaseTable,
      workspaceId: str(b['workspaceId']),
      name: str(b['name']),
    }),
  },
  {
    method: 'POST', path: '/connectors/objectstore/test',
    run: async (s, b) => s.listObjectStore({
      ...(typeof b['connectionId'] === 'string' ? { connectionId: b['connectionId'] } : { config: b as unknown as ObjectStoreConfig }),
    }),
  },
  {
    method: 'POST', path: '/connectors/objectstore/import',
    run: async (s, b) => s.importObject({
      ...(typeof b['connectionId'] === 'string' ? { connectionId: b['connectionId'] } : { config: b['config'] as ObjectStoreConfig }),
      key: str(b['key']),
      workspaceId: str(b['workspaceId']),
      name: str(b['name']),
    }),
  },
  {
    method: 'POST', path: '/connectors/duckdb/open',
    bodyLimit: 96 * 1024 * 1024,
    run: async (s, b) => s.openDuckDb(str(b['contentBase64'])),
  },
  {
    method: 'POST', path: '/connectors/duckdb/import',
    run: async (s, b) => s.importDuckDb({
      connectorId: str(b['connectorId']),
      table: str(b['table']),
      workspaceId: str(b['workspaceId']),
      name: str(b['name']),
    }),
  },
  { method: 'POST', path: '/connectors/duckdb/close', run: async (s, b) => { s.closeDuckDb(str(b['id'])); return { ok: true } } },
  {
    method: 'POST', path: '/connectors/sqlite/open',
    bodyLimit: 48 * 1024 * 1024,
    run: async (s, b) => s.openSqlite(str(b['contentBase64'])),
  },
  {
    method: 'POST', path: '/connectors/sqlite/import',
    run: async (s, b) => s.importSqlite({
      connectorId: str(b['connectorId']),
      table: str(b['table']),
      workspaceId: str(b['workspaceId']),
      name: str(b['name']),
    }),
  },
  { method: 'POST', path: '/connectors/sqlite/close', run: async (s, b) => { s.closeSqlite(str(b['id'])); return { ok: true } } },
  {
    method: 'POST', path: '/charts/refine',
    run: async (s, b) => s.refineChart({ cardId: str(b['cardId']), instruction: str(b['instruction']) }),
  },
  {
    method: 'POST', path: '/agent',
    run: async (s, b) => s.askAgent({
      threadId: str(b['threadId']),
      prompt: str(b['prompt']),
      ...(b['datasetId'] === undefined ? {} : { datasetId: str(b['datasetId']) }),
    }),
  },
]

/** Build the gateway route for Data Studio. */
export function createDataRoutes(service: TentacleData): GatewayRoute[] {
  return [{
    prefix: DATA_ADMIN_PREFIX,
    handler: async (req, res, context) => {
      const identity = context.identity
      const allowed = identity !== undefined && (
        identity.roles?.includes('admin') === true
        || identity.permissions?.includes('data') === true
      )
      if (!allowed) {
        writeJson(res, 403, { error: 'permission required: data or admin' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://tentacle.local')
      const path = url.pathname.slice(DATA_ADMIN_PREFIX.length) || '/'
      if (req.method === 'POST' && path === '/agent/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        const send = (event: unknown): void => { res.write(`data: ${JSON.stringify(event)}\n\n`) }
        try {
          const body = await readJson(req)
          const result = await service.askAgent({
            threadId: str(body['threadId']),
            prompt: str(body['prompt']),
            ...(body['datasetId'] === undefined ? {} : { datasetId: str(body['datasetId']) }),
          }, send)
          send({ type: 'result', result })
        } catch (error) {
          const { code } = errorStatus(error)
          send({ type: 'error', error: code })
        }
        res.end()
        return
      }
      const action = ACTIONS.find((candidate) => candidate.method === req.method && candidate.path === path)
      if (action === undefined) {
        writeJson(res, 404, { error: 'no such data action' })
        return
      }
      try {
        const body = req.method === 'GET' ? {} : await readJson(req, action.bodyLimit)
        writeJson(res, 200, await action.run(service, body, url))
      } catch (error) {
        const { status, code } = errorStatus(error)
        writeJson(res, status, { error: code })
      }
    },
  }]
}
