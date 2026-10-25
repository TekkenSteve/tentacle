/**
 * Chart aggregation for Data Studio. Pure, deterministic and dependency-free
 * so both the SVG renderer and the tests can use it.
 */
import type { ChartFilter, ChartRange, ChartSpec, DatasetRows, Scalar } from './api.ts'

export interface CategoryPoint {
  readonly label: string
  readonly value: number
}

export interface ScatterPoint {
  readonly x: number
  readonly y: number
  readonly label: string
  readonly color?: string
  readonly size?: number
}

export interface SeriesGroup {
  readonly name: string
  readonly values: readonly number[]
}

export interface GroupedSeries {
  readonly labels: readonly string[]
  readonly groups: readonly SeriesGroup[]
}

export interface Series {
  readonly kind: 'category' | 'scatter'
  readonly points: readonly CategoryPoint[]
  readonly scatter: readonly ScatterPoint[]
}

function numeric(value: Scalar | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function labelOf(value: Scalar | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** Apply a chart's categorical filters before aggregation. */
export function applyChartFilters(rows: DatasetRows, filters: readonly ChartFilter[] | undefined): DatasetRows {
  if (filters === undefined || filters.length === 0) return rows
  const known = new Set(rows.columns.map((column) => column.name))
  const active = filters.filter((filter) => known.has(filter.column))
  if (active.length === 0) return rows
  return {
    columns: rows.columns,
    rows: rows.rows.filter((row) => active.every((filter) => {
      const value = row[filter.column]
      return value !== null && value !== undefined && filter.values.includes(String(value))
    })),
  }
}

export interface BoxplotGroup {
  readonly label: string
  readonly min: number
  readonly q1: number
  readonly median: number
  readonly q3: number
  readonly max: number
}

function quantile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const position = (sorted.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

/** Box-and-whisker statistics for each x category. */
export function buildBoxplot(rows: DatasetRows, spec: ChartSpec): readonly BoxplotGroup[] {
  const groups = new Map<string, number[]>()
  for (const row of rows.rows) {
    const label = labelOf(row[spec.x])
    const value = spec.y === undefined ? undefined : numeric(row[spec.y])
    if (value === undefined) continue
    const values = groups.get(label) ?? []
    values.push(value)
    groups.set(label, values)
  }
  const result: BoxplotGroup[] = []
  for (const [label, values] of groups) {
    values.sort((a, b) => a - b)
    result.push({
      label,
      min: values[0]!,
      q1: quantile(values, 0.25),
      median: quantile(values, 0.5),
      q3: quantile(values, 0.75),
      max: values[values.length - 1]!,
    })
  }
  return result
}

export interface HeatmapCell {
  readonly x: string
  readonly y: string
  readonly value: number
}

export interface HeatmapData {
  readonly xLabels: readonly string[]
  readonly yLabels: readonly string[]
  readonly cells: readonly HeatmapCell[]
  readonly max: number
}

/** Aggregate a measure over two dimensions for a heatmap. */
export function buildHeatmap(rows: DatasetRows, spec: ChartSpec): HeatmapData {
  const xLabels: string[] = []
  const yLabels: string[] = []
  const buckets = new Map<string, { x: string; y: string; sum: number; count: number; value: number }>()
  const labelOfValue = (value: Scalar | undefined): string => {
    if (value === null || value === undefined) return '—'
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    return String(value)
  }
  for (const row of rows.rows) {
    const x = labelOfValue(row[spec.x])
    const y = spec.y === undefined ? '—' : labelOfValue(row[spec.y])
    if (!xLabels.includes(x)) xLabels.push(x)
    if (!yLabels.includes(y)) yLabels.push(y)
    const key = `${x}::${y}`
    const bucket = buckets.get(key) ?? { x, y, sum: 0, count: 0, value: 0 }
    if (spec.aggregate === 'count') bucket.count += 1
    else {
      const value = spec.value === undefined ? undefined : numeric(row[spec.value])
      if (value !== undefined) { bucket.sum += value; bucket.count += 1; bucket.value = value }
    }
    buckets.set(key, bucket)
  }
  const cells = [...buckets.values()].map((bucket) => ({
    x: bucket.x,
    y: bucket.y,
    value: spec.aggregate === 'count' ? bucket.count : spec.aggregate === 'avg' ? (bucket.count === 0 ? 0 : bucket.sum / bucket.count) : spec.aggregate === 'sum' ? bucket.sum : bucket.value,
  }))
  return { xLabels, yLabels, cells, max: Math.max(0, ...cells.map((cell) => cell.value)) }
}

/** Apply a numeric range control before aggregation. */
export function applyChartRange(rows: DatasetRows, range: ChartRange | undefined): DatasetRows {
  if (range === undefined) return rows
  if (!rows.columns.some((column) => column.name === range.column)) return rows
  return {
    columns: rows.columns,
    rows: rows.rows.filter((row) => {
      const value = row[range.column]
      const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined
      if (numeric === undefined || !Number.isFinite(numeric)) return false
      if (range.min !== undefined && numeric < range.min) return false
      if (range.max !== undefined && numeric > range.max) return false
      return true
    }),
  }
}

/** Aggregate rows into category points or raw scatter points. */
export function buildSeries(rows: DatasetRows, spec: ChartSpec): Series {
  if (spec.chart === 'scatter') {
    const scatter: ScatterPoint[] = []
    for (const row of rows.rows) {
      const x = numeric(row[spec.x])
      const y = numeric(spec.y === undefined ? undefined : row[spec.y])
      if (x === undefined || y === undefined) continue
      const color = spec.color === undefined ? undefined : labelOf(row[spec.color])
      const size = spec.size === undefined ? undefined : numeric(row[spec.size])
      scatter.push({ x, y, label: `${x}, ${y}`, ...(color === undefined ? {} : { color }), ...(size === undefined ? {} : { size }) })
    }
    return { kind: 'scatter', points: [], scatter }
  }

  const buckets = new Map<string, { sum: number; count: number; value: number }>()
  for (const row of rows.rows) {
    const label = labelOf(row[spec.x])
    const bucket = buckets.get(label) ?? { sum: 0, count: 0, value: 0 }
    if (spec.aggregate === 'count') {
      bucket.count += 1
    } else {
      const value = numeric(spec.y === undefined ? undefined : row[spec.y])
      if (value !== undefined) {
        bucket.sum += value
        bucket.count += 1
        bucket.value = value
      }
    }
    buckets.set(label, bucket)
  }

  const points: CategoryPoint[] = []
  for (const [label, bucket] of buckets) {
    let value = 0
    if (spec.aggregate === 'count') value = bucket.count
    else if (spec.aggregate === 'avg') value = bucket.count === 0 ? 0 : bucket.sum / bucket.count
    else if (spec.aggregate === 'sum') value = bucket.sum
    else value = bucket.value
    points.push({ label, value })
  }

  // Keep declaration order for textual categories; order numeric/date
  // categories so a line/bar reads left-to-right.
  const allNumeric = points.every((point) => Number.isFinite(Number(point.label)) && point.label.trim() !== '')
  if (spec.sort === 'asc' || spec.sort === 'desc') {
    const direction = spec.sort === 'desc' ? -1 : 1
    points.sort((a, b) => allNumeric ? (Number(a.label) - Number(b.label)) * direction : a.label.localeCompare(b.label) * direction)
  } else if (allNumeric) {
    points.sort((a, b) => Number(a.label) - Number(b.label))
  }
  return { kind: 'category', points, scatter: [] }
}

/** Aggregate a second categorical channel into one series per color value. */
export function buildGroupedSeries(rows: DatasetRows, spec: ChartSpec): GroupedSeries {
  const labels = buildSeries(rows, spec).points.map((point) => point.label)
  const buckets = new Map<string, Map<string, { sum: number; count: number; value: number }>>()
  for (const row of rows.rows) {
    const label = labelOf(row[spec.x])
    const group = spec.color === undefined ? '—' : labelOf(row[spec.color])
    const byLabel = buckets.get(group) ?? new Map()
    const bucket = byLabel.get(label) ?? { sum: 0, count: 0, value: 0 }
    if (spec.aggregate === 'count') bucket.count += 1
    else {
      const value = numeric(spec.y === undefined ? undefined : row[spec.y])
      if (value !== undefined) {
        bucket.sum += value
        bucket.count += 1
        bucket.value = value
      }
    }
    byLabel.set(label, bucket)
    buckets.set(group, byLabel)
  }
  const groups: SeriesGroup[] = []
  for (const [name, byLabel] of buckets) {
    const values = labels.map((label) => {
      const bucket = byLabel.get(label)
      if (bucket === undefined) return 0
      if (spec.aggregate === 'count') return bucket.count
      if (spec.aggregate === 'avg') return bucket.count === 0 ? 0 : bucket.sum / bucket.count
      if (spec.aggregate === 'sum') return bucket.sum
      return bucket.value
    })
    groups.push({ name, values })
  }
  groups.sort((a, b) => a.name.localeCompare(b.name))
  return { labels, groups }
}

/** The largest absolute value across points (0-safe). */
export function maxMagnitude(values: readonly number[]): number {
  return Math.max(0, ...values.map((value) => Math.abs(value)))
}

/** Round a maximum up to a readable axis bound. */
export function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}
