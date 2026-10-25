/**
 * Data Agent prompt/response protocol.
 *
 * The agent is a one-shot model call over the dataset schema and a small row
 * sample; it returns one strict JSON object that becomes a chart card (plus an
 * optional explanation note). Keeping this pure makes the prompt and parser
 * testable without an LLM provider.
 */
import { describeOperation, validateOperation } from './operations.js'
import type { ChartAggregate, ChartKind, ChartSpec, DataOperation, DatasetRows } from './types.js'

export interface AgentDatasetRef {
  readonly id: string
  readonly name: string
  readonly columns: readonly string[]
}

export interface AgentRelationRef {
  readonly leftDatasetId: string
  readonly leftColumn: string
  readonly rightDatasetId: string
  readonly rightColumn: string
}

export interface AgentSchemaInput {
  readonly datasetName: string
  readonly rows: DatasetRows
  readonly existingCharts: readonly string[]
  /** Derived-dataset steps already applied in this question; empty on step 1. */
  readonly priorSteps?: readonly string[]
  /** Data memory: other datasets and known key relationships in this workspace. */
  readonly otherDatasets?: readonly AgentDatasetRef[]
  readonly relations?: readonly AgentRelationRef[]
}

export interface AgentChartReply {
  readonly kind: 'chart'
  readonly title: string
  readonly chart: ChartKind
  readonly x: string
  readonly y?: string
  readonly aggregate: ChartAggregate
  readonly explanation?: string
}

export interface AgentTransformReply {
  readonly kind: 'transform'
  readonly title: string
  readonly operation: DataOperation
  readonly explanation?: string
}

export interface AgentJoinReply {
  readonly kind: 'join'
  readonly title: string
  readonly rightDatasetId: string
  readonly leftColumn: string
  readonly rightColumn: string
  readonly how: 'inner' | 'left'
  readonly explanation?: string
}

export interface AgentAnswerReply {
  readonly kind: 'answer'
  readonly answer: string
}

export type AgentReply = AgentChartReply | AgentTransformReply | AgentJoinReply | AgentAnswerReply

const SYSTEM = [
  'You are a careful data analyst inside a small charting workspace.',
  'Given a dataset schema, a sample of rows, the existing charts and one natural-language question,',
  'answer the question with ONE action. Reply with a single JSON object and nothing else.',
  'Shape for a chart:',
  '{"kind":"chart","title":"short chart title","chart":"bar|line|scatter|pie","x":"column","y":"column or omitted for count","aggregate":"sum|avg|count|none","explanation":"one sentence"}',
  'Shape for a derived dataset (use when the next step needs filtered or pre-aggregated rows):',
  '{"kind":"transform","title":"short dataset title","operation":{"kind":"group","groupBy":["column"],"aggregates":[{"column":"measure","fn":"sum|avg|count|min|max"}]},"explanation":"one sentence"}',
  'or {"kind":"transform","title":"short dataset title","operation":{"kind":"filter","column":"column","op":"eq|neq|gt|gte|lt|lte|contains","value":"literal"},"explanation":"one sentence"}',
  'Shape for joining another dataset (use a known relationship or matching key columns):',
  '{"kind":"join","title":"short dataset title","rightDatasetId":"dataset id","leftColumn":"current column","rightColumn":"other column","how":"inner|left","explanation":"one sentence"}',
  'Shape when the question cannot be answered from the schema:',
  '{"kind":"answer","answer":"brief explanation of what is missing"}',
  'Rules: all column names must be exact; use numeric y for sum/avg;',
  'use aggregate "count" (and omit y) for frequency questions; prefer bar for categories, line for time, scatter for two measures, pie only for parts of a whole.',
  'Prefer a chart when one chart answers the question; use transform only when rows must be filtered or grouped first.',
  'When prior steps are listed, the dataset shown is the result of those steps: do not repeat a transformation; answer with a chart, join or answer.',
  'Prefer known relationships for joins; only join when the question needs columns from another dataset.',
  'You may emit at most one action per reply; the caller will continue with another step after a transform.',
  'Do not invent values, do not emit markdown, and do not output code fences.',
].join('\n')

/** Build the system + user prompt for one question. */
export function buildAgentPrompt(question: string, input: AgentSchemaInput): { system: string; user: string } {
  const columns = input.rows.columns.map((column) => `${column.name} (${column.type})`).join(', ')
  const sample = input.rows.rows.slice(0, 12)
  return {
    system: SYSTEM,
    user: [
      `Dataset: ${input.datasetName}`,
      `Columns: ${columns}`,
      `Row count: ${input.rows.rows.length}`,
      `Sample rows (JSON): ${JSON.stringify(sample)}`,
      ...(input.priorSteps === undefined || input.priorSteps.length === 0 ? [] : [`Prior steps already applied: ${input.priorSteps.join(' → ')}`]),
      ...(input.otherDatasets === undefined || input.otherDatasets.length === 0 ? [] : [
        `Other datasets in this workspace: ${input.otherDatasets.map((dataset) => `${dataset.id} = ${dataset.name} [${dataset.columns.join(', ')}]`).join(' | ')}`,
      ]),
      ...(input.relations === undefined || input.relations.length === 0 ? [] : [
        `Known relationships (leftId.leftColumn = rightId.rightColumn): ${input.relations.map((relation) => `${relation.leftDatasetId}.${relation.leftColumn} = ${relation.rightDatasetId}.${relation.rightColumn}`).join(' | ')}`,
      ]),
      `Existing chart titles: ${input.existingCharts.length === 0 ? '(none)' : input.existingCharts.join(' | ')}`,
      `Question: ${question}`,
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

function chartKind(value: unknown): ChartKind {
  return value === 'line' || value === 'scatter' || value === 'pie' ? value : 'bar'
}

function aggregate(value: unknown): ChartAggregate {
  return value === 'avg' || value === 'count' || value === 'none' ? value : 'sum'
}

/** Parse and validate the model reply against the dataset columns. */
export interface AgentReplyContext {
  readonly currentDatasetId?: string
  readonly datasets?: readonly AgentDatasetRef[]
  readonly relations?: readonly AgentRelationRef[]
}

export function parseAgentReply(text: string, rows: DatasetRows, context: AgentReplyContext = {}): AgentReply {
  const raw = parseJsonObject(text)
  if (typeof raw !== 'object' || raw === null) throw new Error('reply is not an object')
  const reply = raw as Record<string, unknown>
  if (reply['kind'] === 'answer') {
    const answer = typeof reply['answer'] === 'string' ? reply['answer'].trim() : ''
    if (answer === '') throw new Error('answer is empty')
    return { kind: 'answer', answer: answer.slice(0, 4000) }
  }
  if (reply['kind'] === 'join') {
    const rightDatasetId = typeof reply['rightDatasetId'] === 'string' ? reply['rightDatasetId'].trim() : ''
    const right = context.datasets?.find((dataset) => dataset.id === rightDatasetId)
    if (right === undefined) throw new Error(`unknown right dataset: ${rightDatasetId}`)
    if (context.currentDatasetId !== undefined && context.currentDatasetId === rightDatasetId) throw new Error('cannot join a dataset to itself')
    const leftColumn = typeof reply['leftColumn'] === 'string' ? reply['leftColumn'].trim() : ''
    const rightColumn = typeof reply['rightColumn'] === 'string' ? reply['rightColumn'].trim() : ''
    if (!rows.columns.some((column) => column.name === leftColumn)) throw new Error(`unknown left column: ${leftColumn}`)
    if (!right.columns.includes(rightColumn)) throw new Error(`unknown right column: ${rightColumn}`)
    const how = reply['how'] === 'inner' ? 'inner' : 'left'
    const title = typeof reply['title'] === 'string' && reply['title'].trim() !== ''
      ? reply['title'].trim().slice(0, 120)
      : `join ${right.name}`
    const explanation = typeof reply['explanation'] === 'string' && reply['explanation'].trim() !== ''
      ? reply['explanation'].trim().slice(0, 1000)
      : undefined
    return {
      kind: 'join',
      title,
      rightDatasetId,
      leftColumn,
      rightColumn,
      how,
      ...(explanation === undefined ? {} : { explanation }),
    }
  }
  if (reply['kind'] === 'transform') {
    const operation = reply['operation']
    const problem = validateOperation(operation, rows.columns)
    if (problem !== undefined) throw new Error(problem.message)
    const title = typeof reply['title'] === 'string' && reply['title'].trim() !== ''
      ? reply['title'].trim().slice(0, 120)
      : describeOperation(operation as DataOperation).slice(0, 120)
    const explanation = typeof reply['explanation'] === 'string' && reply['explanation'].trim() !== ''
      ? reply['explanation'].trim().slice(0, 1000)
      : undefined
    return {
      kind: 'transform',
      title,
      operation: operation as DataOperation,
      ...(explanation === undefined ? {} : { explanation }),
    }
  }
  if (reply['kind'] !== 'chart') throw new Error('unknown reply kind')
  const columns = new Set(rows.columns.map((column) => column.name))
  const x = typeof reply['x'] === 'string' ? reply['x'].trim() : ''
  if (!columns.has(x)) throw new Error(`unknown x column: ${x}`)
  const chart = chartKind(reply['chart'])
  const agg = aggregate(reply['aggregate'])
  const yValue = typeof reply['y'] === 'string' ? reply['y'].trim() : ''
  if (agg !== 'count' && !columns.has(yValue)) throw new Error(`unknown y column: ${yValue}`)
  const title = typeof reply['title'] === 'string' && reply['title'].trim() !== ''
    ? reply['title'].trim().slice(0, 120)
    : `${x}${yValue === '' ? '' : ` · ${yValue}`}`
  const explanation = typeof reply['explanation'] === 'string' && reply['explanation'].trim() !== ''
    ? reply['explanation'].trim().slice(0, 1000)
    : undefined
  return {
    kind: 'chart',
    title,
    chart,
    x,
    ...(agg === 'count' || yValue === '' ? {} : { y: yValue }),
    aggregate: agg,
    ...(explanation === undefined ? {} : { explanation }),
  }
}

/** Turn a parsed chart reply into a persisted chart spec. */
export function replyToSpec(reply: AgentChartReply): ChartSpec {
  return {
    chart: reply.chart,
    x: reply.x,
    ...(reply.y === undefined ? {} : { y: reply.y }),
    aggregate: reply.aggregate,
    title: reply.title,
  }
}
