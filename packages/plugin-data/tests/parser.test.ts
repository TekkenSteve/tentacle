import { describe, expect, it } from 'vitest'
import { inferType, parseCsv, parseCsvDataset, parseJsonDataset, DatasetParseError } from '../src/parser.js'

describe('CSV parsing', () => {
  it('handles quotes, escaped quotes, CRLF and embedded newlines', () => {
    const parsed = parseCsv('name,note\r\n"ACME, Inc.","line one\nline two"\r\n"say ""hi""",plain\r\n')
    expect(parsed.headers).toEqual(['name', 'note'])
    expect(parsed.records).toEqual([
      ['ACME, Inc.', 'line one\nline two'],
      ['say "hi"', 'plain'],
    ])
  })

  it('infers scalar types and keeps leading-zero strings literal', () => {
    const parsed = parseCsvDataset('region,revenue,code,active\nnorth,10.5,001,true\nsouth,20,002,false\n')
    expect(parsed.columns).toEqual([
      { name: 'region', type: 'string' },
      { name: 'revenue', type: 'number' },
      { name: 'code', type: 'string' },
      { name: 'active', type: 'boolean' },
    ])
    expect(parsed.rows[0]).toEqual({ region: 'north', revenue: 10.5, code: '001', active: true })
  })

  it('rejects empty and duplicate-header CSVs', () => {
    expect(() => parseCsv('')).toThrowError(DatasetParseError)
    expect(() => parseCsvDataset('a,a\n1,2')).toThrowError(/duplicate/)
  })
})

describe('JSON parsing', () => {
  it('accepts an array of objects and unions keys', () => {
    const parsed = parseJsonDataset('[{"a":1},{"b":"x"}]')
    expect(parsed.columns.map((column) => column.name)).toEqual(['a', 'b'])
    expect(parsed.rows[0]).toEqual({ a: 1, b: null })
  })

  it('accepts one object and rejects non-object arrays', () => {
    expect(parseJsonDataset('{"a":1}').rows).toHaveLength(1)
    expect(() => parseJsonDataset('[1,2]')).toThrowError(/array of objects/)
    expect(() => parseJsonDataset('{oops')).toThrowError(/valid/)
  })
})

describe('type inference', () => {
  it('classifies dates and unknown-only columns', () => {
    expect(inferType(['2026-01-02', '2026-01-03'])).toBe('date')
    expect(inferType([null, null])).toBe('unknown')
    expect(inferType(['a', 1])).toBe('string')
  })
})
