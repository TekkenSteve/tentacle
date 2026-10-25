import { describe, expect, it } from 'vitest'
import { applyChartRange, buildSeries } from '../src/client/console/chart-model.js'
import type { ChartSpec, DatasetRows } from '../src/client/console/api.js'

const rows: DatasetRows = {
  columns: [{ name: 'month', type: 'string' }, { name: 'revenue', type: 'number' }],
  rows: [
    { month: 'Jan', revenue: 10 },
    { month: 'Feb', revenue: 20 },
    { month: 'Mar', revenue: 30 },
  ],
}

describe('numeric range control', () => {
  it('filters rows by min/max before aggregation', () => {
    expect(applyChartRange(rows, { column: 'revenue', min: 15, max: 25 }).rows).toHaveLength(1)
    expect(applyChartRange(rows, { column: 'revenue', min: 15 }).rows).toHaveLength(2)
    expect(applyChartRange(rows, { column: 'revenue', max: 20 }).rows).toHaveLength(2)
  })

  it('keeps rows when the range is absent or the column is missing', () => {
    expect(applyChartRange(rows, undefined).rows).toHaveLength(3)
    expect(applyChartRange(rows, { column: 'missing', min: 0 }).rows).toHaveLength(3)
  })

  it('changes the aggregated chart', () => {
    const spec: ChartSpec = { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum' }
    const series = buildSeries(applyChartRange(rows, { column: 'revenue', min: 15 }), spec)
    expect(series.points).toEqual([{ label: 'Feb', value: 20 }, { label: 'Mar', value: 30 }])
  })
})
