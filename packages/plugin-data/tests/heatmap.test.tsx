import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildHeatmap } from '../src/client/console/chart-model.js'
import { ChartView } from '../src/client/console/charts.tsx'
import type { ChartCard, ChartSpec, DatasetRows } from '../src/client/console/api.ts'

const rows: DatasetRows = {
  columns: [
    { name: 'month', type: 'string' },
    { name: 'region', type: 'string' },
    { name: 'revenue', type: 'number' },
  ],
  rows: [
    { month: 'Jan', region: 'north', revenue: 10 },
    { month: 'Jan', region: 'south', revenue: 20 },
    { month: 'Feb', region: 'north', revenue: 30 },
  ],
}

const spec: ChartSpec = { chart: 'heatmap', x: 'month', y: 'region', value: 'revenue', aggregate: 'sum' }

describe('heatmap', () => {
  it('builds a two-dimensional matrix', () => {
    const heatmap = buildHeatmap(rows, spec)
    expect(heatmap.xLabels).toEqual(['Jan', 'Feb'])
    expect(heatmap.yLabels).toEqual(['north', 'south'])
    expect(heatmap.cells).toEqual([
      { x: 'Jan', y: 'north', value: 10 },
      { x: 'Jan', y: 'south', value: 20 },
      { x: 'Feb', y: 'north', value: 30 },
    ])
    expect(heatmap.max).toBe(30)
  })

  it('renders a cell per matrix bucket', () => {
    const card: ChartCard = { id: 'h', threadId: 't', kind: 'chart', title: 'Heat', createdAt: 0, datasetId: 'd', spec }
    const html = renderToStaticMarkup(<ChartView card={card} rows={rows} />)
    expect((html.match(/<rect/g) ?? []).length).toBe(3)
    expect(html).toContain('Jan')
    expect(html).toContain('north')
  })
})
