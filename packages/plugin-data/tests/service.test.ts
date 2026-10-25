import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import * as dataPlugin from '../src/index.js'
import type { TentacleData } from '../src/service.js'

async function boot(config: Partial<dataPlugin.TentacleDataConfig> = {}): Promise<{ app: Context; fiber: Fiber; service: TentacleData }> {
  const app = new Context()
  const fiber = app.plugin(dataPlugin, {
    stateRoot: mkdtempSync(join(tmpdir(), 'tentacle-data-')),
    ...config,
  })
  await fiber
  const service = app.tentacleData
  await service.ready
  return { app, fiber, service }
}

const CSV = 'month,revenue,cost\nJan,120,80\nFeb,180,90\nMar,150,95\n'

function fakeSequence(...replies: string[]) {
  let index = 0
  return {
    selection: () => ({ provider: 'fake', model: 'fake-model' }),
    stream: async function* () {
      const text = replies[Math.min(index, replies.length - 1)]!
      index += 1
      yield { type: 'text-delta' as const, text }
    },
  }
}

const fakeAgent = fakeSequence(
  '{"kind":"chart","title":"Agent chart","chart":"bar","x":"month","y":"revenue","aggregate":"sum","explanation":"sum by month"}',
)

const fakeTransformAgent = fakeSequence(
  '{"kind":"transform","title":"Revenue by month","operation":{"kind":"group","groupBy":["month"],"aggregates":[{"column":"revenue","fn":"sum"}]},"explanation":"aggregated"}',
  '{"kind":"chart","title":"Monthly revenue","chart":"line","x":"month","y":"sum_revenue","aggregate":"none"}',
)

const fakeStuckTransformAgent = fakeSequence(
  '{"kind":"transform","title":"Revenue by month","operation":{"kind":"group","groupBy":["month"],"aggregates":[{"column":"revenue","fn":"sum"}]}}',
  '{"kind":"transform","title":"Revenue by month","operation":{"kind":"filter","column":"sum_revenue","op":"gte","value":0}}',
  '{"kind":"transform","title":"Revenue by month","operation":{"kind":"filter","column":"sum_revenue","op":"gte","value":0}}',
)

describe('Data Studio service', () => {
  it('boots with one default workspace', async () => {
    const { service } = await boot()
    expect(service.stateSnapshot().workspaces).toHaveLength(1)
    expect(service.stateSnapshot().workspaces[0]!.name).toBe('默认数据空间')
  })

  it('imports a dataset and exposes rows', async () => {
    const { service } = await boot()
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    expect(dataset.rowCount).toBe(3)
    expect(dataset.columns.map((column) => column.name)).toEqual(['month', 'revenue', 'cost'])
    const rows = await service.datasetRows(dataset.id)
    expect(rows.rows[1]).toMatchObject({ month: 'Feb', revenue: 180 })
  })

  it('creates threads with dataset anchors, forks them and removes cards', async () => {
    const { service } = await boot()
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: dataset.id })
    expect(service.stateSnapshot().cards.filter((card) => card.threadId === thread.id)).toHaveLength(1)

    const chart = await service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'Revenue by month',
      datasetId: dataset.id,
      spec: { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum' },
    })
    const forked = await service.forkThread(thread.id)
    expect(forked.parentThreadId).toBe(thread.id)
    const forkedCards = service.stateSnapshot().cards.filter((card) => card.threadId === forked.id)
    expect(forkedCards).toHaveLength(2)
    expect(forkedCards.map((card) => card.id)).not.toContain(chart.id)

    await service.removeCard(chart.id)
    expect(service.stateSnapshot().cards.some((card) => card.id === chart.id)).toBe(false)
    await service.removeThread(forked.id)
    expect(service.stateSnapshot().threads.some((row) => row.id === forked.id)).toBe(false)
  })

  it('stores thread-level numeric ranges and validates them', async () => {
    const { service } = await boot({})
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: dataset.id })
    const next = await service.setThreadFilters(thread.id, [], [{ column: 'revenue', min: 100, max: 200 }])
    expect(next.ranges).toEqual([{ column: 'revenue', min: 100, max: 200 }])
    await expect(service.setThreadFilters(thread.id, [], [{ column: 'month', min: 1 }])).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.setThreadFilters(thread.id, [], [{ column: 'revenue', min: 200, max: 100 }])).rejects.toMatchObject({ code: 'invalid-chart' })
  })

  it('asks the data agent for a chart and saves it as a card', async () => {
    const { service } = await boot({ agentRuntime: fakeAgent })
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: dataset.id })
    const events: { type: string; step?: string }[] = []
    const result = await service.askAgent({ threadId: thread.id, prompt: 'Which month is best?' }, (event) => events.push(event))
    expect(result.reply).toMatchObject({ kind: 'chart', title: 'Agent chart' })
    expect(events.some((event) => event.type === 'step' && event.step === '✓ 生成图表：Agent chart')).toBe(true)
    expect(events.at(-1)?.type).toBe('done')
    const cards = service.stateSnapshot().cards.filter((card) => card.threadId === thread.id)
    expect(cards.some((card) => card.kind === 'chart' && card.title === 'Agent chart')).toBe(true)
    expect(cards.some((card) => card.kind === 'note' && card.text === 'sum by month')).toBe(true)
    const plan = cards.find((card) => card.kind === 'plan')
    expect(plan?.kind).toBe('plan')
    if (plan?.kind === 'plan') {
      expect(plan.steps).toContain('✓ 生成图表：Agent chart')
      expect(plan.status).toBe('done')
    }
  })

  it('asks the data agent for a derived dataset and adds it as a card', async () => {
    const { service } = await boot({ agentRuntime: fakeTransformAgent })
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: dataset.id })
    const result = await service.askAgent({ threadId: thread.id, prompt: 'Aggregate revenue by month' })
    expect(result.reply).toMatchObject({ kind: 'chart', title: 'Monthly revenue' })
    const snapshot = service.stateSnapshot()
    const derived = snapshot.datasets.find((row) => row.name === 'Revenue by month')
    expect(derived?.sourceDatasetId).toBe(dataset.id)
    expect(derived?.operation).toMatchObject({ kind: 'group' })
    expect(snapshot.cards.some((card) => card.kind === 'dataset' && card.datasetId === derived?.id)).toBe(true)
    expect(snapshot.cards.some((card) => card.kind === 'chart' && card.title === 'Monthly revenue' && card.datasetId === derived?.id)).toBe(true)
  })

  it('stops after the step bound when the model keeps returning transforms', async () => {
    const { service } = await boot({ agentRuntime: fakeStuckTransformAgent })
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: dataset.id })
    const result = await service.askAgent({ threadId: thread.id, prompt: 'Aggregate again and again' })
    expect(result.reply.kind).toBe('transform')
    expect(service.stateSnapshot().datasets.filter((row) => row.name === 'Revenue by month')).toHaveLength(3)
  })

  it('stores shared thread filters and validates their columns', async () => {
    const { service } = await boot()
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: dataset.id })
    const updated = await service.setThreadFilters(thread.id, [{ column: 'month', values: ['Jan', 'Feb'] }])
    expect(updated.filters).toEqual([{ column: 'month', values: ['Jan', 'Feb'] }])
    expect((await service.setThreadFilters(thread.id, [])).filters).toBeUndefined()
    await expect(service.setThreadFilters(thread.id, [{ column: 'nope', values: ['x'] }])).rejects.toMatchObject({ code: 'invalid-chart' })
  })

  it('derives and filters datasets explicitly', async () => {
    const { service } = await boot()
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const grouped = await service.deriveDataset({
      datasetId: dataset.id,
      name: 'By month',
      operation: { kind: 'group', groupBy: ['month'], aggregates: [{ column: 'revenue', fn: 'sum' }] },
    })
    expect(grouped.rowCount).toBe(3)
    const filtered = await service.deriveDataset({
      datasetId: dataset.id,
      name: 'High revenue',
      operation: { kind: 'filter', column: 'revenue', op: 'gte', value: 150 },
    })
    expect(filtered.rowCount).toBe(2)
    await expect(service.removeDataset(dataset.id)).rejects.toMatchObject({ code: 'dataset-in-use' })
    await expect(service.deriveDataset({
      datasetId: dataset.id,
      name: 'Bad',
      operation: { kind: 'filter', column: 'nope', op: 'eq', value: 1 },
    })).rejects.toMatchObject({ code: 'invalid-dataset' })
  })

  it('creates, updates, deletes and cascades thread reports', async () => {
    const { service } = await boot()
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: dataset.id })
    const report = await service.createReport({
      workspaceId: workspace.id,
      threadId: thread.id,
      title: 'Revenue report',
      markdown: '# Revenue\n\n{{chart:card-1}}',
    })
    const updated = await service.updateReport({ id: report.id, title: 'Updated', markdown: '# Updated' })
    expect(updated.title).toBe('Updated')
    expect(service.stateSnapshot().reports).toHaveLength(1)
    await service.removeThread(thread.id)
    expect(service.stateSnapshot().reports).toHaveLength(0)
    await expect(service.removeReport(report.id)).rejects.toMatchObject({ code: 'no-such-report' })
  })

  it('suggests relationships then saves one', async () => {
    const { service } = await boot()
    const workspace = service.stateSnapshot().workspaces[0]!
    await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    await service.importDataset({ workspaceId: workspace.id, name: 'Regions', format: 'csv', content: 'month,region\nJan,north\nFeb,north\nMar,south\n' })
    const suggestions = await service.suggestRelations(workspace.id)
    expect(suggestions[0]).toMatchObject({ leftColumn: 'month', rightColumn: 'month' })
  })

  it('creates relationships and joins datasets on a key', async () => {
    const { service } = await boot()
    const workspace = service.stateSnapshot().workspaces[0]!
    const sales = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const regions = await service.importDataset({ workspaceId: workspace.id, name: 'Regions', format: 'csv', content: 'month,region\nJan,north\nFeb,north\nMar,south\n' })
    const relation = await service.createRelation({
      workspaceId: workspace.id,
      leftDatasetId: sales.id,
      leftColumn: 'month',
      rightDatasetId: regions.id,
      rightColumn: 'month',
    })
    expect(relation.id).toMatch(/^rel-/)
    const joined = await service.joinDatasets({
      leftDatasetId: sales.id,
      rightDatasetId: regions.id,
      leftColumn: 'month',
      rightColumn: 'month',
      how: 'left',
      name: 'Sales by region',
    })
    expect(joined.join).toMatchObject({ how: 'left' })
    expect(joined.rowCount).toBe(3)
    await expect(service.removeDataset(sales.id)).rejects.toMatchObject({ code: 'dataset-in-use' })
    await service.removeRelation(relation.id)
    await expect(service.joinDatasets({
      leftDatasetId: sales.id,
      rightDatasetId: regions.id,
      leftColumn: 'nope',
      rightColumn: 'month',
      how: 'inner',
      name: 'bad',
    })).rejects.toMatchObject({ code: 'invalid-relation' })
  })

  it('lets the agent join a related dataset and chart it in one question', async () => {
    let rightId = ''
    let calls = 0
    const runtime = {
      selection: () => ({ provider: 'fake', model: 'fake-model' }),
      stream: async function* () {
        calls += 1
        const text = calls === 1
          ? JSON.stringify({ kind: 'join', title: 'Sales by region', rightDatasetId: rightId, leftColumn: 'month', rightColumn: 'month', how: 'left' })
          : JSON.stringify({ kind: 'chart', title: 'Revenue by region', chart: 'bar', x: 'region', y: 'revenue', aggregate: 'sum' })
        yield { type: 'text-delta' as const, text }
      },
    }
    const { service } = await boot({ agentRuntime: runtime })
    const workspace = service.stateSnapshot().workspaces[0]!
    const sales = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const regions = await service.importDataset({ workspaceId: workspace.id, name: 'Regions', format: 'csv', content: 'month,region\nJan,north\nFeb,north\nMar,south\n' })
    rightId = regions.id
    await service.createRelation({ workspaceId: workspace.id, leftDatasetId: sales.id, leftColumn: 'month', rightDatasetId: regions.id, rightColumn: 'month' })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: sales.id })
    const result = await service.askAgent({ threadId: thread.id, prompt: 'Revenue by region' })
    expect(result.reply).toMatchObject({ kind: 'chart', title: 'Revenue by region' })
    const snapshot = service.stateSnapshot()
    const joined = snapshot.datasets.find((dataset) => dataset.name === 'Sales by region')
    expect(joined?.join).toMatchObject({ rightDatasetId: regions.id, how: 'left' })
    expect(snapshot.cards.some((card) => card.kind === 'dataset' && card.datasetId === joined?.id)).toBe(true)
    expect(snapshot.cards.some((card) => card.kind === 'chart' && card.title === 'Revenue by region' && card.datasetId === joined?.id)).toBe(true)
  })

  it('reports an unavailable agent without a model runtime', async () => {
    const { service } = await boot()
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: dataset.id })
    await expect(service.askAgent({ threadId: thread.id, prompt: 'x' })).rejects.toMatchObject({ code: 'agent-unavailable' })
  })

  it('rejects unknown chart columns and protects referenced datasets/workspaces', async () => {
    const { service } = await boot()
    const workspace = service.stateSnapshot().workspaces[0]!
    const dataset = await service.importDataset({ workspaceId: workspace.id, name: 'Sales', format: 'csv', content: CSV })
    const thread = await service.createThread({ workspaceId: workspace.id, name: 'Revenue', datasetId: dataset.id })

    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad',
      datasetId: dataset.id,
      spec: { chart: 'bar', x: 'nope', y: 'revenue', aggregate: 'sum' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })

    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad scatter',
      datasetId: dataset.id,
      spec: { chart: 'scatter', x: 'month', y: 'revenue', aggregate: 'none' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad sum',
      datasetId: dataset.id,
      spec: { chart: 'bar', x: 'month', y: 'month', aggregate: 'sum' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad color',
      datasetId: dataset.id,
      spec: { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum', color: 'nope' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad size',
      datasetId: dataset.id,
      spec: { chart: 'scatter', x: 'revenue', y: 'cost', aggregate: 'none', size: 'month' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    const tableCard = await service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'table card',
      datasetId: dataset.id,
      spec: { chart: 'table', x: 'month', aggregate: 'none' },
    })
    expect(tableCard.kind).toBe('chart')
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad choropleth',
      datasetId: dataset.id,
      spec: { chart: 'choropleth', x: 'month', y: 'month', aggregate: 'none' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad map',
      datasetId: dataset.id,
      spec: { chart: 'map', x: 'month', y: 'revenue', aggregate: 'none' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad rangeDot',
      datasetId: dataset.id,
      spec: { chart: 'rangeDot', x: 'month', y: 'month', aggregate: 'none' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad barTable',
      datasetId: dataset.id,
      spec: { chart: 'barTable', x: 'month', y: 'month', aggregate: 'sum' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad bullet',
      datasetId: dataset.id,
      spec: { chart: 'bullet', x: 'month', y: 'revenue', aggregate: 'sum' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad rangeArea',
      datasetId: dataset.id,
      spec: { chart: 'rangeArea', x: 'month', y: 'revenue', aggregate: 'none' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad kpi',
      datasetId: dataset.id,
      spec: { chart: 'kpi', x: 'month', y: 'revenue', aggregate: 'sum', goal: 'month' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad violin',
      datasetId: dataset.id,
      spec: { chart: 'violin', x: 'month', y: 'month', aggregate: 'none' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad histogram',
      datasetId: dataset.id,
      spec: { chart: 'histogram', x: 'month', aggregate: 'count' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad gantt',
      datasetId: dataset.id,
      spec: { chart: 'gantt', x: 'month', y: 'revenue', aggregate: 'none' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad candlestick',
      datasetId: dataset.id,
      spec: { chart: 'candlestick', x: 'month', aggregate: 'none', open: 'revenue' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad heatmap',
      datasetId: dataset.id,
      spec: { chart: 'heatmap', x: 'month', y: 'revenue', aggregate: 'sum' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad sort',
      datasetId: dataset.id,
      spec: { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum', sort: 'random' as never },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad range',
      datasetId: dataset.id,
      spec: { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum', range: { column: 'month' } },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad range order',
      datasetId: dataset.id,
      spec: { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum', range: { column: 'revenue', min: 10, max: 5 } },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad facet',
      datasetId: dataset.id,
      spec: { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum', facet: 'nope' },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad filter',
      datasetId: dataset.id,
      spec: { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum', filters: [{ column: 'nope', values: ['x'] }] },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.createCard({
      threadId: thread.id,
      kind: 'chart',
      title: 'bad theme',
      datasetId: dataset.id,
      spec: { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum', theme: 'neon' as never },
    })).rejects.toMatchObject({ code: 'invalid-chart' })
    await expect(service.removeDataset(dataset.id)).rejects.toMatchObject({ code: 'dataset-in-use' })
    await expect(service.removeWorkspace(workspace.id)).rejects.toMatchObject({ code: 'workspace-in-use' })
  })
})
