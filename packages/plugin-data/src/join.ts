/**
 * Dataset joins for Data Studio's data memory.
 *
 * One explicit left/right key pair and `inner`/`left` mode; duplicate right
 * keys fan out like SQL. Right-side columns that collide with a left column
 * are aliased with a readable `_right` suffix so charts always address a
 * unique column name.
 */
import type { DataColumn, DatasetRows, JoinKind, JoinSpec, Scalar } from './types.js'

export interface JoinInput {
  readonly left: DatasetRows
  readonly right: DatasetRows
  readonly spec: JoinSpec
}

function aliasRightColumns(left: readonly DataColumn[], right: readonly DataColumn[]): ReadonlyMap<string, string> {
  const used = new Set(left.map((column) => column.name))
  const aliases = new Map<string, string>()
  for (const column of right) {
    let name = column.name
    if (used.has(name)) {
      name = `${column.name}_right`
      let suffix = 2
      while (used.has(name)) {
        name = `${column.name}_right${suffix}`
        suffix += 1
      }
    }
    used.add(name)
    aliases.set(column.name, name)
  }
  return aliases
}

function keyOf(value: Scalar | undefined): string | undefined {
  if (value === null || value === undefined || String(value) === '') return undefined
  return String(value)
}

/** Apply an inner or left join. */
export function applyJoin({ left, right, spec }: JoinInput): DatasetRows {
  const aliases = aliasRightColumns(left.columns, right.columns)
  const rightIndex = new Map<string, Readonly<Record<string, Scalar>>[]>()
  for (const row of right.rows) {
    const key = keyOf(row[spec.rightColumn])
    if (key === undefined) continue
    const bucket = rightIndex.get(key) ?? []
    bucket.push(row)
    rightIndex.set(key, bucket)
  }

  const outputColumns: DataColumn[] = [
    ...left.columns,
    ...right.columns.map((column) => ({ name: aliases.get(column.name)!, type: column.type })),
  ]
  const rows: Record<string, Scalar>[] = []
  for (const leftRow of left.rows) {
    const key = keyOf(leftRow[spec.leftColumn])
    const matches = key === undefined ? [] : (rightIndex.get(key) ?? [])
    if (matches.length === 0) {
      if (spec.how === 'inner') continue
      const row: Record<string, Scalar> = { ...leftRow }
      for (const column of right.columns) row[aliases.get(column.name)!] = null
      rows.push(row)
      continue
    }
    for (const rightRow of matches) {
      const row: Record<string, Scalar> = { ...leftRow }
      for (const column of right.columns) row[aliases.get(column.name)!] = rightRow[column.name] ?? null
      rows.push(row)
    }
  }
  return { columns: outputColumns, rows }
}

/** Human-readable join summary for cards/inspector. */
export function describeJoin(spec: JoinSpec, leftName: string, rightName: string): string {
  return `${spec.how} join ${leftName}.${spec.leftColumn} = ${rightName}.${spec.rightColumn}`
}

export const JOIN_KINDS: readonly JoinKind[] = ['inner', 'left']
