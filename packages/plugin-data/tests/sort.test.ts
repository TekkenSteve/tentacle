import { describe, expect, it } from 'vitest'
import { buildSeries } from '../src/client/console/chart-model.js'
import type { ChartSpec, DatasetRows } from '../src/client/console/api.js'

const rows: DatasetRows = {
  columns: [{ name: 'month', type: 'string' }, { name: 'revenue', type: 'number' }],
  rows: [
    { month: 'Mar', revenue: 30 },
    { month: 'Jan', revenue: 10 },
    { month: 'Feb', revenue: 20 },
  ],
}

function spec(sort?: ChartSpec['sort']): ChartSpec {
  return { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum', ...(sort === undefined ? {} : { sort }) }
}

describe('chart sort', () => {
  it('preserves first-seen order by default', () => {
    expect(buildSeries(rows, spec()).points.map((point) => point.label)).toEqual(['Mar', 'Jan', 'Feb'])
  })

  it('sorts labels ascending/descending', () => {
    expect(buildSeries(rows, spec('asc')).points.map((point) => point.label)).toEqual(['Feb', 'Jan', 'Mar'])
    expect(buildSeries(rows, spec('desc')).points.map((point) => point.label)).toEqual(['Mar', 'Jan', 'Feb'])
  })
})
