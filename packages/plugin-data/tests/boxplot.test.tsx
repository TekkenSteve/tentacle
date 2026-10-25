import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildBoxplot } from '../src/client/console/chart-model.js'
import { ChartView } from '../src/client/console/charts.tsx'
import type { ChartCard, ChartSpec, DatasetRows } from '../src/client/console/api.ts'

const rows: DatasetRows = {
  columns: [
    { name: 'team', type: 'string' },
    { name: 'score', type: 'number' },
  ],
  rows: [
    { team: 'A', score: 1 }, { team: 'A', score: 2 }, { team: 'A', score: 3 }, { team: 'A', score: 4 },
    { team: 'B', score: 10 }, { team: 'B', score: 20 },
  ],
}

const spec: ChartSpec = { chart: 'boxplot', x: 'team', y: 'score', aggregate: 'none' }

describe('boxplot', () => {
  it('computes quartiles per category', () => {
    expect(buildBoxplot(rows, spec)).toEqual([
      { label: 'A', min: 1, q1: 1.75, median: 2.5, q3: 3.25, max: 4 },
      { label: 'B', min: 10, q1: 12.5, median: 15, q3: 17.5, max: 20 },
    ])
  })

  it('renders a box per category', () => {
    const card: ChartCard = { id: 'b', threadId: 't', kind: 'chart', title: 'Scores', createdAt: 0, datasetId: 'd', spec }
    const html = renderToStaticMarkup(<ChartView card={card} rows={rows} />)
    expect((html.match(/rx="2"/g) ?? []).length).toBe(2)
    expect(html).toContain('>A<'); expect(html).toContain('>B<')
  })
})
