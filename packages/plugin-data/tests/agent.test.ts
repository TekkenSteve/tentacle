import { describe, expect, it } from 'vitest'
import { buildAgentPrompt, parseAgentReply, replyToSpec } from '../src/agent.js'
import type { DatasetRows } from '../src/types.js'

const rows: DatasetRows = {
  columns: [
    { name: 'month', type: 'string' },
    { name: 'revenue', type: 'number' },
  ],
  rows: [
    { month: 'Jan', revenue: 120 },
    { month: 'Feb', revenue: 180 },
  ],
}

describe('Data Agent prompt', () => {
  it('includes schema, rows and the question', () => {
    const prompt = buildAgentPrompt('which month is best?', { datasetName: 'Sales', rows, existingCharts: ['old chart'] })
    expect(prompt.system).toContain('single JSON object')
    expect(prompt.user).toContain('Sales')
    expect(prompt.user).toContain('month (string)')
    expect(prompt.user).toContain('which month is best?')
    expect(prompt.user).toContain('old chart')
  })
})

describe('Data Agent reply parsing', () => {
  it('parses a chart instruction from code fences', () => {
    const reply = parseAgentReply('```json\n{"kind":"chart","title":"Revenue","chart":"bar","x":"month","y":"revenue","aggregate":"sum","explanation":"sum"}\n```', rows)
    expect(reply).toMatchObject({ kind: 'chart', chart: 'bar', x: 'month', y: 'revenue' })
    if (reply.kind === 'chart') expect(replyToSpec(reply)).toMatchObject({ chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum' })
  })

  it('drops y for count and validates columns', () => {
    const count = parseAgentReply('{"kind":"chart","chart":"bar","x":"month","aggregate":"count"}', rows)
    expect(count.kind).toBe('chart')
    if (count.kind === 'chart') expect(count.y).toBeUndefined()
    expect(() => parseAgentReply('{"kind":"chart","chart":"bar","x":"nope","y":"revenue","aggregate":"sum"}', rows)).toThrowError(/unknown x/)
  })

  it('parses a transform instruction and validates it', () => {
    const reply = parseAgentReply('{"kind":"transform","title":"Monthly","operation":{"kind":"group","groupBy":["month"],"aggregates":[{"column":"revenue","fn":"sum"}]}}', rows)
    expect(reply).toMatchObject({ kind: 'transform', title: 'Monthly' })
    if (reply.kind === 'transform') expect(reply.operation.kind).toBe('group')
    expect(() => parseAgentReply('{"kind":"transform","title":"bad","operation":{"kind":"group","groupBy":["nope"],"aggregates":[]}}', rows)).toThrowError()
  })

  it('parses a join instruction against data memory', () => {
    const reply = parseAgentReply(
      '{"kind":"join","title":"Sales by region","rightDatasetId":"ds-regions","leftColumn":"month","rightColumn":"month","how":"left"}',
      rows,
      {
        currentDatasetId: 'ds-sales',
        datasets: [
          { id: 'ds-sales', name: 'Sales', columns: ['month', 'revenue'] },
          { id: 'ds-regions', name: 'Regions', columns: ['month', 'region'] },
        ],
      },
    )
    expect(reply).toMatchObject({ kind: 'join', rightDatasetId: 'ds-regions', how: 'left' })
    expect(() => parseAgentReply('{"kind":"join","rightDatasetId":"missing","leftColumn":"month","rightColumn":"month"}', rows)).toThrowError(/unknown right/)
  })

  it('parses plain answers and rejects garbage', () => {
    expect(parseAgentReply('{"kind":"answer","answer":"no time column"}', rows)).toEqual({ kind: 'answer', answer: 'no time column' })
    expect(() => parseAgentReply('not json', rows)).toThrowError()
  })
})
