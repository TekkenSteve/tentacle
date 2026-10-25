import { describe, expect, it } from 'vitest'
import { applyChartFilters, buildSeries } from '../src/client/console/chart-model.js'
import type { ChartSpec, DatasetRows } from '../src/client/console/api.js'

const rows: DatasetRows = {
  columns: [
    { name: 'month', type: 'string' },
    { name: 'region', type: 'string' },
    { name: 'revenue', type: 'number' },
  ],
  rows: [
    { month: 'Jan', region: 'north', revenue: 10 },
    { month: 'Jan', region: 'south', revenue: 20 },
    { month: 'Feb', region: 'north', revenue: 30 },
  ],
}

const spec: ChartSpec = { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum' }

describe('chart filters', () => {
  it('filters rows before aggregation', () => {
    const filtered = applyChartFilters(rows, [{ column: 'region', values: ['north'] }])
    expect(filtered.rows).toHaveLength(2)
    const series = buildSeries(filtered, spec)
    expect(series.points).toEqual([{ label: 'Jan', value: 10 }, { label: 'Feb', value: 30 }])
  })

  it('keeps rows when no filters are set', () => {
    expect(applyChartFilters(rows, undefined).rows).toHaveLength(3)
    expect(applyChartFilters(rows, []).rows).toHaveLength(3)
  })

  it('returns an empty result for an unmatched value', () => {
    expect(applyChartFilters(rows, [{ column: 'region', values: ['west'] }]).rows).toHaveLength(0)
  })
})
