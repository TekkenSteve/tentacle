import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as dataPlugin from '../src/index.js'
import { buildRefinePrompt, parseRefineReply } from '../src/refine.js'
import type { TentacleData } from '../src/service.js'
import type { ChartSpec, DatasetRows } from '../src/types.js'

const rows: DatasetRows = {
  columns: [{ name: 'month', type: 'string' }, { name: 'revenue', type: 'number' }],
  rows: [{ month: 'Jan', revenue: 10 }, { month: 'Feb', revenue: 20 }],
}
const spec: ChartSpec = { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum' }

async function boot(reply: string): Promise<TentacleData> {
  const app = new Context()
  const fiber = app.plugin(dataPlugin, {
    stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-data-')),
    agentRuntime: {
      selection: () => ({ provider: 'fake', model: 'fake-model' }),
      stream: async function* () { yield { type: 'text-delta', text: reply } },
    },
  })
  await fiber
  const service = app.tentacleData as TentacleData
  await service.ready
  return service
}

describe('chart refinement', () => {
  it('builds a schema-aware prompt', () => {
    const prompt = buildRefinePrompt('make it a line chart', spec, rows)
    expect(prompt.user).toContain('make it a line chart')
    expect(prompt.user).toContain('month (string)')
    expect(prompt.user).toContain('"chart":"bar"')
  })

  it('merges only allowed fields', () => {
    const result = parseRefineReply('{"kind":"spec","spec":{"chart":"line","theme":"warm","bogus":1},"rationale":"line"}', spec)
    expect(result.kind).toBe('spec')
    if (result.kind === 'spec') {
      expect(result.spec).toMatchObject({ chart: 'line', theme: 'warm', x: 'month', y: 'revenue' })
      expect('bogus' in result.spec).toBe(false)
    }
  })

  it('refines a persisted chart card', async () => {
    const service = await boot('{"kind":"spec","spec":{"chart":"line","annotations":{"mean":true}},"rationale":"line with mean"}')
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: 'month,revenue\nJan,10\nFeb,20\n' })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: dataset.id })
    const card = await service.createCard({ threadId: thread.id, kind: 'chart', title: 'Revenue', datasetId: dataset.id, spec })
    const result = await service.refineChart({ cardId: card.id, instruction: 'make it a line chart with a mean line' })
    expect(result.kind).toBe('spec')
    expect(result.rationale).toBe('line with mean')
    const updated = service.stateSnapshot().cards.find((row) => row.id === card.id)
    expect(updated?.kind).toBe('chart')
    if (updated?.kind === 'chart') {
      expect(updated.spec).toMatchObject({ chart: 'line', annotations: { mean: true } })
      expect(updated.variants?.map((variant) => variant.label)).toEqual(['原始', 'make it a line chart with a '])
      expect(updated.variants?.[0]?.spec.chart).toBe('bar')
      expect(updated.variants?.[1]?.rationale).toBe('line with mean')
    }
  })

  it('does not mutate on out-of-scope replies', async () => {
    const service = await boot('{"kind":"out_of_scope","rationale":"not a chart edit"}')
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: 'month,revenue\nJan,10\nFeb,20\n' })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: dataset.id })
    const card = await service.createCard({ threadId: thread.id, kind: 'chart', title: 'Revenue', datasetId: dataset.id, spec })
    const result = await service.refineChart({ cardId: card.id, instruction: 'what is the average?' })
    expect(result).toMatchObject({ kind: 'out_of_scope', rationale: 'not a chart edit' })
    expect(service.stateSnapshot().cards.find((row) => row.id === card.id)).toMatchObject({ kind: 'chart', spec })
  })
})
