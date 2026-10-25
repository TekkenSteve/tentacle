/**
 * Data Studio domain types (design 11).
 *
 * The model is intentionally Data Formulator-shaped but DSH-native:
 *  - a Workspace groups datasets and threads;
 *  - a Thread is one branching analysis line; its cards are the visible story
 *    (dataset anchors, charts, notes);
 *  - datasets are stored as normalized rows on disk; the state file only keeps
 *    their metadata so the JSON stays small.
 */
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
  /** Output column name; defaults to `<fn>_<column>`. */
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

/** A join recipe, persisted as dataset provenance. */
export interface JoinSpec {
  readonly leftDatasetId: string
  readonly rightDatasetId: string
  readonly leftColumn: string
  readonly rightColumn: string
  readonly how: JoinKind
}

/** Data memory: a known key relationship between two datasets. */
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
  /** Derived dataset provenance: the source dataset and operation. */
  readonly sourceDatasetId?: string
  readonly operation?: DataOperation
  /** Joined dataset provenance. */
  readonly join?: JoinSpec
  /** Refreshable external source (URL / workspace file). */
  readonly source?: DatasetSource
  readonly refreshedAt?: number
  /** Automatic refresh cadence in seconds; 0/undefined means manual only. */
  readonly autoRefreshSec?: number
  readonly lastRefreshAttemptAt?: number
  /** Last auto/manual refresh failure; rows stay at the previous good version. */
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
export const CHART_THEMES: readonly ChartTheme[] = ['default', 'warm', 'cool', 'mono']

/** One categorical filter applied before a chart aggregates. */
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
  /** Label the highest data point. */
  readonly max?: boolean
  /** Draw a reference line at the mean. */
  readonly mean?: boolean
  /** Label every data point / bar. */
  readonly labels?: boolean
}

export interface ChartSpec {
  readonly chart: ChartKind
  /** Category / x-axis column. */
  readonly x: string
  /** Measure / y-axis column. Omitted for count-only charts. */
  readonly y?: string
  readonly aggregate: ChartAggregate
  /** Optional categorical channel splitting the measure into series. */
  readonly color?: string
  /** Optional numeric channel controlling scatter point size, or heatmap value. */
  readonly size?: string
  /** Heatmap measure (x/y are the two dimensions). */
  readonly value?: string
  /** Candlestick OHLC measures. */
  readonly open?: string
  readonly high?: string
  readonly low?: string
  readonly close?: string
  /** Gantt end field. */
  readonly x2?: string
  /** KPI target/goal measure. */
  readonly goal?: string
  /** Range-area upper bound. */
  readonly y2?: string
  /** Optional categorical channel producing small multiples. */
  readonly facet?: string
  /** Sort category labels; `none` preserves first-seen order. */
  readonly sort?: ChartSort
  readonly title?: string
  readonly theme?: ChartTheme
  readonly filters?: readonly ChartFilter[]
  /** Numeric range control applied before aggregation. */
  readonly range?: ChartRange
  readonly annotations?: ChartAnnotations
  /** Flint chart-property overrides (opacity, corner radius, log scale, …). */
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
  /** Step lines with ✓ / ⚠ / · prefixes, mirroring the agent's actions. */
  readonly steps: readonly string[]
  readonly status: PlanStatus
}

export type DataCard = DatasetCard | ChartCard | NoteCard | PlanCard

export interface DataThread {
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  readonly parentThreadId?: string
  /** Filters shared by every chart in this thread (columns missing from a dataset are ignored). */
  readonly filters?: readonly ChartFilter[]
  /** Numeric ranges shared by every chart in this thread. */
  readonly ranges?: readonly ChartRange[]
  readonly createdAt: number
  readonly updatedAt: number
}

export type ConnectionKind = 'database' | 'objectstore'

export interface DataConnectionProfile {
  readonly id: string
  readonly kind: ConnectionKind
  readonly name: string
  /** Connection fields WITHOUT the secret; the secret lives in the credentials store. */
  readonly config: Record<string, unknown>
  readonly credentialRef: string
  readonly createdAt: number
}

export interface DataReport {
  readonly id: string
  readonly workspaceId: string
  /** Thread this report was generated from; removed with that thread. */
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
  readonly connections: readonly DataConnectionProfile[]
}

export function emptyState(): DataState {
  return { version: 1, workspaces: [], datasets: [], threads: [], cards: [], reports: [], relations: [], connections: [] }
}
