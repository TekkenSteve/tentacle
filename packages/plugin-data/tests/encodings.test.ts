import { describe, expect, it } from 'vitest'
import { buildGroupedSeries, buildSeries } from '../src/client/console/chart-model.js'
import type { ChartSpec, DatasetRows } from '../src/client/console/api.js'

const rows: DatasetRows = {
  columns: [
    { name: 'month', type: 'string' },
    { name: 'region', type: 'string' },
    { name: 'revenue', type: 'number' },
    { name: 'population', type: 'number' },
  ],
  rows: [
    { month: 'Jan', region: 'north', revenue: 10, population: 100 },
    { month: 'Jan', region: 'south', revenue: 20, population: 200 },
    { month: 'Feb', region: 'north', revenue: 30, population: 300 },
  ],
}

describe('color / size encodings', () => {
  it('groups a measure into one series per color value', () => {
    const spec: ChartSpec = { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum', color: 'region' }
    const grouped = buildGroupedSeries(rows, spec)
    expect(grouped.labels).toEqual(['Jan', 'Feb'])
    expect(grouped.groups).toEqual([
      { name: 'north', values: [10, 30] },
      { name: 'south', values: [20, 0] },
    ])
  })

  it('carries color and size into scatter points', () => {
    const spec: ChartSpec = { chart: 'scatter', x: 'population', y: 'revenue', aggregate: 'none', color: 'region', size: 'population' }
    const series = buildSeries(rows, spec)
    expect(series.scatter[0]).toMatchObject({ x: 100, y: 10, color: 'north', size: 100 })
  })
})
