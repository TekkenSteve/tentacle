import { describe, expect, it } from 'vitest'
import { suggestRelations } from '../src/relations.js'
import type { DatasetRows } from '../src/types.js'

const sales: DatasetRows = {
  columns: [{ name: 'month', type: 'string' }, { name: 'revenue', type: 'number' }],
  rows: [{ month: 'Jan', revenue: 10 }, { month: 'Feb', revenue: 20 }, { month: 'Mar', revenue: 30 }],
}
const regions: DatasetRows = {
  columns: [{ name: 'month', type: 'string' }, { name: 'region', type: 'string' }],
  rows: [{ month: 'Jan', region: 'north' }, { month: 'Feb', region: 'south' }],
}
const other: DatasetRows = {
  columns: [{ name: 'month', type: 'string' }],
  rows: [{ month: 'Sep' }, { month: 'Oct' }],
}

function datasets() {
  return [
    { datasetId: 'sales', datasetName: 'Sales', rows: sales },
    { datasetId: 'regions', datasetName: 'Regions', rows: regions },
    { datasetId: 'other', datasetName: 'Other', rows: other },
  ]
}

describe('relationship suggestions', () => {
  it('finds same-named columns with strong value overlap', () => {
    const suggestions = suggestRelations(datasets(), [])
    expect(suggestions[0]).toMatchObject({ leftDatasetId: 'sales', leftColumn: 'month', rightDatasetId: 'regions', rightColumn: 'month', score: 1 })
    expect(suggestions.some((suggestion) => suggestion.rightDatasetId === 'other')).toBe(false)
  })

  it('skips existing relationships', () => {
    const suggestions = suggestRelations(datasets(), [{
      id: 'rel-1', workspaceId: 'w', leftDatasetId: 'sales', leftColumn: 'month',
      rightDatasetId: 'regions', rightColumn: 'month', createdAt: 0,
    }])
    expect(suggestions).toHaveLength(0)
  })

  it('skips incompatible column types', () => {
    const mismatch = [{
      datasetId: 'a', datasetName: 'A', rows: { columns: [{ name: 'id', type: 'number' as const }], rows: [{ id: 1 }, { id: 2 }] },
    }, {
      datasetId: 'b', datasetName: 'B', rows: { columns: [{ name: 'id', type: 'string' as const }], rows: [{ id: '1' }, { id: '2' }] },
    }]
    expect(suggestRelations(mismatch, [])).toHaveLength(0)
  })
})
