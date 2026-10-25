/**
 * Data-memory discovery: propose relationships between same-named columns
 * whose sampled values overlap strongly. Deliberately conservative — exact
 * normalized names, compatible types, and a high overlap threshold — so the
 * suggestion list stays trustworthy instead of noisy.
 */
import type { DataColumn, DataRelation, DatasetRows } from './types.js'

export interface RelationSuggestion {
  readonly leftDatasetId: string
  readonly leftDatasetName: string
  readonly leftColumn: string
  readonly rightDatasetId: string
  readonly rightDatasetName: string
  readonly rightColumn: string
  /** Overlap / min(distinct sizes), in [0,1]. */
  readonly score: number
  readonly leftDistinct: number
  readonly rightDistinct: number
}

export interface RelationSuggestionInput {
  readonly datasetId: string
  readonly datasetName: string
  readonly rows: DatasetRows
}

const MAX_SAMPLE_ROWS = 500
const MIN_OVERLAP = 0.6
const MAX_SUGGESTIONS = 10

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function typesCompatible(left: DataColumn, right: DataColumn): boolean {
  if (left.type === 'unknown' || right.type === 'unknown') return true
  return left.type === right.type
}

function distinctValues(rows: DatasetRows, column: string): Set<string> {
  const values = new Set<string>()
  for (const row of rows.rows.slice(0, MAX_SAMPLE_ROWS)) {
    const value = row[column]
    if (value === null || value === undefined || String(value) === '') continue
    values.add(String(value))
  }
  return values
}

/** Propose relationships from sampled value overlap. */
export function suggestRelations(
  datasets: readonly RelationSuggestionInput[],
  existing: readonly DataRelation[],
): readonly RelationSuggestion[] {
  const suggestions: RelationSuggestion[] = []
  for (let leftIndex = 0; leftIndex < datasets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < datasets.length; rightIndex += 1) {
      const left = datasets[leftIndex]!
      const right = datasets[rightIndex]!
      for (const leftColumn of left.rows.columns) {
        for (const rightColumn of right.rows.columns) {
          if (normalizeName(leftColumn.name) !== normalizeName(rightColumn.name)) continue
          if (!typesCompatible(leftColumn, rightColumn)) continue
          const duplicate = existing.some((relation) => (
            (relation.leftDatasetId === left.datasetId && relation.leftColumn === leftColumn.name
              && relation.rightDatasetId === right.datasetId && relation.rightColumn === rightColumn.name)
            || (relation.leftDatasetId === right.datasetId && relation.leftColumn === rightColumn.name
              && relation.rightDatasetId === left.datasetId && relation.rightColumn === leftColumn.name)
          ))
          if (duplicate) continue
          const leftValues = distinctValues(left.rows, leftColumn.name)
          const rightValues = distinctValues(right.rows, rightColumn.name)
          if (leftValues.size < 2 || rightValues.size < 2) continue
          let overlap = 0
          for (const value of leftValues) if (rightValues.has(value)) overlap += 1
          const score = overlap / Math.min(leftValues.size, rightValues.size)
          if (score < MIN_OVERLAP) continue
          suggestions.push({
            leftDatasetId: left.datasetId,
            leftDatasetName: left.datasetName,
            leftColumn: leftColumn.name,
            rightDatasetId: right.datasetId,
            rightDatasetName: right.datasetName,
            rightColumn: rightColumn.name,
            score,
            leftDistinct: leftValues.size,
            rightDistinct: rightValues.size,
          })
        }
      }
    }
  }
  return suggestions
    .sort((a, b) => b.score - a.score || a.leftDatasetName.localeCompare(b.leftDatasetName))
    .slice(0, MAX_SUGGESTIONS)
}
