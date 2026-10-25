import { describe, expect, it } from 'vitest'
import { recommendCharts } from '../src/shared/recommend.js'
import type { DatasetRows } from '../src/types.js'

const sales: DatasetRows = {
  columns: [
    { name: 'month', type: 'string' },
    { name: 'revenue', type: 'number' },
    { name: 'cost', type: 'number' },
  ],
  rows: [
    { month: 'Jan', revenue: 100, cost: 60 },
    { month: 'Feb', revenue: 120, cost: 70 },
    { month: 'Mar', revenue: 90, cost: 50 },
  ],
}

describe('chart recommendations', () => {
  it('recommends bar, pie and scatter for category + measures', () => {
    const recs = recommendCharts(sales)
    expect(recs.map((rec) => rec.spec.chart)).toEqual(expect.arrayContaining(['bar', 'pie', 'scatter']))
    expect(recs.every((rec) => rec.reason.length > 0)).toBe(true)
    expect(new Set(recs.map((rec) => JSON.stringify(rec.spec))).size).toBe(recs.length)
  })

  it('recommends a line first for date + measure', () => {
    const rows: DatasetRows = {
      columns: [{ name: 'date', type: 'date' }, { name: 'value', type: 'number' }],
      rows: [
        { date: '2026-01-01', value: 1 },
        { date: '2026-01-02', value: 2 },
        { date: '2026-01-03', value: 3 },
      ],
    }
    expect(recommendCharts(rows)[0]?.spec).toMatchObject({ chart: 'line', x: 'date', y: 'value' })
  })

  it('counts categories when there is no numeric measure', () => {
    const rows: DatasetRows = {
      columns: [{ name: 'region', type: 'string' }],
      rows: [{ region: 'north' }, { region: 'south' }, { region: 'east' }],
    }
    expect(recommendCharts(rows)[0]?.spec).toMatchObject({ chart: 'bar', x: 'region', aggregate: 'count' })
  })

  it('does not recommend a chart for a single constant value', () => {
    const rows: DatasetRows = {
      columns: [{ name: 'region', type: 'string' }, { name: 'value', type: 'number' }],
      rows: [{ region: 'north', value: 1 }, { region: 'north', value: 2 }],
    }
    expect(recommendCharts(rows)).toHaveLength(0)
  })

  it('skips high-cardinality categories', () => {
    const rows: DatasetRows = {
      columns: [{ name: 'id', type: 'string' }, { name: 'value', type: 'number' }],
      rows: Array.from({ length: 30 }, (_, index) => ({ id: `id-${index}`, value: index })),
    }
    expect(recommendCharts(rows).some((rec) => rec.spec.x === 'id')).toBe(false)
  })
})
