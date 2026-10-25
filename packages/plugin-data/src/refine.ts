/**
 * Chart refinement protocol — a small, native analogue of Data Formulator's
 * chart-restyle agent. The model sees the current ChartSpec plus a data sample
 * and returns a patch limited to supported visual fields; the host validates
 * the merged spec with the same rules as manual edits.
 */
import type { ChartSpec, DatasetRows } from './types.js'

export interface RefineResult {
  readonly kind: 'spec'
  readonly spec: ChartSpec
  readonly rationale?: string
}

export interface RefineOutOfScope {
  readonly kind: 'out_of_scope'
  readonly rationale?: string
}

const SYSTEM = [
  'You refine an existing chart in a small data workspace. Reply with one JSON object and nothing else.',
  'Shape: {"kind":"spec","spec":{...partial chart fields...},"rationale":"one sentence"}',
  'Allowed chart fields: chart (bar|line|scatter|pie), x, y, color, size, facet, aggregate (sum|avg|count|none), theme (default|warm|cool|mono), title, annotations ({max?,mean?,labels?}).',
  'Only include fields you want to change; column names must exist in the dataset. Keep the chart readable.',
  'If the instruction is not about the chart (for example a data question), reply: {"kind":"out_of_scope","rationale":"why"}.',
  'Do not invent data, do not emit markdown, and do not output code fences.',
].join('\n')

/** Build the system + user prompt for one refinement. */
export function buildRefinePrompt(instruction: string, spec: ChartSpec, rows: DatasetRows): { system: string; user: string } {
  const columns = rows.columns.map((column) => `${column.name} (${column.type})`).join(', ')
  return {
    system: SYSTEM,
    user: [
      `Current chart spec: ${JSON.stringify(spec)}`,
      `Columns: ${columns}`,
      `Sample rows: ${JSON.stringify(rows.rows.slice(0, 12))}`,
      `Instruction: ${instruction}`,
    ].join('\n'),
  }
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object in reply')
  return JSON.parse(trimmed.slice(start, end + 1))
}

/** Parse the model reply and merge allowed fields onto the current spec. */
export function parseRefineReply(text: string, current: ChartSpec): RefineResult | RefineOutOfScope {
  const raw = parseJsonObject(text)
  if (typeof raw !== 'object' || raw === null) throw new Error('reply is not an object')
  const reply = raw as Record<string, unknown>
  if (reply['kind'] === 'out_of_scope') {
    const rationale = typeof reply['rationale'] === 'string' ? reply['rationale'].trim() : undefined
    return { kind: 'out_of_scope', ...(rationale === undefined || rationale === '' ? {} : { rationale }) }
  }
  if (reply['kind'] !== 'spec') throw new Error('unknown reply kind')
  const patch = reply['spec']
  if (typeof patch !== 'object' || patch === null) throw new Error('spec patch is missing')
  const next: Record<string, unknown> = { ...current }
  for (const key of ['chart', 'x', 'y', 'color', 'size', 'facet', 'aggregate', 'theme', 'title', 'annotations']) {
    if (key in (patch as Record<string, unknown>)) next[key] = (patch as Record<string, unknown>)[key]
  }
  const rationale = typeof reply['rationale'] === 'string' ? reply['rationale'].trim() : undefined
  return {
    kind: 'spec',
    spec: next as unknown as ChartSpec,
    ...(rationale === undefined || rationale === '' ? {} : { rationale }),
  }
}
