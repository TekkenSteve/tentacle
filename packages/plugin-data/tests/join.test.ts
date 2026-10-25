import { describe, expect, it } from 'vitest'
import { applyJoin, describeJoin } from '../src/join.js'
import type { DatasetRows } from '../src/types.js'

const left: DatasetRows = {
  columns: [{ name: 'month', type: 'string' }, { name: 'revenue', type: 'number' }],
  rows: [{ month: 'Jan', revenue: 100 }, { month: 'Feb', revenue: 120 }, { month: 'Mar', revenue: 90 }],
}
const right: DatasetRows = {
  columns: [{ name: 'month', type: 'string' }, { name: 'region', type: 'string' }, { name: 'revenue', type: 'number' }],
  rows: [{ month: 'Jan', region: 'north', revenue: 50 }, { month: 'Jan', region: 'south', revenue: 60 }, { month: 'Feb', region: 'north', revenue: 70 }],
}

describe('dataset joins', () => {
  it('inner joins fan out duplicate right keys and alias collisions', () => {
    const joined = applyJoin({ left, right, spec: { leftDatasetId: 'l', rightDatasetId: 'r', leftColumn: 'month', rightColumn: 'month', how: 'inner' } })
    expect(joined.columns.map((column) => column.name)).toEqual(['month', 'revenue', 'month_right', 'region', 'revenue_right'])
    expect(joined.rows).toHaveLength(3)
    expect(joined.rows[0]).toMatchObject({ month: 'Jan', revenue: 100, month_right: 'Jan', region: 'north', revenue_right: 50 })
    expect(joined.rows.some((row) => row.month === 'Mar')).toBe(false)
  })

  it('left joins keep unmatched rows with null right columns', () => {
    const joined = applyJoin({ left, right, spec: { leftDatasetId: 'l', rightDatasetId: 'r', leftColumn: 'month', rightColumn: 'month', how: 'left' } })
    expect(joined.rows).toHaveLength(4)
    expect(joined.rows.find((row) => row.month === 'Mar')).toMatchObject({ month: 'Mar', revenue: 90, region: null, revenue_right: null })
  })

  it('describes a join', () => {
    expect(describeJoin({ leftDatasetId: 'l', rightDatasetId: 'r', leftColumn: 'month', rightColumn: 'month', how: 'inner' }, 'Sales', 'Regions')).toBe('inner join Sales.month = Regions.month')
  })
})
