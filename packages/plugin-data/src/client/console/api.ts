/**
 * Browser client for the Data Studio admin API. Wire shapes mirror the host
 * domain; the client bundle may not import the host half, so this is the
 * deliberate small mirror the panel renders.
 */
import type { DataStudioLocaleKey, Translate } from '../locales.ts'

export type DataColumnType = 'number' | 'string' | 'boolean' | 'date' | 'unknown'

export interface DataColumn {
  readonly name: string
  readonly type: DataColumnType
}

export type AggregateFunction = 'sum' | 'avg' | 'count' | 'min' | 'max'
export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains'

export interface GroupAggregate {
  readonly column: string
  readonly fn: AggregateFunction
  readonly as?: string
}

export interface GroupOperation {
  readonly kind: 'group'
  readonly groupBy: readonly string[]
  readonly aggregates: readonly GroupAggregate[]
}

export interface FilterOperation {
  readonly kind: 'filter'
  readonly column: string
  readonly op: FilterOperator
  readonly value: string | number | boolean
}

export type DataOperation = GroupOperation | FilterOperation

export type JoinKind = 'inner' | 'left'

export interface JoinSpec {
  readonly leftDatasetId: string
  readonly rightDatasetId: string
  readonly leftColumn: string
  readonly rightColumn: string
  readonly how: JoinKind
}

export interface RelationSuggestion {
  readonly leftDatasetId: string
  readonly leftDatasetName: string
  readonly leftColumn: string
  readonly rightDatasetId: string
  readonly rightDatasetName: string
  readonly rightColumn: string
  readonly score: number
  readonly leftDistinct: number
  readonly rightDistinct: number
}

export interface DataRelation {
  readonly id: string
  readonly workspaceId: string
  readonly leftDatasetId: string
  readonly leftColumn: string
  readonly rightDatasetId: string
  readonly rightColumn: string
  readonly createdAt: number
}

export interface UrlDatasetSource {
  readonly kind: 'url'
  readonly url: string
  readonly format: 'csv' | 'json'
}

export interface WorkspaceDatasetSource {
  readonly kind: 'workspace'
  readonly dshWorkspaceId: string
  readonly path: string
  readonly format: 'csv' | 'json'
}

export type DatasetSource = UrlDatasetSource | WorkspaceDatasetSource

export interface DatasetMeta {
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  readonly format: 'csv' | 'json'
  readonly columns: readonly DataColumn[]
  readonly rowCount: number
  readonly sourceDatasetId?: string
  readonly operation?: DataOperation
  readonly join?: JoinSpec
  readonly source?: DatasetSource
  readonly refreshedAt?: number
  readonly autoRefreshSec?: number
  readonly lastRefreshAttemptAt?: number
  readonly lastRefreshError?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export type Scalar = string | number | boolean | null
export interface DatasetRows {
  readonly columns: readonly DataColumn[]
  readonly rows: readonly Readonly<Record<string, Scalar>>[]
}

export type ChartKind = 'bar' | 'line' | 'area' | 'scatter' | 'pie' | 'donut' | 'horizontalBar' | 'heatmap' | 'boxplot' | 'bump' | 'streamgraph' | 'waterfall' | 'rose' | 'radar' | 'groupedBar' | 'stackedBar' | 'candlestick' | 'gantt' | 'histogram' | 'density' | 'violin' | 'kpi' | 'rangeArea' | 'bullet' | 'barTable' | 'table' | 'rangeDot' | 'map' | 'choropleth' | 'marginal' | 'regression' | 'connectedScatter' | 'strip' | 'lollipop' | 'pyramid' | 'slope' | 'sparkline' | 'ridgeline' | 'ecdf' | 'calendarHeatmap'
export type ChartAggregate = 'sum' | 'avg' | 'count' | 'none'
export type ChartTheme = 'default' | 'warm' | 'cool' | 'mono'

export interface ChartFilter {
  readonly column: string
  readonly values: readonly string[]
}

export type ChartSort = 'none' | 'asc' | 'desc'

export interface ChartRange {
  readonly column: string
  readonly min?: number
  readonly max?: number
}

export interface ChartAnnotations {
  readonly max?: boolean
  readonly mean?: boolean
  readonly labels?: boolean
}

export interface ChartSpec {
  readonly chart: ChartKind
  readonly x: string
  readonly y?: string
  readonly aggregate: ChartAggregate
  readonly color?: string
  readonly size?: string
  readonly value?: string
  readonly open?: string
  readonly high?: string
  readonly low?: string
  readonly close?: string
  readonly x2?: string
  readonly goal?: string
  readonly y2?: string
  readonly facet?: string
  readonly sort?: ChartSort
  readonly title?: string
  readonly theme?: ChartTheme
  readonly filters?: readonly ChartFilter[]
  readonly range?: ChartRange
  readonly annotations?: ChartAnnotations
  readonly chartProperties?: Readonly<Record<string, unknown>>
}

interface CardBase {
  readonly id: string
  readonly threadId: string
  readonly title: string
  readonly createdAt: number
  readonly parentCardId?: string
}

export interface DatasetCard extends CardBase {
  readonly kind: 'dataset'
  readonly datasetId: string
}

export interface ChartVariant {
  readonly id: string
  readonly label: string
  readonly spec: ChartSpec
  readonly rationale?: string
  readonly createdAt: number
}

export interface ChartCard extends CardBase {
  readonly kind: 'chart'
  readonly variants?: readonly ChartVariant[]
  readonly datasetId: string
  readonly spec: ChartSpec
}

export interface NoteCard extends CardBase {
  readonly kind: 'note'
  readonly text: string
}

export type PlanStatus = 'running' | 'done' | 'error'

export interface PlanCard extends CardBase {
  readonly kind: 'plan'
  readonly prompt: string
  readonly steps: readonly string[]
  readonly status: PlanStatus
}

export type DataCard = DatasetCard | ChartCard | NoteCard | PlanCard

export interface DataThread {
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  readonly parentThreadId?: string
  readonly filters?: readonly ChartFilter[]
  readonly ranges?: readonly ChartRange[]
  readonly createdAt: number
  readonly updatedAt: number
}

export interface DataReport {
  readonly id: string
  readonly workspaceId: string
  readonly threadId?: string
  readonly title: string
  readonly markdown: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface DataWorkspace {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface DataState {
  readonly version: 1
  readonly workspaces: readonly DataWorkspace[]
  readonly datasets: readonly DatasetMeta[]
  readonly threads: readonly DataThread[]
  readonly cards: readonly DataCard[]
  readonly reports: readonly DataReport[]
  readonly relations: readonly DataRelation[]
}

const PREFIX = '/tentacle/api/data'

export class DataApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'DataApiError'
  }
}

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const code = typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : String(response.status)
    throw new DataApiError(code, response.status)
  }
  return payload as T
}

export async function loadState(): Promise<DataState> {
  return await request<DataState>(`${PREFIX}/`)
}

export async function loadDatasetRows(id: string, limit = 2000): Promise<DatasetRows> {
  return await request<DatasetRows>(`${PREFIX}/datasets?id=${encodeURIComponent(id)}&limit=${limit}`)
}

export async function createWorkspace(name: string): Promise<DataWorkspace> {
  return await request<DataWorkspace>(`${PREFIX}/workspaces/create`, { name })
}

export async function importDataset(input: {
  workspaceId: string
  name: string
  format: 'csv' | 'json'
  content: string
}): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/datasets/import`, input)
}

export async function refreshDataset(id: string): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/datasets/refresh`, { id })
}

export async function setAutoRefresh(id: string, seconds: number): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/datasets/auto-refresh`, { id, seconds })
}

export async function importUrl(input: {
  workspaceId: string
  name: string
  url: string
  format?: 'csv' | 'json'
}): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/datasets/import-url`, input)
}

export async function deriveDataset(input: { datasetId: string; name: string; operation: DataOperation }): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/datasets/derive`, input)
}

export interface WorkspaceSource {
  readonly id: string
  readonly title: string
  readonly path: string
}

export interface WorkspaceFileEntry {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly size?: number
}

export interface WorkspaceFileListing {
  readonly path: string
  readonly parent?: string
  readonly entries: readonly WorkspaceFileEntry[]
}

export async function listWorkspaceSources(): Promise<readonly WorkspaceSource[]> {
  return await request<readonly WorkspaceSource[]>(`${PREFIX}/workspaces`)
}

export async function listWorkspaceFiles(workspaceId: string, path: string): Promise<WorkspaceFileListing> {
  return await request<WorkspaceFileListing>(`${PREFIX}/files?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`)
}

export async function importWorkspaceFile(input: {
  dataWorkspaceId: string
  dshWorkspaceId: string
  path: string
  name: string
}): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/datasets/import-workspace`, input)
}

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
  readonly label: string
}

export async function listDatabaseTables(input: { config?: DatabaseConfig; connectionId?: string }): Promise<readonly DatabaseTable[]> {
  return await request<readonly DatabaseTable[]>(`${PREFIX}/connectors/database/test`, input)
}

export async function importDatabaseQuery(input: {
  config?: DatabaseConfig
  connectionId?: string
  query: string
  workspaceId: string
  name: string
}): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/connectors/database/query`, input)
}

export async function importDatabase(input: {
  config?: DatabaseConfig
  connectionId?: string
  table: DatabaseTable
  workspaceId: string
  name: string
}): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/connectors/database/import`, input)
}

export interface DataConnectionProfile {
  readonly id: string
  readonly kind: 'database' | 'objectstore'
  readonly name: string
  readonly config: Record<string, unknown>
  readonly credentialRef: string
  readonly createdAt: number
}

export async function listConnections(): Promise<readonly DataConnectionProfile[]> {
  return await request<readonly DataConnectionProfile[]>(`${PREFIX}/connections`)
}

export async function saveConnection(input: {
  kind: 'database' | 'objectstore'
  name: string
  config: Record<string, unknown>
  secret: string
}): Promise<DataConnectionProfile> {
  return await request<DataConnectionProfile>(`${PREFIX}/connections/create`, input)
}

export async function removeConnection(id: string): Promise<void> {
  await request<unknown>(`${PREFIX}/connections/remove`, { id })
}

export type ObjectStoreProvider = 's3' | 'azure'

export interface S3Config {
  readonly provider: 's3'
  readonly bucket: string
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly endpoint?: string
  readonly prefix?: string
}

export interface AzureBlobConfig {
  readonly provider: 'azure'
  readonly container: string
  readonly connectionString: string
  readonly prefix?: string
}

export type ObjectStoreConfig = S3Config | AzureBlobConfig

export interface ObjectEntry {
  readonly key: string
  readonly size?: number
  readonly lastModified?: string
}

export async function listObjectStore(input: { config?: ObjectStoreConfig; connectionId?: string }): Promise<readonly ObjectEntry[]> {
  return await request<readonly ObjectEntry[]>(`${PREFIX}/connectors/objectstore/test`, input)
}

export async function importObject(input: {
  config?: ObjectStoreConfig
  connectionId?: string
  key: string
  workspaceId: string
  name: string
}): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/connectors/objectstore/import`, input)
}

export async function openDuckDb(contentBase64: string): Promise<{ id: string; tables: readonly string[] }> {
  return await request<{ id: string; tables: readonly string[] }>(`${PREFIX}/connectors/duckdb/open`, { contentBase64 })
}

export async function importDuckDb(input: {
  connectorId: string
  table: string
  workspaceId: string
  name: string
}): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/connectors/duckdb/import`, input)
}

export async function closeDuckDb(id: string): Promise<void> {
  await request<unknown>(`${PREFIX}/connectors/duckdb/close`, { id })
}

export async function openSqlite(contentBase64: string): Promise<{ id: string; tables: readonly string[] }> {
  return await request<{ id: string; tables: readonly string[] }>(`${PREFIX}/connectors/sqlite/open`, { contentBase64 })
}

export async function importSqlite(input: {
  connectorId: string
  table: string
  workspaceId: string
  name: string
}): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/connectors/sqlite/import`, input)
}

export async function closeSqlite(id: string): Promise<void> {
  await request<unknown>(`${PREFIX}/connectors/sqlite/close`, { id })
}

export async function listRelationSuggestions(workspaceId: string): Promise<readonly RelationSuggestion[]> {
  return await request<readonly RelationSuggestion[]>(`${PREFIX}/relations/suggest?workspaceId=${encodeURIComponent(workspaceId)}`)
}

export async function createRelation(input: {
  workspaceId: string
  leftDatasetId: string
  leftColumn: string
  rightDatasetId: string
  rightColumn: string
}): Promise<DataRelation> {
  return await request<DataRelation>(`${PREFIX}/relations/create`, input)
}

export async function removeRelation(id: string): Promise<void> {
  await request<unknown>(`${PREFIX}/relations/remove`, { id })
}

export async function joinDatasets(input: {
  leftDatasetId: string
  rightDatasetId: string
  leftColumn: string
  rightColumn: string
  how: JoinKind
  name: string
}): Promise<DatasetMeta> {
  return await request<DatasetMeta>(`${PREFIX}/datasets/join`, input)
}

export async function removeDataset(id: string): Promise<void> {
  await request<unknown>(`${PREFIX}/datasets/remove`, { id })
}

export async function createThread(input: {
  workspaceId: string
  name: string
  datasetId?: string
  copyFromThreadId?: string
}): Promise<DataThread> {
  return await request<DataThread>(`${PREFIX}/threads/create`, input)
}

export async function forkThread(id: string): Promise<DataThread> {
  return await request<DataThread>(`${PREFIX}/threads/fork`, { id })
}

export async function setThreadFilters(id: string, filters: readonly ChartFilter[], ranges: readonly ChartRange[] = []): Promise<DataThread> {
  return await request<DataThread>(`${PREFIX}/threads/filters`, { id, filters, ranges })
}

export async function renameThread(id: string, name: string): Promise<DataThread> {
  return await request<DataThread>(`${PREFIX}/threads/rename`, { id, name })
}

export async function removeThread(id: string): Promise<void> {
  await request<unknown>(`${PREFIX}/threads/remove`, { id })
}

export async function createCard(input: {
  threadId: string
  kind: 'dataset' | 'chart' | 'note'
  title: string
  datasetId?: string
  spec?: ChartSpec
  text?: string
  parentCardId?: string
}): Promise<DataCard> {
  return await request<DataCard>(`${PREFIX}/cards/create`, input)
}

export async function updateCard(input: {
  id: string
  title?: string
  spec?: ChartSpec
  text?: string
}): Promise<DataCard> {
  return await request<DataCard>(`${PREFIX}/cards/update`, input)
}

export async function removeCard(id: string): Promise<void> {
  await request<unknown>(`${PREFIX}/cards/remove`, { id })
}

export async function createReport(input: { workspaceId: string; threadId?: string; title: string; markdown: string }): Promise<DataReport> {
  return await request<DataReport>(`${PREFIX}/reports/create`, input)
}

export async function updateReport(input: { id: string; title?: string; markdown?: string }): Promise<DataReport> {
  return await request<DataReport>(`${PREFIX}/reports/update`, input)
}

export async function removeReport(id: string): Promise<void> {
  await request<unknown>(`${PREFIX}/reports/remove`, { id })
}

export interface RefineChartResult {
  readonly kind: 'spec' | 'out_of_scope'
  readonly card?: DataCard
  readonly rationale?: string
}

export async function refineChart(input: { cardId: string; instruction: string }): Promise<RefineChartResult> {
  return await request<RefineChartResult>(`${PREFIX}/charts/refine`, input)
}

export interface AgentResult {
  readonly reply:
    | { readonly kind: 'chart'; readonly title: string }
    | { readonly kind: 'transform'; readonly title: string; readonly datasetId: string }
    | { readonly kind: 'join'; readonly title: string; readonly datasetId: string }
    | { readonly kind: 'answer'; readonly answer: string }
  readonly cards: readonly DataCard[]
}

export async function askAgent(input: { threadId: string; prompt: string; datasetId?: string }): Promise<AgentResult> {
  return await request<AgentResult>(`${PREFIX}/agent`, input)
}

export interface AgentPlanEvent {
  readonly type: 'step' | 'done' | 'error'
  readonly planId: string
  readonly step?: string
  readonly status: 'running' | 'done' | 'error'
  readonly error?: string
}

/** Run the agent over SSE so plan steps appear while the model works. */
export async function askAgentStream(
  input: { threadId: string; prompt: string; datasetId?: string },
  onEvent: (event: AgentPlanEvent) => void,
): Promise<AgentResult> {
  const response = await fetch(`${PREFIX}/agent/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined)
    const code = typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : String(response.status)
    throw new DataApiError(code, response.status)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new DataApiError('agent-failed', 502)
  const decoder = new TextDecoder()
  let buffer = ''
  let result: AgentResult | undefined
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    for (;;) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary === -1) break
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const event = JSON.parse(line.slice(6)) as AgentPlanEvent | { type: 'result'; result: AgentResult } | { type: 'error'; error: string }
        if (event.type === 'result') result = event.result
        else if (event.type === 'error') throw new DataApiError(typeof (event as { error?: unknown }).error === 'string' ? (event as { error: string }).error : 'agent-failed', 502)
        else onEvent(event)
      }
    }
  }
  if (result === undefined) throw new DataApiError('agent-failed', 502)
  return result
}

const ERROR_KEYS: Readonly<Record<string, DataStudioLocaleKey>> = {
  'no-such-workspace': 'data.error.noWorkspace',
  'workspace-in-use': 'data.error.workspaceInUse',
  'no-such-dataset': 'data.error.noDataset',
  'invalid-dataset': 'data.error.invalidDataset',
  'dataset-in-use': 'data.error.datasetInUse',
  'no-such-thread': 'data.error.noThread',
  'no-such-card': 'data.error.noCard',
  'invalid-chart': 'data.error.invalidChart',
  'invalid-card': 'data.error.invalidCard',
  'no-such-report': 'data.error.noReport',
  'no-such-relation': 'data.error.noRelation',
  'invalid-relation': 'data.error.invalidRelation',
  'invalid-connector': 'data.error.invalidConnector',
  'agent-unavailable': 'data.error.agentUnavailable',
  'agent-failed': 'data.error.agentFailed',
  'fetch-failed': 'data.error.fetchFailed',
  'workspace-unavailable': 'data.error.workspaceUnavailable',
  'invalid-workspace-path': 'data.error.invalidWorkspacePath',
  'not-refreshable': 'data.error.notRefreshable',
  'invalid-refresh-interval': 'data.error.invalidRefreshInterval',
  'invalid-database': 'data.error.invalidDatabase',
  'database-failed': 'data.error.databaseFailed',
  'invalid-object-store': 'data.error.invalidObjectStore',
  'object-store-failed': 'data.error.objectStoreFailed',
  'connections-unavailable': 'data.error.connectionsUnavailable',
  'no-such-connection': 'data.error.noConnection',
  'invalid-connection': 'data.error.invalidConnection',
}

export function errorText(t: Translate, error: unknown): string {
  const code = error instanceof DataApiError
    ? error.code
    : error instanceof Error ? error.message : String(error)
  const key = ERROR_KEYS[code]
  return key === undefined ? code : t(key)
}
