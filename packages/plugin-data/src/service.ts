/**
 * TentacleData — the Data Studio host service (design 11).
 *
 * Responsibilities: persist workspaces/datasets/threads/cards under
 * `$DSH_HOME/tentacle/data`, parse imported CSV/JSON once, serve the admin
 * REST surface the browser panel renders, and keep referential integrity
 * (cards point at live datasets; workspaces cannot vanish under content).
 */
import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { GatewayRoute } from '@tentacle/gateway'
import { buildAgentPrompt, parseAgentReply, replyToSpec } from './agent.js'
import { buildRefinePrompt, parseRefineReply } from './refine.js'
import { createDataRoutes } from './admin-api.js'
import { applyJoin, JOIN_KINDS } from './join.js'
import { suggestRelations, type RelationSuggestion } from './relations.js'
import { applyOperation, describeOperation, validateOperation } from './operations.js'
import { DatasetParseError, parseDataset } from './parser.js'
import { DuckDbConnectorError, DuckDbConnectors } from './connectors/duckdb.js'
import { createObjectStoreDriver, ObjectStoreError, normalizeObjectStoreConfig, type ObjectStoreConfig, type ObjectStoreDriver } from './connectors/objectstore.js'
import { createDatabaseDriver, DatabaseConnectorError, normalizeDatabaseConfig, normalizeReadOnlyQuery, type DatabaseConfig, type DatabaseDriver, type DatabaseTable } from './connectors/database.js'
import { listWorkspaceDirectory, readWorkspaceFile, WorkspaceFileError } from './connectors/workspace.js'
import { SqliteConnectors, SqliteConnectorError } from './connectors/sqlite.js'
import { DataRepo } from './repo.js'
import {
  emptyState,
  type ChartAnnotations,
  type ChartRange,
  type ChartSort,
  type ChartFilter,
  type ChartSpec,
  CHART_THEMES,
  type DataCard,
  type DataConnectionProfile,
  type DataOperation,
  type DataRelation,
  type DataReport,
  type DatasetCard,
  type DataState,
  type DataThread,
  type DataWorkspace,
  type DatasetMeta,
  type DatasetRows,
  type PlanCard,
  type PlanStatus,
  type DatasetSource,
  type JoinKind,
  type JoinSpec,
  type UrlDatasetSource,
  type WorkspaceDatasetSource,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tentacleData: TentacleData
  }
}

interface GatewayLike {
  registerRoute(route: GatewayRoute): () => void
}

export class DataError extends Error {
  constructor(
    readonly code:
      | 'invalid-workspace'
      | 'no-such-workspace'
      | 'workspace-in-use'
      | 'no-such-dataset'
      | 'invalid-dataset'
      | 'dataset-in-use'
      | 'no-such-thread'
      | 'no-such-card'
      | 'no-such-report'
      | 'invalid-card'
      | 'invalid-chart'
      | 'agent-unavailable'
      | 'agent-failed'
      | 'no-such-relation'
      | 'invalid-relation'
      | 'relation-in-use'
      | 'invalid-connector'
      | 'fetch-failed'
      | 'workspace-unavailable'
      | 'invalid-workspace-path'
      | 'not-refreshable'
      | 'invalid-refresh-interval'
      | 'invalid-database'
      | 'database-failed'
      | 'invalid-object-store'
      | 'object-store-failed'
      | 'connections-unavailable'
      | 'no-such-connection'
      | 'invalid-connection',
    message: string,
  ) {
    super(message)
    this.name = 'DataError'
  }
}

export interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

export interface ConnectionInput {
  readonly kind: 'database' | 'objectstore'
  readonly name: string
  readonly config: Record<string, unknown>
  readonly secret: string
}

export interface RegistryWorkspace {
  readonly id: string
  readonly title: string
  readonly path: string
}

export interface WorkspaceRegistryLike {
  list(): readonly RegistryWorkspace[]
}

export interface AgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface AgentStreamOptions {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly system: string
  readonly messages: readonly { readonly role: 'user'; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }[]
}

/** Structural face of `ctx.llm` + `ctx.agentDefaultModel` used by the agent. */
export interface AgentRuntime {
  selection(): AgentModelSelection | undefined
  stream(options: AgentStreamOptions): AsyncIterable<{ readonly type: string; readonly text?: string }>
}

export interface TentacleDataConfig {
  /** State root. Default `$DSH_HOME/tentacle/data`. */
  stateRoot?: string
  /** Test seam: inject the model runtime instead of resolving `ctx.llm`. */
  agentRuntime?: AgentRuntime
  /** Test seam: inject the workspace registry instead of resolving `ctx.workspaceRegistry`. */
  workspaceRegistry?: WorkspaceRegistryLike
  /** Test seam: inject a database driver instead of the lazy pg/mysql drivers. */
  databaseDriver?: DatabaseDriver
  /** Test seam: inject an object-store driver instead of the S3/Azure SDKs. */
  objectStoreDriver?: ObjectStoreDriver
  /** Test seam: inject the credential provider instead of resolving `ctx.credentials`. */
  credentials?: CredentialsLike
}

export interface ImportUrlInput {
  readonly workspaceId: string
  readonly name: string
  readonly url: string
  readonly format?: 'csv' | 'json'
}

export interface ImportDatasetInput {
  readonly workspaceId: string
  readonly name: string
  readonly format: 'csv' | 'json'
  readonly content: string
}

export interface DeriveDatasetInput {
  readonly datasetId: string
  readonly name: string
  readonly operation: DataOperation
}

export interface CreateThreadInput {
  readonly workspaceId: string
  readonly name: string
  readonly datasetId?: string
  readonly copyFromThreadId?: string
}

export interface CardInput {
  readonly threadId: string
  readonly kind: 'dataset' | 'chart' | 'note'
  readonly title: string
  readonly datasetId?: string
  readonly spec?: ChartSpec
  readonly text?: string
  readonly parentCardId?: string
}

export interface CardPatch {
  readonly id: string
  readonly title?: string
  readonly spec?: ChartSpec
  readonly text?: string
}

export interface CreateRelationInput {
  readonly workspaceId: string
  readonly leftDatasetId: string
  readonly leftColumn: string
  readonly rightDatasetId: string
  readonly rightColumn: string
}

export interface JoinDatasetsInput {
  readonly leftDatasetId: string
  readonly rightDatasetId: string
  readonly leftColumn: string
  readonly rightColumn: string
  readonly how: JoinKind
  readonly name: string
}

export interface CreateReportInput {
  readonly workspaceId: string
  readonly threadId?: string
  readonly title: string
  readonly markdown: string
}

export interface UpdateReportInput {
  readonly id: string
  readonly title?: string
  readonly markdown?: string
}

export interface AskAgentInput {
  readonly threadId: string
  readonly prompt: string
  readonly datasetId?: string
}

export interface RefineChartResult {
  readonly kind: 'spec' | 'out_of_scope'
  readonly card?: DataCard
  readonly rationale?: string
}

export interface AgentPlanEvent {
  readonly type: 'step' | 'done' | 'error'
  readonly planId: string
  readonly step?: string
  readonly status: PlanStatus
  readonly error?: string
}

export type AgentPlanListener = (event: AgentPlanEvent) => void

export interface AskAgentResult {
  readonly reply:
    | { readonly kind: 'chart'; readonly title: string }
    | { readonly kind: 'transform'; readonly title: string; readonly datasetId: string }
    | { readonly kind: 'join'; readonly title: string; readonly datasetId: string }
    | { readonly kind: 'answer'; readonly answer: string }
  readonly cards: readonly DataCard[]
}

const MAX_IMPORT_ROWS = 20_000
const MAX_STATE_ROWS = 2_000
/** Hard bound on model calls for one question (transform steps + final chart). */
const MAX_AGENT_STEPS = 3
const MAX_URL_BYTES = 10 * 1024 * 1024
const AUTO_REFRESH_TICK_MS = 15_000
const AUTO_REFRESH_SECONDS: readonly number[] = [0, 60, 300, 900, 3600]

function inferRemoteFormat(url: URL, contentType: string | null): 'csv' | 'json' {
  const type = contentType?.toLowerCase() ?? ''
  if (type.includes('json')) return 'json'
  if (type.includes('csv')) return 'csv'
  const path = url.pathname.toLowerCase()
  if (path.endsWith('.json')) return 'json'
  if (path.endsWith('.csv')) return 'csv'
  return 'csv'
}

function cleanName(raw: unknown, field: string): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') throw new DataError('invalid-workspace', `${field} must not be empty`)
  return value.slice(0, 120)
}

function now(): number { return Date.now() }

function assertSpec(spec: ChartSpec | undefined, rows: DatasetRows): ChartSpec {
  if (spec === undefined) throw new DataError('invalid-chart', 'chart spec is required')
  const chart = spec.chart
  const supported = chart === 'bar' || chart === 'line' || chart === 'area' || chart === 'scatter' || chart === 'pie' || chart === 'donut' || chart === 'horizontalBar' || chart === 'heatmap' || chart === 'boxplot' || chart === 'bump' || chart === 'streamgraph' || chart === 'waterfall' || chart === 'rose' || chart === 'radar' || chart === 'groupedBar' || chart === 'stackedBar' || chart === 'candlestick' || chart === 'gantt' || chart === 'histogram' || chart === 'density' || chart === 'violin' || chart === 'kpi' || chart === 'rangeArea' || chart === 'bullet' || chart === 'barTable' || chart === 'table' || chart === 'rangeDot' || chart === 'map' || chart === 'choropleth' || chart === 'marginal' || chart === 'regression' || chart === 'connectedScatter' || chart === 'strip' || chart === 'lollipop' || chart === 'pyramid' || chart === 'slope' || chart === 'sparkline' || chart === 'ridgeline' || chart === 'ecdf' || chart === 'calendarHeatmap'
  if (!supported) throw new DataError('invalid-chart', `unsupported chart kind: ${String(chart)}`)
  const aggregate = spec.aggregate
  if (aggregate !== 'sum' && aggregate !== 'avg' && aggregate !== 'count' && aggregate !== 'none') {
    throw new DataError('invalid-chart', `unsupported aggregate: ${String(aggregate)}`)
  }
  const columns = new Map(rows.columns.map((column) => [column.name, column]))
  if (typeof spec.x !== 'string' || !columns.has(spec.x)) {
    throw new DataError('invalid-chart', `unknown x column: ${String(spec.x)}`)
  }
  if (spec.y !== undefined && (typeof spec.y !== 'string' || !columns.has(spec.y))) {
    throw new DataError('invalid-chart', `unknown y column: ${String(spec.y)}`)
  }
  if (chart === 'marginal' || chart === 'regression' || chart === 'connectedScatter') {
    if (columns.get(spec.x)?.type !== 'number' || spec.y === undefined || columns.get(spec.y)?.type !== 'number') {
      throw new DataError('invalid-chart', `${chart} needs numeric x and y columns`)
    }
  } else if (chart === 'ecdf') {
    if (columns.get(spec.x)?.type !== 'number') throw new DataError('invalid-chart', 'ecdf needs a numeric x column')
  } else if (chart === 'calendarHeatmap') {
    if (spec.y === undefined || columns.get(spec.y)?.type !== 'number') throw new DataError('invalid-chart', 'calendarHeatmap needs a numeric measure y column')
  } else if (chart === 'map') {
    if (columns.get(spec.x)?.type !== 'number') throw new DataError('invalid-chart', 'map needs a numeric longitude x column')
    if (spec.y === undefined || columns.get(spec.y)?.type !== 'number') throw new DataError('invalid-chart', 'map needs a numeric latitude y column')
  } else if (chart === 'choropleth') {
    if (spec.y === undefined || columns.get(spec.y)?.type !== 'number') throw new DataError('invalid-chart', 'choropleth needs a numeric measure y column')
  } else if (chart === 'table') {
    // Tables render every column; no measure/axis requirement.
  } else if (chart === 'rangeArea') {
    if (spec.y === undefined || columns.get(spec.y)?.type !== 'number') throw new DataError('invalid-chart', 'rangeArea needs a numeric y column')
    if (spec.y2 === undefined || columns.get(spec.y2)?.type !== 'number') throw new DataError('invalid-chart', 'rangeArea needs a numeric y2 column')
  } else if (chart === 'histogram' || chart === 'density') {
    if (columns.get(spec.x)?.type !== 'number') throw new DataError('invalid-chart', `${chart} needs a numeric x column`)
  } else if (chart === 'gantt') {
    if (spec.x2 === undefined || !columns.has(spec.x2)) throw new DataError('invalid-chart', 'gantt needs an end column')
    if (spec.y === undefined || !columns.has(spec.y)) throw new DataError('invalid-chart', 'gantt needs a task column')
  } else if (chart === 'candlestick') {
    for (const key of ['open', 'high', 'low', 'close'] as const) {
      const field = spec[key]
      if (field === undefined || columns.get(field)?.type !== 'number') {
        throw new DataError('invalid-chart', `candlestick needs a numeric ${key} column`)
      }
    }
  } else if (chart === 'boxplot' || chart === 'bump' || chart === 'streamgraph' || chart === 'waterfall' || chart === 'rose' || chart === 'radar' || chart === 'groupedBar' || chart === 'stackedBar' || chart === 'violin' || chart === 'kpi' || chart === 'bullet' || chart === 'barTable' || chart === 'rangeDot' || chart === 'strip' || chart === 'lollipop' || chart === 'pyramid' || chart === 'slope' || chart === 'sparkline' || chart === 'ridgeline') {
    if (spec.y === undefined || columns.get(spec.y)?.type !== 'number') throw new DataError('invalid-chart', `${chart} needs a numeric y column`)
  } else if (chart === 'heatmap') {
    if (spec.y === undefined) throw new DataError('invalid-chart', 'heatmap needs two dimension columns (x and y)')
    if (spec.value !== undefined && (typeof spec.value !== 'string' || !columns.has(spec.value))) {
      throw new DataError('invalid-chart', `unknown heatmap value: ${String(spec.value)}`)
    }
    if ((aggregate === 'sum' || aggregate === 'avg') && (spec.value === undefined || columns.get(spec.value)?.type !== 'number')) {
      throw new DataError('invalid-chart', 'heatmap sum/avg needs a numeric value column')
    }
  } else {
    if (aggregate !== 'count' && spec.y === undefined) {
      throw new DataError('invalid-chart', 'y column is required unless aggregating by count')
    }
    if ((aggregate === 'sum' || aggregate === 'avg') && (spec.y === undefined || columns.get(spec.y)?.type !== 'number')) {
      throw new DataError('invalid-chart', 'sum/avg need a numeric y column')
    }
    if (chart === 'scatter' && (spec.y === undefined || columns.get(spec.x)?.type !== 'number' || columns.get(spec.y)?.type !== 'number')) {
      throw new DataError('invalid-chart', 'scatter needs numeric x and y columns')
    }
  }
  if (spec.goal !== undefined && (typeof spec.goal !== 'string' || !columns.has(spec.goal) || columns.get(spec.goal)?.type !== 'number')) {
    throw new DataError('invalid-chart', 'goal needs a numeric column')
  }
  if (chart === 'bullet' && spec.goal === undefined) throw new DataError('invalid-chart', 'bullet needs a numeric goal column')
  if (spec.color !== undefined && (typeof spec.color !== 'string' || !columns.has(spec.color))) {
    throw new DataError('invalid-chart', `unknown color column: ${String(spec.color)}`)
  }
  if (spec.size !== undefined) {
    if (typeof spec.size !== 'string' || !columns.has(spec.size) || columns.get(spec.size)?.type !== 'number') {
      throw new DataError('invalid-chart', 'size needs a numeric column')
    }
  }
  if (spec.facet !== undefined && (typeof spec.facet !== 'string' || !columns.has(spec.facet))) {
    throw new DataError('invalid-chart', `unknown facet column: ${String(spec.facet)}`)
  }
  if (spec.sort !== undefined && spec.sort !== 'none' && spec.sort !== 'asc' && spec.sort !== 'desc') {
    throw new DataError('invalid-chart', `unsupported sort: ${String(spec.sort)}`)
  }
  const annotations: ChartAnnotations = {
    ...(spec.annotations?.max === true ? { max: true } : {}),
    ...(spec.annotations?.mean === true ? { mean: true } : {}),
    ...(spec.annotations?.labels === true ? { labels: true } : {}),
  }
  const theme = spec.theme === undefined ? undefined : CHART_THEMES.includes(spec.theme) ? spec.theme : undefined
  if (spec.theme !== undefined && theme === undefined) throw new DataError('invalid-chart', `unknown theme: ${String(spec.theme)}`)
  if (spec.range !== undefined) {
    if (typeof spec.range.column !== 'string' || !columns.has(spec.range.column) || columns.get(spec.range.column)?.type !== 'number') {
      throw new DataError('invalid-chart', 'range needs a numeric column')
    }
    for (const bound of [spec.range.min, spec.range.max]) {
      if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) {
        throw new DataError('invalid-chart', 'range bounds must be finite numbers')
      }
    }
    if (spec.range.min !== undefined && spec.range.max !== undefined && spec.range.min > spec.range.max) {
      throw new DataError('invalid-chart', 'range min must not exceed max')
    }
  }
  let chartProperties: Record<string, unknown> | undefined
  if (spec.chartProperties !== undefined) {
    if (typeof spec.chartProperties !== 'object' || spec.chartProperties === null || Array.isArray(spec.chartProperties)) {
      throw new DataError('invalid-chart', 'chartProperties must be an object')
    }
    chartProperties = {}
    for (const [key, value] of Object.entries(spec.chartProperties)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) chartProperties[key] = value
    }
    if (Object.keys(chartProperties).length === 0) chartProperties = undefined
  }
  const filters = spec.filters?.map((filter) => {
    if (!columns.has(filter.column)) throw new DataError('invalid-chart', `unknown filter column: ${filter.column}`)
    if (!Array.isArray(filter.values) || filter.values.length === 0) throw new DataError('invalid-chart', 'filter values must not be empty')
    return { column: filter.column, values: [...new Set(filter.values.map(String))].slice(0, 50) }
  })
  return {
    chart,
    x: spec.x,
    ...(spec.y === undefined ? {} : { y: spec.y }),
    aggregate,
    ...(spec.color === undefined ? {} : { color: spec.color }),
    ...(spec.size === undefined ? {} : { size: spec.size }),
    ...(spec.value === undefined ? {} : { value: spec.value }),
    ...(spec.open === undefined ? {} : { open: spec.open }),
    ...(spec.high === undefined ? {} : { high: spec.high }),
    ...(spec.low === undefined ? {} : { low: spec.low }),
    ...(spec.close === undefined ? {} : { close: spec.close }),
    ...(spec.x2 === undefined ? {} : { x2: spec.x2 }),
    ...(spec.goal === undefined ? {} : { goal: spec.goal }),
    ...(spec.y2 === undefined ? {} : { y2: spec.y2 }),
    ...(spec.facet === undefined ? {} : { facet: spec.facet }),
    ...(spec.sort === undefined ? {} : { sort: spec.sort }),
    ...(spec.title === undefined ? {} : { title: spec.title.slice(0, 160) }),
    ...(theme === undefined ? {} : { theme }),
    ...(filters === undefined || filters.length === 0 ? {} : { filters }),
    ...(spec.range === undefined ? {} : { range: spec.range }),
    ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
    ...(chartProperties === undefined ? {} : { chartProperties }),
  }
}

export class TentacleData extends Service {
  readonly ready: Promise<void>
  private markReady!: () => void
  private readonly repo: DataRepo
  private readonly root: string
  private readonly sqlite: SqliteConnectors
  private readonly duckdb: DuckDbConnectors
  private workspaceRegistry: WorkspaceRegistryLike | undefined
  private readonly databaseDriver: DatabaseDriver | undefined
  private readonly objectStoreDriver: ObjectStoreDriver | undefined
  private credentials: CredentialsLike | undefined
  private refreshTimer: ReturnType<typeof setInterval> | undefined
  private readonly refreshing = new Set<string>()
  private state: DataState = emptyState()
  private agentRuntime: AgentRuntime | undefined

  constructor(ctx: Context, config: TentacleDataConfig = {}) {
    super(ctx, 'tentacleData')
    this.root = config.stateRoot ?? dshHomePath('tentacle', 'data')
    this.repo = new DataRepo(this.root)
    this.sqlite = new SqliteConnectors(this.root)
    this.duckdb = new DuckDbConnectors(this.root)
    this.agentRuntime = config.agentRuntime
    this.workspaceRegistry = config.workspaceRegistry
    this.databaseDriver = config.databaseDriver
    this.objectStoreDriver = config.objectStoreDriver
    this.credentials = config.credentials
    this.ready = new Promise((resolve) => { this.markReady = resolve })
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => () => { this.sqlite.dispose() }, 'tentacle-data: sqlite connector cleanup')
    this.ctx.effect(() => () => { this.duckdb.dispose() }, 'tentacle-data: duckdb connector cleanup')
    this.refreshTimer = setInterval(() => { void this.runDueRefreshes() }, AUTO_REFRESH_TICK_MS)
    this.refreshTimer.unref?.()
    this.ctx.effect(() => () => { if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer) }, 'tentacle-data: auto refresh timer')
    this.state = await this.repo.loadState()
    if (this.state.workspaces.length === 0) {
      const workspace: DataWorkspace = {
        id: `ws-${randomUUID()}`,
        name: '默认数据空间',
        createdAt: now(),
        updatedAt: now(),
      }
      this.state = { ...this.state, workspaces: [workspace] }
      await this.save()
    }
    if (this.workspaceRegistry === undefined) {
      this.ctx.inject(['workspaceRegistry'], (injected) => {
        const registry = (injected as unknown as { workspaceRegistry?: WorkspaceRegistryLike }).workspaceRegistry
        if (registry === undefined) return
        this.workspaceRegistry = registry
        return () => { this.workspaceRegistry = undefined }
      })
    }

    if (this.credentials === undefined) {
      this.ctx.inject(['credentials'], (injected) => {
        const credentials = (injected as unknown as { credentials?: CredentialsLike }).credentials
        if (credentials === undefined) return
        this.credentials = credentials
        return () => { this.credentials = undefined }
      })
    }

    if (this.agentRuntime === undefined) {
      this.ctx.inject(['llm', 'agentDefaultModel'], (injected) => {
        const llm = (injected as unknown as {
          llm?: { stream(options: AgentStreamOptions): AsyncIterable<{ type: string; text?: string }> }
        }).llm
        const model = (injected as unknown as {
          agentDefaultModel?: { currentSelection(): AgentModelSelection }
        }).agentDefaultModel
        if (llm === undefined || model === undefined) return
        this.agentRuntime = {
          selection: () => {
            const selection = model.currentSelection()
            return selection.provider === '' || selection.model === ''
              ? undefined
              : selection
          },
          stream: (options) => llm.stream(options),
        }
        return () => { this.agentRuntime = undefined }
      })
    }

    this.ctx.inject(['tentacleGateway'], (gwCtx) => {
      const gateway = (gwCtx as unknown as { tentacleGateway: GatewayLike }).tentacleGateway
      const dispose = createDataRoutes(this).map((route) => gateway.registerRoute(route))
      this.ctx.logger?.info?.('tentacle data: admin routes registered on the gateway')
      return () => { for (const d of dispose) d() }
    })
    this.markReady()
  }

  private async save(): Promise<void> {
    await this.repo.saveState(this.state)
  }

  private findWorkspace(id: string): DataWorkspace {
    const workspace = this.state.workspaces.find((row) => row.id === id)
    if (workspace === undefined) throw new DataError('no-such-workspace', `no such workspace: ${id}`)
    return workspace
  }

  private findThread(id: string): DataThread {
    const thread = this.state.threads.find((row) => row.id === id)
    if (thread === undefined) throw new DataError('no-such-thread', `no such thread: ${id}`)
    return thread
  }

  private findDataset(id: string): DatasetMeta {
    const dataset = this.state.datasets.find((row) => row.id === id)
    if (dataset === undefined) throw new DataError('no-such-dataset', `no such dataset: ${id}`)
    return dataset
  }

  private findCard(id: string): DataCard {
    const card = this.state.cards.find((row) => row.id === id)
    if (card === undefined) throw new DataError('no-such-card', `no such card: ${id}`)
    return card
  }

  /** Full state for the panel (metadata only; rows are read on demand). */
  stateSnapshot(): DataState {
    return {
      ...this.state,
      threads: [...this.state.threads].sort((a, b) => a.createdAt - b.createdAt),
      cards: [...this.state.cards].sort((a, b) => a.createdAt - b.createdAt),
    }
  }

  async createWorkspace(name: string): Promise<DataWorkspace> {
    const workspace: DataWorkspace = {
      id: `ws-${randomUUID()}`,
      name: cleanName(name, 'workspace name'),
      createdAt: now(),
      updatedAt: now(),
    }
    this.state = { ...this.state, workspaces: [...this.state.workspaces, workspace] }
    await this.save()
    return workspace
  }

  async renameWorkspace(id: string, name: string): Promise<DataWorkspace> {
    this.findWorkspace(id)
    const next = this.state.workspaces.map((row) => row.id === id ? { ...row, name: cleanName(name, 'workspace name'), updatedAt: now() } : row)
    this.state = { ...this.state, workspaces: next }
    await this.save()
    return next.find((row) => row.id === id)!
  }

  async removeWorkspace(id: string): Promise<void> {
    this.findWorkspace(id)
    if (this.state.threads.some((thread) => thread.workspaceId === id) || this.state.datasets.some((dataset) => dataset.workspaceId === id) || this.state.reports.some((report) => report.workspaceId === id) || this.state.relations.some((relation) => relation.workspaceId === id)) {
      throw new DataError('workspace-in-use', 'workspace still owns datasets or threads')
    }
    this.state = { ...this.state, workspaces: this.state.workspaces.filter((row) => row.id !== id) }
    await this.save()
  }

  listConnections(): readonly DataConnectionProfile[] {
    return this.state.connections
  }

  private requireCredentials(): CredentialsLike {
    if (this.credentials === undefined) throw new DataError('connections-unavailable', 'credential provider is not available')
    return this.credentials
  }

  async saveConnection(input: ConnectionInput): Promise<DataConnectionProfile> {
    const credentials = this.requireCredentials()
    const name = cleanName(input.name, 'connection name')
    if (input.secret.trim() === '') throw new DataError('invalid-connection', 'secret must not be empty')
    const id = `conn-${randomUUID()}`
    const credentialRef = `TENTACLE_DATA_CONN_${id.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`
    let config: Record<string, unknown>
    if (input.kind === 'database') {
      const full = normalizeDatabaseConfig({ ...(input.config as unknown as DatabaseConfig), password: input.secret })
      config = { ...full, password: '' }
      delete (config as { password?: string }).password
      await credentials.set(credentialRef, input.secret)
    } else {
      const merged = { ...(input.config as unknown as ObjectStoreConfig) } as ObjectStoreConfig
      if (merged.provider === 's3') (merged as { secretAccessKey: string }).secretAccessKey = input.secret
      else (merged as { connectionString: string }).connectionString = input.secret
      const full = normalizeObjectStoreConfig(merged)
      config = full.provider === 's3'
        ? { ...full, secretAccessKey: '' }
        : { ...full, connectionString: '' }
      if (config['provider'] === 's3') delete config['secretAccessKey']
      else delete config['connectionString']
      await credentials.set(credentialRef, input.secret)
    }
    const profile: DataConnectionProfile = {
      id, kind: input.kind, name, config, credentialRef, createdAt: now(),
    }
    this.state = { ...this.state, connections: [...this.state.connections, profile] }
    await this.save()
    return profile
  }

  async removeConnection(id: string): Promise<void> {
    const profile = this.state.connections.find((candidate) => candidate.id === id)
    if (profile === undefined) throw new DataError('no-such-connection', `no such connection: ${id}`)
    if (this.credentials !== undefined) await this.credentials.unset(profile.credentialRef).catch(() => undefined)
    this.state = { ...this.state, connections: this.state.connections.filter((candidate) => candidate.id !== id) }
    await this.save()
  }

  private async connectionSecret(profile: DataConnectionProfile): Promise<string> {
    const resolved = await this.requireCredentials().resolve(profile.credentialRef)
    if (resolved === undefined) throw new DataError('invalid-connection', 'stored secret is missing')
    return resolved.value
  }

  private async databaseConfig(input: { config?: DatabaseConfig; connectionId?: string }): Promise<DatabaseConfig> {
    if (input.connectionId === undefined) {
      if (input.config === undefined) throw new DataError('invalid-database', 'database config is required')
      return normalizeDatabaseConfig(input.config)
    }
    const profile = this.state.connections.find((candidate) => candidate.id === input.connectionId && candidate.kind === 'database')
    if (profile === undefined) throw new DataError('no-such-connection', `no such database connection: ${input.connectionId}`)
    const secret = await this.connectionSecret(profile)
    return normalizeDatabaseConfig({ ...(profile.config as unknown as DatabaseConfig), password: secret })
  }

  private async objectStoreConfig(input: { config?: ObjectStoreConfig; connectionId?: string }): Promise<ObjectStoreConfig> {
    if (input.connectionId === undefined) {
      if (input.config === undefined) throw new DataError('invalid-object-store', 'object-store config is required')
      return normalizeObjectStoreConfig(input.config)
    }
    const profile = this.state.connections.find((candidate) => candidate.id === input.connectionId && candidate.kind === 'objectstore')
    if (profile === undefined) throw new DataError('no-such-connection', `no such object-store connection: ${input.connectionId}`)
    const secret = await this.connectionSecret(profile)
    const base = profile.config as unknown as ObjectStoreConfig
    const merged = base.provider === 's3'
      ? { ...base, secretAccessKey: secret }
      : { ...base, connectionString: secret }
    return normalizeObjectStoreConfig(merged as ObjectStoreConfig)
  }

  /** Registered DSH workspaces exposed to the file connector. */
  workspaceSources(): readonly { id: string; title: string; path: string }[] {
    if (this.workspaceRegistry === undefined) throw new DataError('workspace-unavailable', 'workspace registry is not available')
    return this.workspaceRegistry.list().map((workspace) => ({ id: workspace.id, title: workspace.title, path: workspace.path }))
  }

  listWorkspaceFiles(workspaceId: string, path: string): ReturnType<typeof listWorkspaceDirectory> {
    const workspace = this.workspaceSources().find((candidate) => candidate.id === workspaceId)
    if (workspace === undefined) throw new DataError('no-such-workspace', `no such DSH workspace: ${workspaceId}`)
    try {
      return listWorkspaceDirectory(workspace.path, path)
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw new DataError('invalid-workspace-path', error.message)
      throw error
    }
  }

  async importWorkspaceFile(input: {
    dataWorkspaceId: string
    dshWorkspaceId: string
    path: string
    name: string
  }): Promise<DatasetMeta> {
    this.findWorkspace(input.dataWorkspaceId)
    const workspace = this.workspaceSources().find((candidate) => candidate.id === input.dshWorkspaceId)
    if (workspace === undefined) throw new DataError('no-such-workspace', `no such DSH workspace: ${input.dshWorkspaceId}`)
    let file
    try {
      file = readWorkspaceFile(workspace.path, input.path)
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw new DataError('invalid-workspace-path', error.message)
      throw error
    }
    const rows = this.parseContent(file.content, file.format)
    return await this.persistDataset({
      workspaceId: input.dataWorkspaceId,
      name: input.name.trim() === '' ? file.name : input.name,
      format: file.format,
      rows,
      source: {
        kind: 'workspace',
        dshWorkspaceId: input.dshWorkspaceId,
        path: file.relativePath,
        format: file.format,
      },
    })
  }

  private database(): DatabaseDriver | undefined { return this.databaseDriver }

  async listDatabaseTables(input: { config?: DatabaseConfig; connectionId?: string }): Promise<readonly DatabaseTable[]> {
    let config
    try {
      config = await this.databaseConfig(input)
    } catch (error) {
      if (error instanceof DatabaseConnectorError) throw new DataError('invalid-database', error.message)
      if (error instanceof DataError) throw error
      throw error
    }
    const driver = this.database() ?? createDatabaseDriver(config.engine)
    try {
      return await driver.listTables(config)
    } catch (error) {
      if (error instanceof DatabaseConnectorError) {
        throw new DataError(error.code === 'invalid-config' ? 'invalid-database' : 'database-failed', error.message)
      }
      throw new DataError('database-failed', error instanceof Error ? error.message : String(error))
    }
  }

  async importDatabaseQuery(input: {
    config?: DatabaseConfig
    connectionId?: string
    query: string
    workspaceId: string
    name: string
  }): Promise<DatasetMeta> {
    this.findWorkspace(input.workspaceId)
    let config
    let query
    try {
      config = await this.databaseConfig(input)
      query = normalizeReadOnlyQuery(input.query)
    } catch (error) {
      if (error instanceof DatabaseConnectorError) throw new DataError('invalid-database', error.message)
      if (error instanceof DataError) throw error
      throw error
    }
    const driver = this.database() ?? createDatabaseDriver(config.engine)
    let rows
    try {
      rows = await driver.readQuery(config, query)
    } catch (error) {
      if (error instanceof DatabaseConnectorError) {
        throw new DataError(error.code === 'invalid-config' ? 'invalid-database' : 'database-failed', error.message)
      }
      throw new DataError('database-failed', error instanceof Error ? error.message : String(error))
    }
    return await this.importRows({ workspaceId: input.workspaceId, name: input.name, rows })
  }

  async importDatabase(input: {
    config?: DatabaseConfig
    connectionId?: string
    table: DatabaseTable
    workspaceId: string
    name: string
  }): Promise<DatasetMeta> {
    this.findWorkspace(input.workspaceId)
    let config
    try {
      config = await this.databaseConfig(input)
    } catch (error) {
      if (error instanceof DatabaseConnectorError) throw new DataError('invalid-database', error.message)
      if (error instanceof DataError) throw error
      throw error
    }
    if (typeof input.table.name !== 'string' || input.table.name === '') throw new DataError('invalid-database', 'table name is required')
    const driver = this.database() ?? createDatabaseDriver(config.engine)
    let rows
    try {
      rows = await driver.readTable(config, input.table)
    } catch (error) {
      if (error instanceof DatabaseConnectorError) {
        throw new DataError(error.code === 'invalid-config' ? 'invalid-database' : 'database-failed', error.message)
      }
      throw new DataError('database-failed', error instanceof Error ? error.message : String(error))
    }
    return await this.importRows({ workspaceId: input.workspaceId, name: input.name, rows })
  }

  openSqlite(contentBase64: string): { id: string; tables: readonly string[] } {
    try {
      return this.sqlite.open(contentBase64)
    } catch (error) {
      if (error instanceof SqliteConnectorError) throw new DataError('invalid-connector', error.message)
      throw error
    }
  }

  async listObjectStore(input: { config?: ObjectStoreConfig; connectionId?: string }): Promise<unknown> {
    let normalized
    try {
      normalized = await this.objectStoreConfig(input)
    } catch (error) {
      if (error instanceof ObjectStoreError) throw new DataError('invalid-object-store', error.message)
      if (error instanceof DataError) throw error
      throw error
    }
    const driver = this.objectStoreDriver ?? createObjectStoreDriver(normalized.provider)
    try {
      return await driver.listObjects(normalized)
    } catch (error) {
      if (error instanceof ObjectStoreError) {
        throw new DataError(error.code === 'invalid-config' ? 'invalid-object-store' : 'object-store-failed', error.message)
      }
      throw new DataError('object-store-failed', error instanceof Error ? error.message : String(error))
    }
  }

  async importObject(input: {
    config?: ObjectStoreConfig
    connectionId?: string
    key: string
    workspaceId: string
    name: string
  }): Promise<DatasetMeta> {
    this.findWorkspace(input.workspaceId)
    let normalized
    try {
      normalized = await this.objectStoreConfig(input)
    } catch (error) {
      if (error instanceof ObjectStoreError) throw new DataError('invalid-object-store', error.message)
      if (error instanceof DataError) throw error
      throw error
    }
    const driver = this.objectStoreDriver ?? createObjectStoreDriver(normalized.provider)
    let object
    try {
      object = await driver.readObject(normalized, input.key)
    } catch (error) {
      if (error instanceof ObjectStoreError) {
        throw new DataError(error.code === 'invalid-config' ? 'invalid-object-store' : 'object-store-failed', error.message)
      }
      throw new DataError('object-store-failed', error instanceof Error ? error.message : String(error))
    }
    const name = input.name.trim() === '' ? input.key.split('/').pop() ?? 'object' : input.name
    const rows = this.parseContent(object.content, object.format)
    return await this.persistDataset({
      workspaceId: input.workspaceId,
      name: name.replace(/\.(csv|json)$/i, ''),
      format: object.format,
      rows,
    })
  }

  async openDuckDb(contentBase64: string): Promise<{ id: string; tables: readonly string[] }> {
    try {
      return await this.duckdb.open(contentBase64)
    } catch (error) {
      if (error instanceof DuckDbConnectorError) throw new DataError('invalid-connector', error.message)
      throw error
    }
  }

  async importDuckDb(input: { connectorId: string; table: string; workspaceId: string; name: string }): Promise<DatasetMeta> {
    this.findWorkspace(input.workspaceId)
    let rows
    try {
      rows = await this.duckdb.read(input.connectorId, input.table)
    } catch (error) {
      if (error instanceof DuckDbConnectorError) {
        throw new DataError(error.code === 'no-such-connector' ? 'invalid-connector' : 'invalid-dataset', error.message)
      }
      throw error
    }
    return await this.importRows({ workspaceId: input.workspaceId, name: input.name, rows })
  }

  closeDuckDb(id: string): void {
    this.duckdb.close(id)
  }

  async importSqlite(input: { connectorId: string; table: string; workspaceId: string; name: string }): Promise<DatasetMeta> {
    this.findWorkspace(input.workspaceId)
    let rows
    try {
      rows = this.sqlite.read(input.connectorId, input.table)
    } catch (error) {
      if (error instanceof SqliteConnectorError) {
        throw new DataError(error.code === 'no-such-connector' ? 'invalid-connector' : 'invalid-dataset', error.message)
      }
      throw error
    }
    return await this.importRows({ workspaceId: input.workspaceId, name: input.name, rows })
  }

  closeSqlite(id: string): void {
    this.sqlite.close(id)
  }

  async importDataset(input: ImportDatasetInput): Promise<DatasetMeta> {
    this.findWorkspace(input.workspaceId)
    const name = cleanName(input.name, 'dataset name')
    let parsed
    try {
      parsed = parseDataset(input.content, input.format)
    } catch (error) {
      if (error instanceof DatasetParseError) throw new DataError('invalid-dataset', error.message)
      throw error
    }
    if (parsed.rows.length === 0) throw new DataError('invalid-dataset', 'dataset has no rows')
    return await this.persistDataset({
      workspaceId: input.workspaceId,
      name,
      format: input.format,
      rows: parsed,
    })
  }

  /** Import already-normalized rows (connector output). */
  async importRows(input: { workspaceId: string; name: string; rows: DatasetRows }): Promise<DatasetMeta> {
    this.findWorkspace(input.workspaceId)
    if (input.rows.rows.length === 0) throw new DataError('invalid-dataset', 'dataset has no rows')
    return await this.persistDataset({
      workspaceId: input.workspaceId,
      name: input.name,
      format: 'json',
      rows: input.rows,
    })
  }

  private parseContent(content: string, format: 'csv' | 'json'): DatasetRows {
    let parsed
    try {
      parsed = parseDataset(content, format)
    } catch (error) {
      if (error instanceof DatasetParseError) throw new DataError('invalid-dataset', error.message)
      throw error
    }
    if (parsed.rows.length === 0) throw new DataError('invalid-dataset', 'dataset has no rows')
    return parsed
  }

  private async fetchRemote(url: URL, format?: 'csv' | 'json'): Promise<{ format: 'csv' | 'json'; content: string }> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new DataError('invalid-dataset', 'only http(s) URLs are supported')
    }
    let response: Response
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { accept: 'text/csv, application/json, text/plain;q=0.8, */*;q=0.5' },
      })
    } catch {
      throw new DataError('fetch-failed', 'could not fetch the URL')
    }
    if (!response.ok) throw new DataError('fetch-failed', `URL returned HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_URL_BYTES) throw new DataError('invalid-dataset', 'remote document is larger than 10 MB')
    const content = await response.text()
    if (Buffer.byteLength(content, 'utf8') > MAX_URL_BYTES) throw new DataError('invalid-dataset', 'remote document is larger than 10 MB')
    return { format: format ?? inferRemoteFormat(url, response.headers.get('content-type')), content }
  }

  private async readSource(source: DatasetSource): Promise<DatasetRows> {
    if (source.kind === 'url') {
      let parsedUrl: URL
      try {
        parsedUrl = new URL(source.url)
      } catch {
        throw new DataError('invalid-dataset', 'URL is not valid')
      }
      const remote = await this.fetchRemote(parsedUrl, source.format)
      return this.parseContent(remote.content, remote.format)
    }
    const workspace = this.workspaceSources().find((candidate) => candidate.id === source.dshWorkspaceId)
    if (workspace === undefined) throw new DataError('no-such-workspace', `no such DSH workspace: ${source.dshWorkspaceId}`)
    try {
      const file = readWorkspaceFile(workspace.path, source.path)
      return this.parseContent(file.content, file.format)
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw new DataError('invalid-workspace-path', error.message)
      throw error
    }
  }

  /** Import a remote CSV/JSON document with a hard size and time cap. */
  async importUrl(input: ImportUrlInput): Promise<DatasetMeta> {
    this.findWorkspace(input.workspaceId)
    let parsedUrl: URL
    try {
      parsedUrl = new URL(input.url)
    } catch {
      throw new DataError('invalid-dataset', 'URL is not valid')
    }
    const remote = await this.fetchRemote(parsedUrl, input.format)
    const rows = this.parseContent(remote.content, remote.format)
    return await this.persistDataset({
      workspaceId: input.workspaceId,
      name: input.name,
      format: remote.format,
      rows,
      source: { kind: 'url', url: parsedUrl.toString(), format: remote.format },
    })
  }

  /** Refresh a URL/workspace-backed dataset in place, preserving its identity. */
  async refreshDataset(id: string): Promise<DatasetMeta> {
    const dataset = this.findDataset(id)
    if (dataset.source === undefined) throw new DataError('not-refreshable', 'dataset has no refreshable source')
    if (this.refreshing.has(id)) return dataset
    this.refreshing.add(id)
    try {
      const rows = await this.readSource(dataset.source)
      if (rows.rows.length > MAX_IMPORT_ROWS) throw new DataError('invalid-dataset', `dataset exceeds ${MAX_IMPORT_ROWS} rows`)
      const timestamp = now()
      const next: DatasetMeta = {
        ...dataset,
        columns: rows.columns,
        rowCount: rows.rows.length,
        updatedAt: timestamp,
        refreshedAt: timestamp,
        lastRefreshAttemptAt: timestamp,
        lastRefreshError: undefined,
      }
      await this.repo.writeDataset(dataset.id, rows)
      this.state = { ...this.state, datasets: this.state.datasets.map((row) => row.id === id ? next : row) }
      await this.save()
      return next
    } catch (error) {
      const timestamp = now()
      const message = error instanceof Error ? error.message : String(error)
      const failed: DatasetMeta = {
        ...this.findDataset(id),
        lastRefreshAttemptAt: timestamp,
        lastRefreshError: message.slice(0, 500),
      }
      this.state = { ...this.state, datasets: this.state.datasets.map((row) => row.id === id ? failed : row) }
      await this.save()
      throw error
    } finally {
      this.refreshing.delete(id)
    }
  }

  /** Configure automatic refresh for a URL/workspace-backed dataset. */
  async setAutoRefresh(id: string, seconds: number): Promise<DatasetMeta> {
    const dataset = this.findDataset(id)
    if (!AUTO_REFRESH_SECONDS.includes(seconds)) throw new DataError('invalid-refresh-interval', `unsupported interval: ${String(seconds)}`)
    if (seconds > 0 && dataset.source === undefined) throw new DataError('not-refreshable', 'dataset has no refreshable source')
    const next: DatasetMeta = {
      ...dataset,
      ...(seconds === 0 ? { autoRefreshSec: undefined } : { autoRefreshSec: seconds }),
      lastRefreshError: undefined,
    }
    this.state = { ...this.state, datasets: this.state.datasets.map((row) => row.id === id ? next : row) }
    await this.save()
    return next
  }

  /** Run every due automatic refresh once. Exposed for deterministic tests. */
  async runDueRefreshes(at = Date.now()): Promise<void> {
    for (const dataset of [...this.state.datasets]) {
      const interval = dataset.autoRefreshSec ?? 0
      if (interval <= 0 || dataset.source === undefined) continue
      const last = dataset.lastRefreshAttemptAt ?? dataset.refreshedAt ?? dataset.createdAt
      if (at - last < interval * 1000) continue
      try {
        await this.refreshDataset(dataset.id)
      } catch {
        // refreshDataset records lastRefreshError and keeps the prior rows.
      }
    }
  }

  private async persistDataset(input: {
    workspaceId: string
    name: string
    format: 'csv' | 'json'
    rows: DatasetRows
    sourceDatasetId?: string
    operation?: DataOperation
    join?: JoinSpec
    source?: DatasetSource
  }): Promise<DatasetMeta> {
    if (input.rows.rows.length > MAX_IMPORT_ROWS) {
      throw new DataError('invalid-dataset', `dataset exceeds ${MAX_IMPORT_ROWS} rows`)
    }
    const id = `ds-${randomUUID()}`
    const timestamp = now()
    const meta: DatasetMeta = {
      id,
      workspaceId: input.workspaceId,
      name: cleanName(input.name, 'dataset name'),
      format: input.format,
      columns: input.rows.columns,
      rowCount: input.rows.rows.length,
      ...(input.sourceDatasetId === undefined ? {} : { sourceDatasetId: input.sourceDatasetId }),
      ...(input.operation === undefined ? {} : { operation: input.operation }),
      ...(input.join === undefined ? {} : { join: input.join }),
      ...(input.source === undefined ? {} : { source: input.source }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.repo.writeDataset(id, input.rows)
    this.state = { ...this.state, datasets: [...this.state.datasets, meta] }
    await this.save()
    return meta
  }

  /** Persist a derived dataset produced by one explicit operation. */
  async deriveDataset(input: DeriveDatasetInput): Promise<DatasetMeta> {
    const source = this.findDataset(input.datasetId)
    const problem = validateOperation(input.operation, source.columns)
    if (problem !== undefined) throw new DataError('invalid-dataset', problem.message)
    const sourceRows = await this.repo.readDataset(source.id)
    const result = applyOperation(sourceRows, input.operation)
    return await this.persistDataset({
      workspaceId: source.workspaceId,
      name: input.name,
      format: 'json',
      rows: result,
      sourceDatasetId: source.id,
      operation: input.operation,
    })
  }

  async removeDataset(id: string): Promise<void> {
    this.findDataset(id)
    if (this.state.cards.some((card) => (card.kind === 'dataset' || card.kind === 'chart') && card.datasetId === id)) {
      throw new DataError('dataset-in-use', 'dataset is still referenced by a card')
    }
    if (this.state.datasets.some((dataset) => dataset.sourceDatasetId === id)) {
      throw new DataError('dataset-in-use', 'dataset is still the source of a derived dataset')
    }
    if (this.state.datasets.some((dataset) => dataset.join?.leftDatasetId === id || dataset.join?.rightDatasetId === id)) {
      throw new DataError('dataset-in-use', 'dataset is still the source of a joined dataset')
    }
    if (this.state.relations.some((relation) => relation.leftDatasetId === id || relation.rightDatasetId === id)) {
      throw new DataError('dataset-in-use', 'dataset is still referenced by a relationship')
    }
    this.state = { ...this.state, datasets: this.state.datasets.filter((row) => row.id !== id) }
    await this.repo.removeDataset(id)
    await this.save()
  }

  async datasetRows(id: string, limit = MAX_STATE_ROWS): Promise<DatasetRows> {
    this.findDataset(id)
    const rows = await this.repo.readDataset(id)
    return { columns: rows.columns, rows: rows.rows.slice(0, Math.max(1, Math.min(limit, MAX_STATE_ROWS))) }
  }

  async createThread(input: CreateThreadInput): Promise<DataThread> {
    this.findWorkspace(input.workspaceId)
    const source = input.copyFromThreadId === undefined ? undefined : this.findThread(input.copyFromThreadId)
    if (source !== undefined && source.workspaceId !== input.workspaceId) {
      throw new DataError('invalid-workspace', 'cannot copy a thread from another workspace')
    }
    if (input.datasetId !== undefined) this.findDataset(input.datasetId)
    const thread: DataThread = {
      id: `th-${randomUUID()}`,
      workspaceId: input.workspaceId,
      name: cleanName(input.name, 'thread name'),
      ...(source === undefined ? {} : { parentThreadId: source.id }),
      createdAt: now(),
      updatedAt: now(),
    }
    const cards: DataCard[] = []
    if (source !== undefined) {
      for (const card of this.state.cards.filter((row) => row.threadId === source.id)) {
        cards.push({ ...card, id: `card-${randomUUID()}`, threadId: thread.id, createdAt: now() })
      }
    }
    if (input.datasetId !== undefined) {
      const dataset = this.findDataset(input.datasetId)
      cards.push({
        id: `card-${randomUUID()}`,
        threadId: thread.id,
        kind: 'dataset',
        title: dataset.name,
        datasetId: dataset.id,
        createdAt: now(),
      })
    }
    this.state = {
      ...this.state,
      threads: [...this.state.threads, thread],
      cards: [...this.state.cards, ...cards],
    }
    await this.save()
    return thread
  }

  /** Propose relationships from same-named, value-overlapping columns. */
  async suggestRelations(workspaceId: string): Promise<readonly RelationSuggestion[]> {
    this.findWorkspace(workspaceId)
    const datasets = this.state.datasets.filter((dataset) => dataset.workspaceId === workspaceId)
    const inputs = await Promise.all(datasets.map(async (dataset) => ({
      datasetId: dataset.id,
      datasetName: dataset.name,
      rows: await this.repo.readDataset(dataset.id),
    })))
    return suggestRelations(inputs, this.state.relations.filter((relation) => relation.workspaceId === workspaceId))
  }

  async createRelation(input: CreateRelationInput): Promise<DataRelation> {
    this.findWorkspace(input.workspaceId)
    const left = this.findDataset(input.leftDatasetId)
    const right = this.findDataset(input.rightDatasetId)
    if (left.workspaceId !== input.workspaceId || right.workspaceId !== input.workspaceId) {
      throw new DataError('invalid-relation', 'both datasets must belong to the same workspace')
    }
    if (left.id === right.id) throw new DataError('invalid-relation', 'a dataset cannot relate to itself')
    if (!left.columns.some((column) => column.name === input.leftColumn)) throw new DataError('invalid-relation', `unknown left column: ${input.leftColumn}`)
    if (!right.columns.some((column) => column.name === input.rightColumn)) throw new DataError('invalid-relation', `unknown right column: ${input.rightColumn}`)
    const duplicate = this.state.relations.some((relation) =>
      relation.leftDatasetId === left.id && relation.leftColumn === input.leftColumn
      && relation.rightDatasetId === right.id && relation.rightColumn === input.rightColumn)
    if (duplicate) throw new DataError('invalid-relation', 'this relationship already exists')
    const relation: DataRelation = {
      id: `rel-${randomUUID()}`,
      workspaceId: input.workspaceId,
      leftDatasetId: left.id,
      leftColumn: input.leftColumn,
      rightDatasetId: right.id,
      rightColumn: input.rightColumn,
      createdAt: now(),
    }
    this.state = { ...this.state, relations: [...this.state.relations, relation] }
    await this.save()
    return relation
  }

  async removeRelation(id: string): Promise<void> {
    if (!this.state.relations.some((relation) => relation.id === id)) {
      throw new DataError('no-such-relation', `no such relation: ${id}`)
    }
    this.state = { ...this.state, relations: this.state.relations.filter((relation) => relation.id !== id) }
    await this.save()
  }

  /** Join two datasets on one key pair; the result is a persisted dataset. */
  async joinDatasets(input: JoinDatasetsInput): Promise<DatasetMeta> {
    const left = this.findDataset(input.leftDatasetId)
    const right = this.findDataset(input.rightDatasetId)
    if (left.workspaceId !== right.workspaceId) throw new DataError('invalid-relation', 'datasets belong to different workspaces')
    if (left.id === right.id) throw new DataError('invalid-relation', 'a dataset cannot join to itself')
    if (!JOIN_KINDS.includes(input.how)) throw new DataError('invalid-relation', `unsupported join kind: ${String(input.how)}`)
    if (!left.columns.some((column) => column.name === input.leftColumn)) throw new DataError('invalid-relation', `unknown left column: ${input.leftColumn}`)
    if (!right.columns.some((column) => column.name === input.rightColumn)) throw new DataError('invalid-relation', `unknown right column: ${input.rightColumn}`)
    const spec: JoinSpec = {
      leftDatasetId: left.id,
      rightDatasetId: right.id,
      leftColumn: input.leftColumn,
      rightColumn: input.rightColumn,
      how: input.how,
    }
    const [leftRows, rightRows] = await Promise.all([this.repo.readDataset(left.id), this.repo.readDataset(right.id)])
    const result = applyJoin({ left: leftRows, right: rightRows, spec })
    return await this.persistDataset({
      workspaceId: left.workspaceId,
      name: input.name,
      format: 'json',
      rows: result,
      join: spec,
    })
  }

  async createReport(input: CreateReportInput): Promise<DataReport> {
    this.findWorkspace(input.workspaceId)
    if (input.threadId !== undefined) {
      const thread = this.findThread(input.threadId)
      if (thread.workspaceId !== input.workspaceId) throw new DataError('invalid-workspace', 'report thread belongs to another workspace')
    }
    const timestamp = now()
    const report: DataReport = {
      id: `rp-${randomUUID()}`,
      workspaceId: input.workspaceId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      title: cleanName(input.title, 'report title'),
      markdown: input.markdown.slice(0, 200_000),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.state = { ...this.state, reports: [...this.state.reports, report] }
    await this.save()
    return report
  }

  async updateReport(input: UpdateReportInput): Promise<DataReport> {
    const current = this.state.reports.find((row) => row.id === input.id)
    if (current === undefined) throw new DataError('no-such-report', `no such report: ${input.id}`)
    const next: DataReport = {
      ...current,
      ...(input.title === undefined ? {} : { title: cleanName(input.title, 'report title') }),
      ...(input.markdown === undefined ? {} : { markdown: input.markdown.slice(0, 200_000) }),
      updatedAt: now(),
    }
    this.state = { ...this.state, reports: this.state.reports.map((row) => row.id === input.id ? next : row) }
    await this.save()
    return next
  }

  async removeReport(id: string): Promise<void> {
    if (!this.state.reports.some((row) => row.id === id)) throw new DataError('no-such-report', `no such report: ${id}`)
    this.state = { ...this.state, reports: this.state.reports.filter((row) => row.id !== id) }
    await this.save()
  }

  /** Refine an existing chart's visual spec from one instruction. */
  async refineChart(input: { cardId: string; instruction: string }): Promise<RefineChartResult> {
    const card = this.findCard(input.cardId)
    if (card.kind !== 'chart') throw new DataError('invalid-card', 'only chart cards can be refined')
    const instruction = input.instruction.trim()
    if (instruction === '') throw new DataError('invalid-card', 'instruction must not be empty')
    const rows = await this.repo.readDataset(card.datasetId)
    const runtime = this.agentRuntime
    const model = runtime?.selection()
    if (runtime === undefined || model === undefined) {
      throw new DataError('agent-unavailable', 'no model provider or default model is configured')
    }
    const built = buildRefinePrompt(instruction, card.spec, { columns: rows.columns, rows: rows.rows.slice(0, 50) })
    let text = ''
    try {
      for await (const chunk of runtime.stream({
        provider: model.provider,
        model: model.model,
        ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
        system: built.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: built.user }] }],
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
    } catch {
      throw new DataError('agent-failed', 'the model call failed')
    }
    let parsed
    try {
      parsed = parseRefineReply(text, card.spec)
    } catch {
      throw new DataError('agent-failed', 'the model reply was not a valid chart patch')
    }
    if (parsed.kind === 'out_of_scope') {
      return { kind: 'out_of_scope', ...(parsed.rationale === undefined ? {} : { rationale: parsed.rationale }) }
    }
    const originalSpec = card.spec
    const updated = await this.updateCard({ id: card.id, spec: parsed.spec })
    if (updated.kind !== 'chart') throw new DataError('invalid-card', 'refined card is not a chart')
    const existing = updated.variants ?? [{
      id: `v-${randomUUID()}`,
      label: '原始',
      spec: originalSpec,
      createdAt: now(),
    }]
    const variants = [
      ...existing,
      {
        id: `v-${randomUUID()}`,
        label: instruction.slice(0, 28),
        spec: parsed.spec,
        ...(parsed.rationale === undefined ? {} : { rationale: parsed.rationale }),
        createdAt: now(),
      },
    ].slice(-8)
    const next: DataCard = { ...updated, variants }
    this.state = { ...this.state, cards: this.state.cards.map((row) => row.id === next.id ? next : row) }
    await this.save()
    return {
      kind: 'spec',
      card: next,
      ...(parsed.rationale === undefined ? {} : { rationale: parsed.rationale }),
    }
  }

  /**
   * Ask the data agent about a thread's active dataset.
   *
   * The loop is bounded (MAX_AGENT_STEPS): a transform reply persists a derived
   * dataset card and feeds its rows back to the model; a chart reply ends the
   * question. This is what lets one question become transform → chart without
   * moving planning logic into the client.
   */
  async askAgent(input: AskAgentInput, onEvent?: AgentPlanListener): Promise<AskAgentResult> {
    const thread = this.findThread(input.threadId)
    const question = input.prompt.trim()
    if (question === '') throw new DataError('invalid-card', 'question must not be empty')
    const initialCard = this.state.cards.find(
      (card): card is DatasetCard => card.threadId === thread.id && card.kind === 'dataset',
    )
    const datasetId = input.datasetId ?? initialCard?.datasetId
    if (datasetId === undefined) throw new DataError('no-such-dataset', 'thread has no dataset card')
    let dataset = this.findDataset(datasetId)
    let rows = await this.repo.readDataset(dataset.id)
    const runtime = this.agentRuntime
    const model = runtime?.selection()
    if (runtime === undefined || model === undefined) {
      throw new DataError('agent-unavailable', 'no model provider or default model is configured')
    }

    const cards: DataCard[] = []
    const priorSteps: string[] = []
    const planSteps: string[] = []
    const plan = await this.createPlanCard(thread.id, question, [])
    cards.push(plan)
    const advancePlan = async (step: string): Promise<void> => {
      planSteps.push(step)
      await this.updatePlanCard(plan.id, { steps: [...planSteps], status: 'running' })
      onEvent?.({ type: 'step', planId: plan.id, step, status: 'running' })
    }
    const finishPlan = async (status: PlanStatus): Promise<void> => {
      await this.updatePlanCard(plan.id, { steps: [...planSteps], status })
      onEvent?.({ type: 'done', planId: plan.id, status })
    }
    let lastDerived: { kind: 'transform' | 'join'; title: string; datasetId: string } | undefined

    try {
    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
      const existingCharts = this.state.cards
        .filter((card) => card.threadId === thread.id && card.kind === 'chart')
        .map((card) => card.title)
      const workspaceDatasets = this.state.datasets
        .filter((candidate) => candidate.workspaceId === thread.workspaceId)
        .map((candidate) => ({ id: candidate.id, name: candidate.name, columns: candidate.columns.map((column) => column.name) }))
      const workspaceRelations = this.state.relations
        .filter((relation) => relation.workspaceId === thread.workspaceId)
        .map((relation) => ({
          leftDatasetId: relation.leftDatasetId,
          leftColumn: relation.leftColumn,
          rightDatasetId: relation.rightDatasetId,
          rightColumn: relation.rightColumn,
        }))
      const built = buildAgentPrompt(question, {
        datasetName: dataset.name,
        rows: { columns: rows.columns, rows: rows.rows.slice(0, 50) },
        existingCharts,
        ...(priorSteps.length === 0 ? {} : { priorSteps }),
        otherDatasets: workspaceDatasets.filter((candidate) => candidate.id !== dataset.id),
        relations: workspaceRelations,
      })
      let text = ''
      try {
        for await (const chunk of runtime.stream({
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
          system: built.system,
          messages: [{ role: 'user', content: [{ type: 'text', text: built.user }] }],
        })) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        }
      } catch {
        throw new DataError('agent-failed', 'the model call failed')
      }

      let reply
      try {
        reply = parseAgentReply(text, rows, {
          currentDatasetId: dataset.id,
          datasets: workspaceDatasets,
          relations: workspaceRelations,
        })
      } catch {
        throw new DataError('agent-failed', 'the model reply was not a valid data instruction')
      }

      if (reply.kind === 'answer') {
        await advancePlan(`✓ 回答：${reply.answer.slice(0, 80)}`)
        cards.push(await this.createCard({ threadId: thread.id, kind: 'note', title: '数据助手', text: reply.answer }))
        await finishPlan('done')
        return { reply: { kind: 'answer', answer: reply.answer }, cards }
      }

      if (reply.kind === 'join') {
        const joined = await this.joinDatasets({
          leftDatasetId: dataset.id,
          rightDatasetId: reply.rightDatasetId,
          leftColumn: reply.leftColumn,
          rightColumn: reply.rightColumn,
          how: reply.how,
          name: reply.title,
        })
        cards.push(await this.createCard({
          threadId: thread.id,
          kind: 'dataset',
          title: reply.title,
          datasetId: joined.id,
        }))
        if (reply.explanation !== undefined) {
          cards.push(await this.createCard({ threadId: thread.id, kind: 'note', title: '数据助手', text: reply.explanation }))
        }
        lastDerived = { kind: 'join', title: reply.title, datasetId: joined.id }
        await advancePlan(`✓ 连接数据集：${reply.title}`)
        priorSteps.push(`join ${reply.title} (${reply.how})`)
        dataset = joined
        rows = await this.repo.readDataset(joined.id)
        if (step === MAX_AGENT_STEPS - 1) break
        continue
      }

      if (reply.kind === 'transform') {
        const derived = await this.deriveDataset({ datasetId: dataset.id, name: reply.title, operation: reply.operation })
        cards.push(await this.createCard({
          threadId: thread.id,
          kind: 'dataset',
          title: reply.title,
          datasetId: derived.id,
        }))
        if (reply.explanation !== undefined) {
          cards.push(await this.createCard({ threadId: thread.id, kind: 'note', title: '数据助手', text: reply.explanation }))
        }
        lastDerived = { kind: 'transform', title: reply.title, datasetId: derived.id }
        await advancePlan(`✓ 派生数据集：${reply.title}`)
        priorSteps.push(`${describeOperation(reply.operation)} → ${reply.title}`)
        dataset = derived
        rows = await this.repo.readDataset(derived.id)
        if (step === MAX_AGENT_STEPS - 1) break
        continue
      }

      const chart = await this.createCard({
        threadId: thread.id,
        kind: 'chart',
        title: reply.title,
        datasetId: dataset.id,
        spec: replyToSpec(reply),
      })
      cards.push(chart)
      if (reply.explanation !== undefined) {
        cards.push(await this.createCard({ threadId: thread.id, kind: 'note', title: '数据助手', text: reply.explanation }))
      }
      await advancePlan(`✓ 生成图表：${reply.title}`)
      await finishPlan('done')
      return { reply: { kind: 'chart', title: reply.title }, cards }
    }

    if (lastDerived === undefined) {
      throw new DataError('agent-failed', 'the model did not produce a chart or dataset')
    }
    await advancePlan(`⚠ 达到步骤上限，保留派生数据集：${lastDerived.title}`)
    await finishPlan('done')
    return { reply: lastDerived, cards }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.updatePlanCard(plan.id, { steps: [...planSteps, `✗ ${message}`], status: 'error' })
      onEvent?.({ type: 'error', planId: plan.id, status: 'error', error: message })
      throw error
    }
  }

  /** Replace a thread's shared chart filters after validating columns against its datasets. */
  async setThreadFilters(id: string, filters: readonly ChartFilter[], ranges: readonly ChartRange[] = []): Promise<DataThread> {
    const thread = this.findThread(id)
    const datasetIds = this.state.cards
      .filter((card): card is DatasetCard => card.threadId === id && card.kind === 'dataset')
      .map((card) => card.datasetId)
    const columns = new Set(
      this.state.datasets
        .filter((dataset) => datasetIds.includes(dataset.id))
        .flatMap((dataset) => dataset.columns.map((column) => column.name)),
    )
    const normalized: ChartFilter[] = []
    for (const filter of filters) {
      if (!columns.has(filter.column)) throw new DataError('invalid-chart', `unknown filter column: ${filter.column}`)
      if (!Array.isArray(filter.values) || filter.values.length === 0) throw new DataError('invalid-chart', 'filter values must not be empty')
      normalized.push({ column: filter.column, values: [...new Set(filter.values.map(String))].slice(0, 50) })
    }
    const numericColumns = new Set(this.state.datasets
      .filter((dataset) => datasetIds.includes(dataset.id))
      .flatMap((dataset) => dataset.columns.filter((column) => column.type === 'number').map((column) => column.name)))
    const normalizedRanges: ChartRange[] = []
    for (const range of ranges) {
      if (!numericColumns.has(range.column)) throw new DataError('invalid-chart', `unknown numeric range column: ${range.column}`)
      for (const bound of [range.min, range.max]) {
        if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) throw new DataError('invalid-chart', 'range bounds must be finite numbers')
      }
      if (range.min !== undefined && range.max !== undefined && range.min > range.max) throw new DataError('invalid-chart', 'range min must not exceed max')
      normalizedRanges.push({
        column: range.column,
        ...(range.min === undefined ? {} : { min: range.min }),
        ...(range.max === undefined ? {} : { max: range.max }),
      })
    }
    const next: DataThread = {
      ...thread,
      ...(normalized.length === 0 ? { filters: undefined } : { filters: normalized }),
      ...(normalizedRanges.length === 0 ? { ranges: undefined } : { ranges: normalizedRanges }),
      updatedAt: now(),
    }
    this.state = { ...this.state, threads: this.state.threads.map((row) => row.id === id ? next : row) }
    await this.save()
    return next
  }

  async forkThread(id: string): Promise<DataThread> {
    const source = this.findThread(id)
    return await this.createThread({
      workspaceId: source.workspaceId,
      name: `${source.name} · 分支`,
      copyFromThreadId: source.id,
    })
  }

  async removeThread(id: string): Promise<void> {
    this.findThread(id)
    this.state = {
      ...this.state,
      threads: this.state.threads.filter((row) => row.id !== id),
      cards: this.state.cards.filter((row) => row.threadId !== id),
      reports: this.state.reports.filter((row) => row.threadId !== id),
    }
    await this.save()
  }

  async renameThread(id: string, name: string): Promise<DataThread> {
    this.findThread(id)
    const next = this.state.threads.map((row) => row.id === id ? { ...row, name: cleanName(name, 'thread name'), updatedAt: now() } : row)
    this.state = { ...this.state, threads: next }
    await this.save()
    return next.find((row) => row.id === id)!
  }

  private async createPlanCard(threadId: string, prompt: string, steps: readonly string[]): Promise<PlanCard> {
    const card: PlanCard = {
      id: `card-${randomUUID()}`,
      threadId,
      kind: 'plan',
      title: '分析过程',
      prompt,
      steps,
      status: 'running',
      createdAt: now(),
    }
    this.state = { ...this.state, cards: [...this.state.cards, card] }
    await this.save()
    return card
  }

  private async updatePlanCard(id: string, patch: { steps?: readonly string[]; status?: PlanStatus }): Promise<PlanCard> {
    const card = this.state.cards.find((row): row is PlanCard => row.id === id && row.kind === 'plan')
    if (card === undefined) throw new DataError('no-such-card', `no such plan card: ${id}`)
    const next: PlanCard = { ...card, ...patch }
    this.state = { ...this.state, cards: this.state.cards.map((row) => row.id === id ? next : row) }
    await this.save()
    return next
  }

  async createCard(input: CardInput): Promise<DataCard> {
    this.findThread(input.threadId)
    const title = cleanName(input.title, 'card title')
    const base = {
      id: `card-${randomUUID()}`,
      threadId: input.threadId,
      title,
      createdAt: now(),
      ...(input.parentCardId === undefined ? {} : { parentCardId: input.parentCardId }),
    }
    let card: DataCard
    if (input.kind === 'dataset') {
      if (input.datasetId === undefined) throw new DataError('invalid-card', 'dataset card needs datasetId')
      this.findDataset(input.datasetId)
      card = { ...base, kind: 'dataset', datasetId: input.datasetId }
    } else if (input.kind === 'chart') {
      if (input.datasetId === undefined) throw new DataError('invalid-card', 'chart card needs datasetId')
      const dataset = this.findDataset(input.datasetId)
      const rows = await this.repo.readDataset(dataset.id)
      card = { ...base, kind: 'chart', datasetId: input.datasetId, spec: assertSpec(input.spec, rows) }
    } else {
      card = { ...base, kind: 'note', text: (input.text ?? '').slice(0, 10_000) }
    }
    this.state = { ...this.state, cards: [...this.state.cards, card] }
    await this.save()
    return card
  }

  async updateCard(patch: CardPatch): Promise<DataCard> {
    const card = this.findCard(patch.id)
    let next: DataCard = card
    if (patch.title !== undefined) next = { ...next, title: cleanName(patch.title, 'card title') }
    if (next.kind === 'chart' && patch.spec !== undefined) {
      const rows = await this.repo.readDataset(next.datasetId)
      next = { ...next, spec: assertSpec(patch.spec, rows) }
    }
    if (next.kind === 'note' && patch.text !== undefined) next = { ...next, text: patch.text.slice(0, 10_000) }
    this.state = { ...this.state, cards: this.state.cards.map((row) => row.id === next.id ? next : row) }
    await this.save()
    return next
  }

  async removeCard(id: string): Promise<void> {
    this.findCard(id)
    this.state = { ...this.state, cards: this.state.cards.filter((row) => row.id !== id) }
    await this.save()
  }
}
