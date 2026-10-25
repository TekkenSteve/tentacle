import { describe, expect, it } from 'vitest'
import { applyOperation, describeOperation, validateOperation } from '../src/operations.js'
import type { DatasetRows } from '../src/types.js'

const rows: DatasetRows = {
  columns: [
    { name: 'region', type: 'string' },
    { name: 'month', type: 'string' },
    { name: 'revenue', type: 'number' },
  ],
  rows: [
    { region: 'north', month: 'Jan', revenue: 100 },
    { region: 'north', month: 'Feb', revenue: 140 },
    { region: 'south', month: 'Jan', revenue: 80 },
    { region: 'south', month: 'Feb', revenue: 120 },
  ],
}

describe('group operation', () => {
  it('groups and aggregates each function', () => {
    const grouped = applyOperation(rows, {
      kind: 'group',
      groupBy: ['region'],
      aggregates: [
        { column: 'revenue', fn: 'sum' },
        { column: 'revenue', fn: 'avg', as: 'avg_revenue' },
        { column: 'month', fn: 'count', as: 'months' },
        { column: 'revenue', fn: 'min', as: 'min_revenue' },
        { column: 'revenue', fn: 'max', as: 'max_revenue' },
      ],
    })
    expect(grouped.columns.map((column) => column.name)).toEqual(['region', 'sum_revenue', 'avg_revenue', 'months', 'min_revenue', 'max_revenue'])
    expect(grouped.rows).toEqual([
      { region: 'north', sum_revenue: 240, avg_revenue: 120, months: 2, min_revenue: 100, max_revenue: 140 },
      { region: 'south', sum_revenue: 200, avg_revenue: 100, months: 2, min_revenue: 80, max_revenue: 120 },
    ])
  })

  it('groups by multiple keys and validates the operation', () => {
    const grouped = applyOperation(rows, {
      kind: 'group',
      groupBy: ['region', 'month'],
      aggregates: [{ column: 'revenue', fn: 'sum' }],
    })
    expect(grouped.rows).toHaveLength(4)
    expect(validateOperation({ kind: 'group', groupBy: ['nope'], aggregates: [{ column: 'revenue', fn: 'sum' }] }, rows.columns)).toMatchObject({ message: /unknown|non-empty/ })
    expect(validateOperation({ kind: 'group', groupBy: ['region'], aggregates: [{ column: 'revenue', fn: 'sum' }] }, rows.columns)).toBeUndefined()
  })
})

describe('filter operation', () => {
  it('filters numeric and string comparisons', () => {
    expect(applyOperation(rows, { kind: 'filter', column: 'revenue', op: 'gt', value: 100 }).rows).toHaveLength(2)
    expect(applyOperation(rows, { kind: 'filter', column: 'region', op: 'eq', value: 'north' }).rows).toHaveLength(2)
    expect(applyOperation(rows, { kind: 'filter', column: 'region', op: 'contains', value: 'sou' }).rows).toHaveLength(2)
    expect(applyOperation(rows, { kind: 'filter', column: 'revenue', op: 'lt', value: 100 }).rows).toHaveLength(1)
  })

  it('validates columns, operators and values', () => {
    expect(validateOperation({ kind: 'filter', column: 'nope', op: 'eq', value: 'x' }, rows.columns)).toMatchObject({ message: /unknown/ })
    expect(validateOperation({ kind: 'filter', column: 'region', op: 'like', value: 'x' }, rows.columns)).toMatchObject({ message: /operator/ })
    expect(validateOperation({ kind: 'filter', column: 'region', op: 'eq', value: {} }, rows.columns)).toMatchObject({ message: /value/ })
    expect(validateOperation({ kind: 'nope' }, rows.columns)).toMatchObject({ message: /kind/ })
  })
})

describe('operation labels', () => {
  it('describes both forms', () => {
    expect(describeOperation({ kind: 'filter', column: 'revenue', op: 'gt', value: 100 })).toBe('filter revenue gt 100')
    expect(describeOperation({ kind: 'group', groupBy: ['region'], aggregates: [{ column: 'revenue', fn: 'sum' }] })).toBe('group by region → sum(revenue)')
  })
})
