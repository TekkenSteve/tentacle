/**
 * Dataset parsing and type inference for Data Studio.
 *
 * Pure functions only: CSV is parsed with a small RFC-4180 compatible reader
 * (quoted separators, escaped quotes, embedded newlines); JSON accepts an
 * array of objects. Every value is normalized to a JSON scalar so chart
 * aggregation never sees adapter-specific shapes.
 */
import type { DataColumn, DataColumnType, Scalar } from './types.js'

export interface ParsedDataset {
  readonly columns: readonly DataColumn[]
  readonly rows: readonly Readonly<Record<string, Scalar>>[]
}

export class DatasetParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatasetParseError'
  }
}

/** Parse CSV text into a header + records (RFC 4180, tolerant of CRLF). */
export function parseCsv(text: string): { headers: string[]; records: string[][] } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const source = text.replace(/^\uFEFF/, '')

  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    if (row.some((value) => value.trim() !== '')) rows.push(row)
    row = []
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      pushField()
    } else if (char === '\n') {
      pushRow()
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field !== '' || row.length > 0) pushRow()
  if (rows.length === 0) throw new DatasetParseError('CSV has no rows')
  const headers = rows[0]!.map((header, index) => header.trim() === '' ? `column_${index + 1}` : header.trim())
  if (new Set(headers).size !== headers.length) throw new DatasetParseError('CSV has duplicate column names')
  return { headers, records: rows.slice(1) }
}

function parseScalar(raw: string): Scalar {
  const value = raw.trim()
  if (value === '') return null
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true'
  // Preserve identifiers such as postal codes / SKUs that start with 0.
  if (/^[-+]?0\d+$/.test(value)) return raw
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value)) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return raw
}

/** Infer one column's scalar type from its non-null values. */
export function inferType(values: readonly Scalar[]): DataColumnType {
  const present = values.filter((value) => value !== null)
  if (present.length === 0) return 'unknown'
  if (present.every((value) => typeof value === 'number')) return 'number'
  if (present.every((value) => typeof value === 'boolean')) return 'boolean'
  if (present.every((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value))) return 'date'
  return 'string'
}

function normalizeRows(rawRows: readonly Record<string, unknown>[], headers: readonly string[]): ParsedDataset {
  const rows = rawRows.map((raw) => {
    const row: Record<string, Scalar> = {}
    for (const header of headers) {
      const value = raw[header]
      if (value === null || value === undefined) row[header] = null
      else if (typeof value === 'number' || typeof value === 'boolean') {
        row[header] = typeof value === 'number' && !Number.isFinite(value) ? null : value
      } else row[header] = String(value)
    }
    return row
  })
  const columns = headers.map((name) => ({ name, type: inferType(rows.map((row) => row[name]!)) }))
  return { columns, rows }
}

/** Parse a CSV dataset. */
export function parseCsvDataset(text: string): ParsedDataset {
  const { headers, records } = parseCsv(text)
  const raw = records.map((record) => {
    const row: Record<string, unknown> = {}
    headers.forEach((header, index) => { row[header] = parseScalar(record[index] ?? '') })
    return row
  })
  return normalizeRows(raw, headers)
}

/** Parse a JSON dataset: an array of objects (or one object). */
export function parseJsonDataset(text: string): ParsedDataset {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new DatasetParseError('JSON is not valid')
  }
  const list = Array.isArray(value) ? value : [value]
  if (!list.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry))) {
    throw new DatasetParseError('JSON must be an array of objects')
  }
  const raw = list as Record<string, unknown>[]
  const headers: string[] = []
  for (const row of raw) {
    for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key)
  }
  if (headers.length === 0) throw new DatasetParseError('JSON has no columns')
  return normalizeRows(raw, headers)
}

/** Parse by declared format. */
export function parseDataset(text: string, format: 'csv' | 'json'): ParsedDataset {
  return format === 'csv' ? parseCsvDataset(text) : parseJsonDataset(text)
}
