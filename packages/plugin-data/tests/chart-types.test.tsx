import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChartView } from '../src/client/console/charts.tsx'
import type { ChartCard, ChartKind, DatasetRows } from '../src/client/console/api.ts'

const rows: DatasetRows = {
  columns: [{ name: 'month', type: 'string' }, { name: 'revenue', type: 'number' }],
  rows: [{ month: 'Jan', revenue: 10 }, { month: 'Feb', revenue: 20 }],
}

function card(chart: ChartKind): ChartCard {
  return {
    id: 'c', threadId: 't', kind: 'chart', title: 'Revenue', createdAt: 0, datasetId: 'd',
    spec: { chart, x: 'month', y: 'revenue', aggregate: 'sum' },
  }
}

describe('extended chart types', () => {
  it('renders area with a filled path', () => {
    const html = renderToStaticMarkup(<ChartView card={card('area')} rows={rows} />)
    expect(html).toContain('<path')
    expect(html).toContain('fill-opacity="0.18"')
  })

  it('renders donut as a ring path', () => {
    const html = renderToStaticMarkup(<ChartView card={card('donut')} rows={rows} />)
    expect(html).toContain('<path')
    expect(html).toContain('A ')
  })

  it('renders horizontal bars with value labels', () => {
    const html = renderToStaticMarkup(<ChartView card={card('horizontalBar')} rows={rows} />)
    expect(html).toContain('<rect')
    expect(html).toContain('>10<')
    expect(html).toContain('>20<')
  })
})
