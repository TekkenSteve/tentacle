import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChartView } from '../src/client/console/charts.tsx'
import type { ChartCard, DatasetRows } from '../src/client/console/api.ts'

const rows: DatasetRows = {
  columns: [{ name: 'month', type: 'string' }, { name: 'revenue', type: 'number' }],
  rows: [{ month: 'Jan', revenue: 10 }, { month: 'Feb', revenue: 30 }, { month: 'Mar', revenue: 20 }],
}

function card(annotations: ChartCard['spec']['annotations']): ChartCard {
  return {
    id: 'card-1', threadId: 'thread-1', kind: 'chart', title: 'Revenue', createdAt: 0, datasetId: 'ds-1',
    spec: { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum', annotations },
  }
}

describe('chart annotations', () => {
  it('renders mean line and max marker', () => {
    const html = renderToStaticMarkup(<ChartView card={card({ mean: true, max: true })} rows={rows} />)
    expect(html).toContain('avg')
    expect(html).toContain('▲')
  })

  it('renders data labels instead of a duplicate max marker', () => {
    const html = renderToStaticMarkup(<ChartView card={card({ max: true, labels: true })} rows={rows} />)
    expect(html).toContain('>30<')
    expect(html).not.toContain('▲')
  })

  it('renders one small multiple per facet value', () => {
    const facetCard: ChartCard = {
      ...card(undefined),
      spec: { chart: 'bar', x: 'month', y: 'revenue', aggregate: 'sum', facet: 'region' },
    }
    const facetRows: DatasetRows = {
      columns: [...rows.columns, { name: 'region', type: 'string' }],
      rows: [
        { month: 'Jan', revenue: 10, region: 'north' },
        { month: 'Jan', revenue: 20, region: 'south' },
        { month: 'Feb', revenue: 30, region: 'north' },
      ],
    }
    const html = renderToStaticMarkup(<ChartView card={facetCard} rows={facetRows} />)
    expect(html).toContain('region: north')
    expect(html).toContain('region: south')
    expect((html.match(/<svg/g) ?? []).length).toBe(2)
  })

  it('omits annotations when disabled', () => {
    const html = renderToStaticMarkup(<ChartView card={card(undefined)} rows={rows} />)
    expect(html).not.toContain('avg')
    expect(html).not.toContain('▲')
  })
})
