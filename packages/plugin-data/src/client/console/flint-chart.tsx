/**
 * Flint-powered charts. Data Formulator's chart compiler supports far more
 * templates than the native SVG renderer; for those kinds we assemble a
 * Vega-Lite spec with Flint and render it with vega-embed.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { assembleVegaLite as flintAssemble } from 'flint-chart'
import { compile } from 'vega-lite'
import { parse, View } from 'vega'
import type { ChartCard, ChartKind, DatasetRows } from './api.ts'
import { colors, styles } from './ui.ts'

const FLINT_TYPES: Partial<Record<ChartKind, string>> = {
  bump: 'Bump Chart',
  streamgraph: 'Streamgraph',
  waterfall: 'Waterfall Chart',
  rose: 'Rose Chart',
  radar: 'Radar Chart',
  groupedBar: 'Grouped Bar Chart',
  stackedBar: 'Stacked Bar Chart',
  candlestick: 'Candlestick Chart',
  gantt: 'Gantt Chart',
  histogram: 'Histogram',
  density: 'Density Plot',
  violin: 'Violin Plot',
  kpi: 'KPI Card',
  rangeArea: 'Range Area Chart',
  bullet: 'Bullet Chart',
  barTable: 'Bar Table',
  table: 'Table',
  rangeDot: 'Ranged Dot Plot',
  map: 'Map',
  choropleth: 'Choropleth',
  marginal: 'Marginal Plot',
  regression: 'Regression',
  connectedScatter: 'Connected Scatter Plot',
  strip: 'Strip Plot',
  lollipop: 'Lollipop Chart',
  pyramid: 'Pyramid Chart',
  slope: 'Slope Chart',
  sparkline: 'Sparkline',
  ridgeline: 'Ridgeline Plot',
  ecdf: 'ECDF Plot',
  calendarHeatmap: 'Calendar Heatmap',
}

export function isFlintChart(chart: ChartKind): boolean {
  return FLINT_TYPES[chart] !== undefined
}

function semanticType(column: { type: string }): string {
  if (column.type === 'number') return 'Quantity'
  if (column.type === 'date') return 'Date'
  if (column.type === 'boolean') return 'Status'
  return 'Category'
}

function encodingType(column: { type: string }): 'quantitative' | 'nominal' | 'temporal' {
  if (column.type === 'number') return 'quantitative'
  if (column.type === 'date') return 'temporal'
  return 'nominal'
}

export function buildFlintSpec(card: ChartCard, rows: DatasetRows): unknown {
  const assemble = (input: any): unknown => flintAssemble({ ...input, chart_spec: { ...input.chart_spec, ...(card.spec.chartProperties === undefined ? {} : { chartProperties: card.spec.chartProperties }) } } as never)
  const chartType = FLINT_TYPES[card.spec.chart]
  if (chartType === undefined) throw new Error(`unsupported Flint chart: ${card.spec.chart}`)
  const columns = new Map(rows.columns.map((column) => [column.name, column]))
  const x = columns.get(card.spec.x)
  const color = card.spec.color === undefined ? undefined : columns.get(card.spec.color)
  if (x === undefined) throw new Error('chart needs an x column')
  if (card.spec.chart === 'candlestick') {
    const fields = ['open', 'high', 'low', 'close'] as const
    const encodings: Record<string, unknown> = { x: { field: x.name, type: encodingType(x) } }
    for (const key of fields) {
      const name = card.spec[key]
      const column = name === undefined ? undefined : columns.get(name)
      if (column === undefined) throw new Error(`candlestick needs a ${key} column`)
      encodings[key] = { field: column.name, type: 'quantitative' as const }
    }
    return assemble({
      data: { values: rows.rows },
      semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])),
      chart_spec: { chartType, title: card.title, encodings, baseSize: { width: 640, height: 220 } },
    } as never)
  }
  const y = card.spec.y === undefined ? undefined : columns.get(card.spec.y)
  if (card.spec.chart === 'gantt') {
    const x2 = card.spec.x2 === undefined ? undefined : columns.get(card.spec.x2)
    if (y === undefined || x2 === undefined) throw new Error('gantt needs x, x2 and y columns')
    return assemble({
      data: { values: rows.rows },
      semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])),
      chart_spec: {
        chartType,
        title: card.title,
        encodings: {
          x: { field: x.name, type: encodingType(x) },
          x2: { field: x2.name, type: encodingType(x2) },
          y: { field: y.name, type: encodingType(y) },
          ...(color === undefined ? {} : { color: { field: color.name, type: 'nominal' as const } }),
        },
        baseSize: { width: 640, height: 220 },
      },
    } as never)
  }
  if (card.spec.chart === 'ecdf') {
    return assemble({ data: { values: rows.rows }, semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])), chart_spec: { chartType, title: card.title, encodings: { x: { field: x.name, type: 'quantitative' } }, baseSize: { width: 640, height: 220 } } })
  }
  if (card.spec.chart === 'calendarHeatmap') {
    if (y === undefined) throw new Error('calendar heatmap needs a measure')
    return assemble({ data: { values: rows.rows }, semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])), chart_spec: { chartType, title: card.title, encodings: { x: { field: x.name, type: encodingType(x) }, color: { field: y.name, type: 'quantitative' } }, baseSize: { width: 640, height: 220 } } })
  }
  if (card.spec.chart === 'choropleth') {
    if (y === undefined) throw new Error('choropleth needs id and measure columns')
    return assemble({
      data: { values: rows.rows },
      semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])),
      chart_spec: {
        chartType,
        title: card.title,
        encodings: {
          id: { field: x.name, type: encodingType(x) },
          color: { field: y.name, type: 'quantitative' },
        },
        baseSize: { width: 640, height: 220 },
      },
    })
  }
  if (card.spec.chart === 'map') {
    if (y === undefined) throw new Error('map needs longitude and latitude columns')
    const size = card.spec.size === undefined ? undefined : columns.get(card.spec.size)
    return assemble({
      data: { values: rows.rows },
      semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])),
      chart_spec: {
        chartType,
        title: card.title,
        encodings: {
          longitude: { field: x.name, type: 'quantitative' },
          latitude: { field: y.name, type: 'quantitative' },
          ...(color === undefined ? {} : { color: { field: color.name, type: 'nominal' as const } }),
          ...(size === undefined ? {} : { size: { field: size.name, type: 'quantitative' as const } }),
        },
        baseSize: { width: 640, height: 220 },
      },
    })
  }
  if (card.spec.chart === 'table') {
    return assemble({
      data: { values: rows.rows },
      semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])),
      chart_spec: { chartType, title: card.title, encodings: {}, baseSize: { width: 640, height: 220 } },
    })
  }
  if (card.spec.chart === 'bullet') {
    const goal = card.spec.goal === undefined ? undefined : columns.get(card.spec.goal)
    if (y === undefined || goal === undefined) throw new Error('bullet needs value and goal columns')
    return assemble({
      data: { values: rows.rows },
      semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])),
      chart_spec: {
        chartType,
        title: card.title,
        encodings: {
          y: { field: x.name, type: encodingType(x) },
          x: { field: y.name, type: 'quantitative' },
          goal: { field: goal.name, type: 'quantitative' as const },
          ...(color === undefined ? {} : { color: { field: color.name, type: 'nominal' as const } }),
        },
        baseSize: { width: 640, height: 220 },
      },
    } as never)
  }
  if (card.spec.chart === 'rangeArea') {
    const y2 = card.spec.y2 === undefined ? undefined : columns.get(card.spec.y2)
    if (y === undefined || y2 === undefined) throw new Error('range area needs y and y2 columns')
    return assemble({
      data: { values: rows.rows },
      semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])),
      chart_spec: {
        chartType,
        title: card.title,
        encodings: {
          x: { field: x.name, type: encodingType(x) },
          y: { field: y.name, type: 'quantitative' },
          y2: { field: y2.name, type: 'quantitative' },
          ...(color === undefined ? {} : { color: { field: color.name, type: 'nominal' as const } }),
        },
        baseSize: { width: 640, height: 220 },
      },
    } as never)
  }
  if (card.spec.chart === 'kpi') {
    if (y === undefined || y.type !== 'number') throw new Error('KPI needs a numeric value column')
    const goal = card.spec.goal === undefined ? undefined : columns.get(card.spec.goal)
    return assemble({
      data: { values: rows.rows },
      semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])),
      chart_spec: {
        chartType,
        title: card.title,
        encodings: {
          metric: { field: x.name, type: encodingType(x) },
          value: { field: y.name, type: 'quantitative', aggregate: card.spec.aggregate === 'avg' ? 'average' : card.spec.aggregate === 'none' ? undefined : card.spec.aggregate },
          ...(goal === undefined ? {} : { goal: { field: goal.name, type: 'quantitative' as const } }),
        },
        baseSize: { width: 640, height: 220 },
      },
    } as never)
  }
  if (card.spec.chart === 'histogram' || card.spec.chart === 'density') {
    return assemble({
      data: { values: rows.rows },
      semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])),
      chart_spec: {
        chartType,
        title: card.title,
        encodings: {
          x: { field: x.name, type: 'quantitative' },
          ...(color === undefined ? {} : { color: { field: color.name, type: 'nominal' as const } }),
        },
        baseSize: { width: 640, height: 220 },
      },
    } as never)
  }
  if (y === undefined) throw new Error('chart needs x and y columns')
  const aggregate = card.spec.aggregate === 'avg' ? 'average' : card.spec.aggregate === 'none' ? undefined : card.spec.aggregate
  const encodings: Record<string, unknown> = {
    x: { field: x.name, type: encodingType(x) },
    y: { field: y.name, type: 'quantitative', ...(aggregate === undefined ? {} : { aggregate }) },
    ...(color === undefined ? {} : card.spec.chart === 'groupedBar'
      ? { group: { field: color.name, type: 'nominal' as const } }
      : { color: { field: color.name, type: 'nominal' as const } }),
  }
  return assemble({
    data: { values: rows.rows },
    semantic_types: Object.fromEntries(rows.columns.map((column) => [column.name, semanticType(column)])),
    chart_spec: {
      chartType,
      title: card.title,
      encodings,
      baseSize: { width: 640, height: 220 },
    },
  } as never)
}

export function FlintChart({ card, rows, height = 220 }: {
  card: ChartCard
  rows: DatasetRows | undefined
  height?: number
}): ReactElement {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (rows === undefined) return
    let cancelled = false
    let view: View | undefined
    setError('')
    void (async () => {
      try {
        const spec = buildFlintSpec(card, rows)
        const vegaSpec = compile(spec as never).spec
        view = new View(parse(vegaSpec), { renderer: 'none' })
        await view.runAsync()
        const markup = await view.toSVG()
        if (!cancelled) setSvg(markup)
        else view.finalize()
      } catch {
        if (!cancelled) setError('此图表无法用当前字段生成')
      }
    })()
    return () => {
      cancelled = true
      view?.finalize()
    }
  }, [card, rows])
  if (rows === undefined) return <div style={{ ...styles.chartFrame, height }}><p style={styles.chartEmpty}>加载数据…</p></div>
  return (
    <div className="tentacle-flint-chart" style={{ ...styles.chartFrame, minHeight: height }}>
      <style>{`.tentacle-flint-chart svg { display: block; max-width: 100%; height: auto; }`}</style>
      {svg === ''
        ? <p style={styles.chartEmpty}>渲染中…</p>
        : <div style={{ width: '100%' }} dangerouslySetInnerHTML={{ __html: svg }} />}
      {error !== '' && <p style={{ ...styles.chartEmpty, color: colors.danger }}>{error}</p>}
    </div>
  )
}

export interface FlintOption {
  readonly key: string
  readonly label: string
  readonly type: 'continuous' | 'binary' | 'discrete'
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly options?: readonly { value: unknown; label: string }[]
  readonly applicable: boolean
  readonly value: unknown
}

/** The chart properties Flint says are applicable for the current spec + data. */
export function flintOptions(card: ChartCard, rows: DatasetRows | undefined): readonly FlintOption[] {
  if (rows === undefined) return []
  try {
    const spec = buildFlintSpec(card, rows) as { _options?: readonly FlintOption[] }
    return (spec._options ?? []).filter((option) => option.applicable)
  } catch {
    return []
  }
}
