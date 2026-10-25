/**
 * Data operations for Data Studio (design 11, derived datasets).
 *
 * The MVP deliberately supports two grounded, explainable operations:
 *  - group: group by one or more columns and aggregate one measure;
 *  - filter: keep rows matching one comparison.
 * Both are pure; the service persists their result as a new dataset so charts
 * and the AI agent can continue from it without hidden state.
 */
import { inferType } from './parser.js'
import type {
  DataColumn,
  DataOperation,
  DatasetRows,
  FilterOperator,
  Scalar,
} from './types.js'

export type { AggregateFunction, DataOperation, FilterOperator, GroupAggregate, GroupOperation, FilterOperation } from './types.js'

export interface OperationProblem {
  readonly message: string
}

/** Validate one operation against the source schema (columns only; rows not needed). */
export function validateOperation(operation: unknown, columns: readonly DataColumn[]): OperationProblem | undefined {
  if (typeof operation !== 'object' || operation === null) return { message: 'operation must be an object' }
  const op = operation as Record<string, unknown>
  const names = new Set(columns.map((column) => column.name))
  if (op['kind'] === 'filter') {
    const column = op['column']
    if (typeof column !== 'string' || !names.has(column)) return { message: `unknown filter column: ${String(column)}` }
    const operator = op['op']
    if (operator !== 'eq' && operator !== 'neq' && operator !== 'gt' && operator !== 'gte' && operator !== 'lt' && operator !== 'lte' && operator !== 'contains') {
      return { message: `unsupported filter operator: ${String(operator)}` }
    }
    if (!['string', 'number', 'boolean'].includes(typeof op['value'])) return { message: 'filter value must be a string, number or boolean' }
    return undefined
  }
  if (op['kind'] === 'group') {
    const groupBy = op['groupBy']
    if (!Array.isArray(groupBy) || groupBy.length === 0 || !groupBy.every((name) => typeof name === 'string' && names.has(name))) {
      return { message: 'groupBy must be non-empty column names' }
    }
    const aggregates = op['aggregates']
    if (!Array.isArray(aggregates) || aggregates.length === 0) return { message: 'aggregates must not be empty' }
    const outputNames = new Set<string>()
    for (const aggregate of aggregates) {
      if (typeof aggregate !== 'object' || aggregate === null) return { message: 'aggregate must be an object' }
      const entry = aggregate as Record<string, unknown>
      const column = entry['column']
      if (typeof column !== 'string' || !names.has(column)) {
        return { message: `unknown aggregate column: ${String(column)}` }
      }
      const fn = entry['fn']
      if (fn !== 'sum' && fn !== 'avg' && fn !== 'count' && fn !== 'min' && fn !== 'max') {
        return { message: `unsupported aggregate function: ${String(fn)}` }
      }
      const outputName = typeof entry['as'] === 'string' && entry['as'].trim() !== ''
        ? entry['as'].trim()
        : `${fn}_${column}`
      if (outputNames.has(outputName)) return { message: `duplicate aggregate output: ${outputName}` }
      outputNames.add(outputName)
    }
    return undefined
  }
  return { message: 'operation kind must be group or filter' }
}

function numeric(value: Scalar | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function matches(value: Scalar | undefined, op: FilterOperator, wanted: string | number | boolean): boolean {
  if (op === 'contains') return String(value ?? '').toLowerCase().includes(String(wanted).toLowerCase())
  if (op === 'eq') return String(value) === String(wanted)
  if (op === 'neq') return String(value) !== String(wanted)
  const left = numeric(value)
  const right = typeof wanted === 'number' ? wanted : Number(wanted)
  if (left === undefined || !Number.isFinite(right)) return false
  if (op === 'gt') return left > right
  if (op === 'gte') return left >= right
  if (op === 'lt') return left < right
  return left <= right
}

/** Apply one operation and return a new normalized dataset. */
export function applyOperation(rows: DatasetRows, operation: DataOperation): DatasetRows {
  if (operation.kind === 'filter') {
    const filtered = rows.rows.filter((row) => matches(row[operation.column], operation.op, operation.value))
    return {
      columns: rows.columns,
      rows: filtered.map((row) => ({ ...row })),
    }
  }

  const groups = new Map<string, { key: Scalar[]; rows: Record<string, Scalar>[] }>()
  for (const row of rows.rows) {
    const key = operation.groupBy.map((column) => row[column] ?? null)
    const encoded = JSON.stringify(key)
    const bucket = groups.get(encoded) ?? { key, rows: [] }
    bucket.rows.push({ ...row })
    groups.set(encoded, bucket)
  }

  const outputColumns: DataColumn[] = [
    ...operation.groupBy.map((name) => {
      const source = rows.columns.find((column) => column.name === name)
      return { name, type: source?.type ?? 'string' }
    }),
    ...operation.aggregates.map((aggregate) => ({
      name: aggregate.as ?? `${aggregate.fn}_${aggregate.column}`,
      type: aggregate.fn === 'count' ? 'number' as const : (rows.columns.find((column) => column.name === aggregate.column)?.type ?? 'number'),
    })),
  ]

  const output: Record<string, Scalar>[] = []
  for (const { key, rows: bucket } of groups.values()) {
    const record: Record<string, Scalar> = {}
    operation.groupBy.forEach((column, index) => { record[column] = key[index] ?? null })
    for (const aggregate of operation.aggregates) {
      const name = aggregate.as ?? `${aggregate.fn}_${aggregate.column}`
      const values = bucket.map((row) => row[aggregate.column])
      const numbers = values.map((value) => numeric(value)).filter((value): value is number => value !== undefined)
      if (aggregate.fn === 'count') record[name] = values.filter((value) => value !== null && value !== undefined && String(value) !== '').length
      else if (aggregate.fn === 'sum') record[name] = numbers.reduce((sum, value) => sum + value, 0)
      else if (aggregate.fn === 'avg') record[name] = numbers.length === 0 ? null : numbers.reduce((sum, value) => sum + value, 0) / numbers.length
      else if (aggregate.fn === 'min') record[name] = numbers.length === 0 ? null : Math.min(...numbers)
      else record[name] = numbers.length === 0 ? null : Math.max(...numbers)
    }
    output.push(record)
  }
  // Re-infer result types from the produced values so charts see the truth.
  const columns = outputColumns.map((column) => ({ name: column.name, type: inferType(output.map((row) => row[column.name]!)) }))
  return { columns, rows: output }
}

/** Human-readable one-line description used on derived dataset cards. */
export function describeOperation(operation: DataOperation): string {
  if (operation.kind === 'filter') return `filter ${operation.column} ${operation.op} ${String(operation.value)}`
  return `group by ${operation.groupBy.join(', ')} → ${operation.aggregates.map((aggregate) => `${aggregate.fn}(${aggregate.column})`).join(', ')}`
}
