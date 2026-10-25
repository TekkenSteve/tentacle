/**
 * Chart recommendations from schema shape.
 *
 * Deliberately structural (column types + cardinality), not natural-language
 * heuristics: the goal is a small set of charts that are valid for almost any
 * table, matching Data Formulator's "recommendations" surface without guessing
 * the analyst's intent.
 */
import type { ChartSpec, DataColumn, DatasetRows } from '../types.js'

export interface ChartRecommendation {
  readonly spec: ChartSpec
  readonly reason: string
}

function distinct(rows: DatasetRows, column: string): number {
  const values = new Set<string>()
  for (const row of rows.rows.slice(0, 200)) {
    const value = row[column]
    if (value !== null && value !== undefined && String(value) !== '') values.add(String(value))
  }
  return values.size
}

function numericColumns(columns: readonly DataColumn[]): readonly DataColumn[] {
  return columns.filter((column) => column.type === 'number')
}

function categoricalColumns(rows: DatasetRows, columns: readonly DataColumn[]): readonly DataColumn[] {
  return columns.filter((column) => {
    if (column.type !== 'string' && column.type !== 'boolean') return false
    const count = distinct(rows, column.name)
    return count >= 2 && count <= 20
  })
}

/** Produce up to four structurally valid chart suggestions. */
export function recommendCharts(rows: DatasetRows): readonly ChartRecommendation[] {
  const dimensions = categoricalColumns(rows, rows.columns)
  const dates = rows.columns.filter((column) => column.type === 'date')
  const measures = numericColumns(rows.columns)
  const measure = measures[0]
  const secondMeasure = measures[1]
  const out: ChartRecommendation[] = []
  const seen = new Set<string>()

  const push = (spec: ChartSpec, reason: string): void => {
    const signature = `${spec.chart}|${spec.x}|${spec.y ?? ''}|${spec.aggregate}`
    if (seen.has(signature)) return
    seen.add(signature)
    out.push({ spec, reason })
  }

  // Time series first when a real date column exists.
  const date = dates[0]
  if (date !== undefined && measure !== undefined) {
    push({ chart: 'line', x: date.name, y: measure.name, aggregate: 'sum', title: `${measure.name} over ${date.name}` }, `Line: ${date.name} is a date and ${measure.name} is numeric.`)
  }

  // Prefer the most "interesting" category for bars: closest to 8 values,
  // while still small enough to read.
  const ordered = [...dimensions].sort((a, b) => {
    const da = distinct(rows, a.name)
    const db = distinct(rows, b.name)
    return Math.abs(da - 8) - Math.abs(db - 8)
  })
  const category = ordered[0]
  if (category !== undefined && measure !== undefined) {
    push({ chart: 'bar', x: category.name, y: measure.name, aggregate: 'sum', title: `${measure.name} by ${category.name}` }, `Bar: compare ${measure.name} across ${category.name}.`)
    if (distinct(rows, category.name) <= 8) {
      push({ chart: 'pie', x: category.name, y: measure.name, aggregate: 'sum', title: `${measure.name} share by ${category.name}` }, `Pie: ${category.name} has at most 8 values, good for parts of a whole.`)
    }
  }

  if (category !== undefined && measure === undefined) {
    push({ chart: 'bar', x: category.name, aggregate: 'count', title: `Count by ${category.name}` }, `Bar: count rows per ${category.name}.`)
  }

  if (measure !== undefined && secondMeasure !== undefined) {
    push({ chart: 'scatter', x: measure.name, y: secondMeasure.name, aggregate: 'none', title: `${secondMeasure.name} vs ${measure.name}` }, `Scatter: compare two numeric columns.`)
  }

  return out.slice(0, 4)
}
