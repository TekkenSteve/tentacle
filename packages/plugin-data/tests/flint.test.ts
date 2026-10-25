import { describe, expect, it } from 'vitest'
import { buildFlintSpec, flintOptions } from '../src/client/console/flint-chart.js'
import type { ChartCard, DatasetRows } from '../src/client/console/api.js'

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

function card(chart: ChartCard['spec']['chart']): ChartCard {
  return {
    id: 'f', threadId: 't', kind: 'chart', title: 'Revenue', createdAt: 0, datasetId: 'd',
    spec: { chart, x: 'month', y: 'revenue', color: 'region', aggregate: 'sum' },
  }
}

describe('flint charts', () => {
  it('exposes applicable Flint chart properties', () => {
    expect(flintOptions(card('streamgraph'), rows).length).toBeGreaterThan(0)
  })

  it('assembles a streamgraph from x/y/color', () => {
    const spec = buildFlintSpec(card('streamgraph'), rows) as { mark: unknown; data: { values: unknown[] } }
    expect(spec.data.values).toHaveLength(3)
    expect(spec.mark).toBe('area')
  })

  it('maps color to group for grouped bars and to color for stacked bars', () => {
    const grouped = buildFlintSpec(card('groupedBar'), rows) as { encoding: Record<string, { field: string }> }
    expect(grouped.encoding.color.field).toBe('region')
    expect(grouped.encoding.xOffset.field).toBe('region')
    const stacked = buildFlintSpec(card('stackedBar'), rows) as { encoding: Record<string, { field: string }> }
    expect(stacked.encoding.color.field).toBe('region')
  })

  it('assembles OHLC candlesticks', () => {
    const ohlc: ChartCard = {
      ...card('candlestick'),
      spec: { chart: 'candlestick', x: 'month', aggregate: 'none', open: 'revenue', high: 'revenue', low: 'revenue', close: 'revenue' },
    }
    const spec = buildFlintSpec(ohlc, rows) as { layer: unknown[] }
    expect(spec.layer).toHaveLength(3)
    expect(JSON.stringify(spec)).toContain('"field":"revenue"')
  })

  it('assembles a Gantt chart with x2', () => {
    const gantt: ChartCard = {
      ...card('gantt'),
      spec: { chart: 'gantt', x: 'month', x2: 'month', y: 'region', aggregate: 'none' },
    }
    const spec = buildFlintSpec(gantt, rows) as { encoding: Record<string, { field: string }> }
    expect(spec.encoding.x.field).toBe('month')
    expect(spec.encoding.x2.field).toBe('month')
    expect(spec.encoding.y.field).toBe('region')
  })

  it('assembles histogram and density from a numeric x', () => {
    const histogram: ChartCard = { ...card('histogram'), spec: { chart: 'histogram', x: 'revenue', aggregate: 'count' } }
    const h = buildFlintSpec(histogram, rows) as { mark: unknown }
    expect(h.mark).toBe('bar')
    const density: ChartCard = { ...card('density'), spec: { chart: 'density', x: 'revenue', aggregate: 'count' } }
    const d = buildFlintSpec(density, rows) as { mark: unknown }
    expect(d.mark).toBe('area')
  })

  it('assembles a violin plot', () => {
    const violin: ChartCard = { ...card('violin'), spec: { chart: 'violin', x: 'month', y: 'revenue', aggregate: 'none' } }
    const spec = buildFlintSpec(violin, rows) as { mark: unknown }
    expect(spec.mark).toMatchObject({ type: 'area' })
  })

  it('assembles a KPI card', () => {
    const kpi: ChartCard = { ...card('kpi'), spec: { chart: 'kpi', x: 'month', y: 'revenue', goal: 'revenue', aggregate: 'sum' } }
    const spec = buildFlintSpec(kpi, rows) as { vconcat: unknown[] }
    expect(spec.vconcat.length).toBeGreaterThan(0)
    const text = JSON.stringify(spec)
    expect(text).toContain('month')
    expect(text).toContain('revenue')
  })

  it('assembles a range area with y2', () => {
    const range: ChartCard = { ...card('rangeArea'), spec: { chart: 'rangeArea', x: 'month', y: 'revenue', y2: 'revenue', aggregate: 'none' } }
    const spec = buildFlintSpec(range, rows) as { encoding: Record<string, { field: string }> }
    expect(spec.encoding.y2.field).toBe('revenue')
  })

  it('assembles a bullet chart with goal', () => {
    const bullet: ChartCard = { ...card('bullet'), spec: { chart: 'bullet', x: 'month', y: 'revenue', goal: 'revenue', aggregate: 'sum' } }
    const spec = buildFlintSpec(bullet, rows) as { encoding: Record<string, { field: string }>; layer: unknown[] }
    expect(spec.encoding.y.field).toBe('month')
    expect(spec.layer.length).toBeGreaterThan(1)
    expect(JSON.stringify(spec)).toContain('revenue')
  })

  it('assembles a bar table', () => {
    const spec = buildFlintSpec(card('barTable'), rows) as { hconcat?: unknown[] }
    expect(spec.hconcat?.length).toBeGreaterThan(0)
  })

  it('assembles a table without a measure', () => {
    const table: ChartCard = { ...card('table'), spec: { chart: 'table', x: 'month', aggregate: 'none' } }
    const spec = buildFlintSpec(table, rows) as { layer: unknown[] }
    expect(spec.layer.length).toBeGreaterThan(0)
  })

  it('assembles a ranged dot plot', () => {
    const spec = buildFlintSpec(card('rangeDot'), rows) as { layer: unknown[] }
    expect(spec.layer).toHaveLength(2)
  })

  it('assembles a map from longitude/latitude', () => {
    const geoRows: DatasetRows = {
      columns: [{ name: 'lon', type: 'number' }, { name: 'lat', type: 'number' }, { name: 'city', type: 'string' }],
      rows: [{ lon: 116.4, lat: 39.9, city: 'Beijing' }, { lon: 121.5, lat: 31.2, city: 'Shanghai' }],
    }
    const map: ChartCard = { ...card('map'), spec: { chart: 'map', x: 'lon', y: 'lat', color: 'city', aggregate: 'none' } }
    const spec = buildFlintSpec(map, geoRows) as { layer: unknown[] }
    expect(spec.layer).toHaveLength(2)
    expect(JSON.stringify(spec)).toContain('Beijing')
  })

  it('assembles a choropleth', () => {
    const geo: DatasetRows = {
      columns: [{ name: 'country', type: 'string' }, { name: 'value', type: 'number' }],
      rows: [{ country: 'China', value: 10 }, { country: 'France', value: 20 }],
    }
    const choropleth: ChartCard = { ...card('choropleth'), spec: { chart: 'choropleth', x: 'country', y: 'value', aggregate: 'none' } }
    const spec = buildFlintSpec(choropleth, geo) as { mark: { type: string } }
    expect(spec.mark.type).toBe('geoshape')
  })

  it('assembles sparkline and ecdf templates', () => {
    const sparkline: ChartCard = { ...card('sparkline'), spec: { chart: 'sparkline', x: 'month', y: 'revenue', aggregate: 'sum' } }
    expect(buildFlintSpec(sparkline, rows)).toBeTruthy()
    const ecdf: ChartCard = { ...card('ecdf'), spec: { chart: 'ecdf', x: 'revenue', aggregate: 'none' } }
    expect(buildFlintSpec(ecdf, rows)).toBeTruthy()
  })

  it('assembles a bump chart', () => {
    const spec = buildFlintSpec(card('bump'), rows) as { encoding: Record<string, { field: string }> }
    expect(spec.encoding.x.field).toBe('month')
    expect(spec.encoding.color.field).toBe('region')
  })
})
