import { describe, expect, it } from 'vitest'
import { rowsToCsv, safeFilename } from '../src/client/console/export.js'
import type { DatasetRows } from '../src/client/console/api.js'

describe('export helpers', () => {
  it('writes CSV with BOM, headers and escaped cells', () => {
    const rows: DatasetRows = {
      columns: [{ name: 'name', type: 'string' }, { name: 'note', type: 'string' }, { name: 'value', type: 'number' }],
      rows: [
        { name: 'ACME, Inc.', note: 'say "hi"\nnext', value: 10 },
        { name: null, note: 'plain', value: 20 },
      ],
    }
    const csv = rowsToCsv(rows)
    expect(csv.startsWith('\uFEFFname,note,value\n')).toBe(true)
    expect(csv).toContain('"ACME, Inc.","say ""hi""\nnext",10')
    expect(csv).toContain(',plain,20')
  })

  it('sanitizes filenames', () => {
    expect(safeFilename('Revenue / 2026: "chart"')).toBe('Revenue 2026 chart')
    expect(safeFilename('...')).toBe('chart')
  })
})
