/**
 * Dependency-free SVG chart cards. The renderer covers the four MVP chart
 * kinds Data Formulator starts with (bar / line / scatter / pie) and stays
 * deliberately isolated: a later Flint/Vega renderer can replace this file
 * without touching the thread model.
 */
import type { ReactElement } from 'react'
import type { ChartCard, ChartFilter, ChartRange, DatasetRows } from './api.ts'
import { applyChartFilters, applyChartRange, buildBoxplot, buildGroupedSeries, buildHeatmap, buildSeries, maxMagnitude, niceMax } from './chart-model.ts'
import { FlintChart, isFlintChart } from './flint-chart.tsx'
import { colors, styles } from './ui.ts'

const SERIES = ['var(--dsw-alias-brand-primary)', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4']

const THEMES: Readonly<Record<string, readonly string[]>> = {
  default: SERIES,
  warm: ['#f97316', '#ef4444', '#f59e0b', '#e11d48', '#fb7185', '#fbbf24'],
  cool: ['#06b6d4', '#3b82f6', '#6366f1', '#0ea5e9', '#14b8a6', '#8b5cf6'],
  mono: ['#64748b', '#94a3b8', '#475569', '#cbd5e1', '#334155', '#e2e8f0'],
}

function palette(card: ChartCard): readonly string[] {
  return THEMES[card.spec.theme ?? 'default'] ?? SERIES
}

function EmptyChart(): ReactElement {
  return <p style={styles.chartEmpty}>无可绘制的数值数据</p>
}

export function ChartView({ card, rows, height = 220, extraFilters, extraRanges }: {
  card: ChartCard
  rows: DatasetRows | undefined
  height?: number
  extraFilters?: readonly ChartFilter[]
  extraRanges?: readonly ChartRange[]
}): ReactElement {
  if (rows === undefined) return <div style={{ ...styles.chartFrame, height }}><p style={styles.chartEmpty}>加载数据…</p></div>
  const dataset = (extraRanges ?? []).reduce(
    (current, range) => applyChartRange(current, range),
    applyChartRange(applyChartFilters(rows, [...(card.spec.filters ?? []), ...(extraFilters ?? [])]), card.spec.range),
  )
  const chartColors = palette(card)
  if (isFlintChart(card.spec.chart)) {
    return <FlintChart card={card} rows={{ columns: dataset.columns, rows: dataset.rows }} height={height} />
  }
  if (card.spec.chart === 'heatmap') {
    const heatmap = buildHeatmap(dataset, card.spec)
    if (heatmap.cells.length === 0) return <div style={{ ...styles.chartFrame, height }}><EmptyChart /></div>
    const width = 640
    const pad = { left: 78, right: 18, top: 12, bottom: 34 }
    const plotW = width - pad.left - pad.right
    const plotH = height - pad.top - pad.bottom
    const cellW = plotW / Math.max(1, heatmap.xLabels.length)
    const cellH = plotH / Math.max(1, heatmap.yLabels.length)
    return (
      <div style={styles.chartFrame}>
        <svg viewBox={`0 0 ${width} ${height}`} style={styles.chartSvg} role="img" aria-label={card.title}>
          {heatmap.cells.map((cell) => {
            const x = heatmap.xLabels.indexOf(cell.x)
            const y = heatmap.yLabels.indexOf(cell.y)
            const ratio = heatmap.max <= 0 ? 0 : cell.value / heatmap.max
            return (
              <g key={`${cell.x}-${cell.y}`}>
                <rect x={pad.left + x * cellW + 1} y={pad.top + y * cellH + 1} width={Math.max(1, cellW - 2)} height={Math.max(1, cellH - 2)} rx={2} fill="#4c7dff" fillOpacity={0.08 + ratio * 0.85}>
                  <title>{`${cell.x} · ${cell.y}: ${Math.round(cell.value * 100) / 100}`}</title>
                </rect>
                {cellW > 42 && cellH > 22 && <text x={pad.left + x * cellW + cellW / 2} y={pad.top + y * cellH + cellH / 2 + 3} textAnchor="middle" fontSize={9} fill={ratio > 0.55 ? '#fff' : colors.secondary}>{Math.round(cell.value * 100) / 100}</text>}
              </g>
            )
          })}
          {heatmap.xLabels.map((label, index) => <text key={label} x={pad.left + index * cellW + cellW / 2} y={height - 14} textAnchor="middle" fontSize={9} fill={colors.tertiary}>{label}</text>)}
          {heatmap.yLabels.map((label, index) => <text key={label} x={pad.left - 6} y={pad.top + index * cellH + cellH / 2 + 3} textAnchor="end" fontSize={9} fill={colors.tertiary}>{label}</text>)}
        </svg>
      </div>
    )
  }
  if (card.spec.chart === 'boxplot') {
    const boxplot = buildBoxplot(dataset, card.spec)
    if (boxplot.length === 0) return <div style={{ ...styles.chartFrame, height }}><EmptyChart /></div>
    const width = 640
    const pad = { left: 52, right: 16, top: 18, bottom: 42 }
    const plotW = width - pad.left - pad.right
    const plotH = height - pad.top - pad.bottom
    const low = Math.min(0, ...boxplot.map((group) => group.min))
    const high = niceMax(Math.max(...boxplot.map((group) => group.max)))
    const sy = (value: number): number => pad.top + plotH - ((value - low) / Math.max(1e-9, high - low)) * plotH
    const band = plotW / Math.max(1, boxplot.length)
    return (
      <div style={styles.chartFrame}>
        <svg viewBox={`0 0 ${width} ${height}`} style={styles.chartSvg} role="img" aria-label={card.title}>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <line key={ratio} x1={pad.left} x2={width - pad.right} y1={pad.top + plotH * ratio} y2={pad.top + plotH * ratio} stroke={colors.border} strokeDasharray="3 4" />
          ))}
          {boxplot.map((group, index) => {
            const cx = pad.left + band * (index + 0.5)
            const box = Math.max(8, band * 0.45)
            return (
              <g key={group.label}>
                <line x1={cx} x2={cx} y1={sy(group.min)} y2={sy(group.max)} stroke={colors.secondary} strokeWidth={1} />
                <line x1={cx - box / 3} x2={cx + box / 3} y1={sy(group.min)} y2={sy(group.min)} stroke={colors.secondary} />
                <line x1={cx - box / 3} x2={cx + box / 3} y1={sy(group.max)} y2={sy(group.max)} stroke={colors.secondary} />
                <rect x={cx - box / 2} y={sy(group.q3)} width={box} height={Math.max(1, sy(group.q1) - sy(group.q3))} rx={2} fill={chartColors[index % chartColors.length]} fillOpacity={0.35} stroke={chartColors[index % chartColors.length]} />
                <line x1={cx - box / 2} x2={cx + box / 2} y1={sy(group.median)} y2={sy(group.median)} stroke={chartColors[index % chartColors.length]} strokeWidth={2} />
                <text x={cx} y={height - 16} textAnchor="middle" fontSize={10} fill={colors.tertiary}>{group.label}</text>
              </g>
            )
          })}
        </svg>
      </div>
    )
  }
  if (card.spec.facet !== undefined) {
    const facetColumn = card.spec.facet
    const values = [...new Set(dataset.rows.map((row) => String(row[facetColumn] ?? '')))].filter((value) => value !== '').slice(0, 12)
    if (values.length > 1) {
      const facetCard = { ...card, spec: { ...card.spec, facet: undefined, filters: undefined } }
      return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
          {values.map((value) => (
            <div key={value} style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: 6, minWidth: 0 }}>
              <p style={{ ...styles.tiny, margin: '0 0 2px' }}>{facetColumn}: {value}</p>
              <ChartView card={facetCard} rows={{ columns: dataset.columns, rows: dataset.rows.filter((row) => String(row[facetColumn] ?? '') === value) }} height={Math.max(120, Math.floor(height * 0.65))} />
            </div>
          ))}
        </div>
      )
    }
  }
  const series = buildSeries(dataset, card.spec)
  const grouped = card.spec.color !== undefined && card.spec.chart !== 'pie' && card.spec.chart !== 'scatter' && card.spec.chart !== 'donut'
    ? buildGroupedSeries(dataset, card.spec)
    : undefined
  if (card.spec.chart === 'scatter') {
    if (series.scatter.length === 0) return <div style={{ ...styles.chartFrame, height }}><EmptyChart /></div>
    const xs = series.scatter.map((point) => point.x)
    const ys = series.scatter.map((point) => point.y)
    const xMax = niceMax(maxMagnitude(xs))
    const yMax = niceMax(maxMagnitude(ys))
    const xMin = Math.min(0, ...xs)
    const yMin = Math.min(0, ...ys)
    const width = 640
    const pad = { left: 48, right: 16, top: 16, bottom: 30 }
    const plotW = width - pad.left - pad.right
    const plotH = height - pad.top - pad.bottom
    const sx = (value: number): number => pad.left + ((value - xMin) / Math.max(1e-9, xMax - xMin)) * plotW
    const sy = (value: number): number => pad.top + plotH - ((value - yMin) / Math.max(1e-9, yMax - yMin)) * plotH
    return (
      <div style={styles.chartFrame}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={card.title} style={styles.chartSvg}>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <g key={ratio}>
              <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotH * ratio} y2={pad.top + plotH * ratio} stroke={colors.border} strokeDasharray="3 4" />
              <text x={pad.left - 8} y={pad.top + plotH * ratio + 4} textAnchor="end" fontSize={10} fill={colors.tertiary}>
                {Math.round(yMax - (yMax - yMin) * ratio)}
              </text>
            </g>
          ))}
          {(() => {
            const colorNames = [...new Set(series.scatter.map((point) => point.color ?? ''))]
            const sizes = series.scatter.map((point) => point.size).filter((value): value is number => value !== undefined)
            const sizeMin = sizes.length === 0 ? 0 : Math.min(...sizes)
            const sizeMax = sizes.length === 0 ? 0 : Math.max(...sizes)
            return series.scatter.map((point, index) => {
              const colorIndex = point.color === undefined ? 0 : Math.max(0, colorNames.indexOf(point.color))
              const radius = point.size === undefined
                ? 4.5
                : 4 + (sizeMax === sizeMin ? 0.5 : (point.size - sizeMin) / (sizeMax - sizeMin)) * 6
              return (
                <circle key={index} cx={sx(point.x)} cy={sy(point.y)} r={radius} fill={chartColors[colorIndex % chartColors.length]} fillOpacity={0.75} stroke={chartColors[colorIndex % chartColors.length]}>
                  <title>{`${card.spec.x}: ${point.x} · ${card.spec.y}: ${point.y}${point.color === undefined ? '' : ` · ${point.color}`}`}</title>
                </circle>
              )
            })
          })()}
          <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke={colors.border} />
          <line x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} stroke={colors.border} />
        </svg>
      </div>
    )
  }

  if (series.points.length === 0) return <div style={{ ...styles.chartFrame, height }}><EmptyChart /></div>
  const width = 640
  const pad = { left: 52, right: 16, top: 18, bottom: card.spec.chart === 'pie' ? 18 : 42 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const values = series.points.map((point) => point.value)
  const yMax = niceMax(maxMagnitude(values))
  const yMin = Math.min(0, ...values)
  const band = plotW / Math.max(1, series.points.length)
  const mean = values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
  let maxIndex = 0
  series.points.forEach((point, index) => { if (point.value > series.points[maxIndex]!.value) maxIndex = index })
  const annotations = card.spec.annotations ?? {}

  if (card.spec.chart === 'pie' || card.spec.chart === 'donut') {
    const total = values.reduce((sum, value) => sum + Math.max(0, value), 0)
    if (total <= 0) return <div style={{ ...styles.chartFrame, height }}><EmptyChart /></div>
    const cx = 150
    const cy = height / 2
    const radius = Math.min(80, height / 2 - 12)
    const inner = card.spec.chart === 'donut' ? radius * 0.55 : 0
    let angle = -Math.PI / 2
    const arcs = series.points.map((point, index) => {
      const share = Math.max(0, point.value) / total
      const next = angle + share * Math.PI * 2
      const large = next - angle > Math.PI ? 1 : 0
      const x1 = cx + radius * Math.cos(angle)
      const y1 = cy + radius * Math.sin(angle)
      const x2 = cx + radius * Math.cos(next)
      const y2 = cy + radius * Math.sin(next)
      const ix1 = cx + inner * Math.cos(angle)
      const iy1 = cy + inner * Math.sin(angle)
      const ix2 = cx + inner * Math.cos(next)
      const iy2 = cy + inner * Math.sin(next)
      const path = inner === 0
        ? `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`
        : `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z`
      angle = next
      return <path key={point.label} d={path} fill={chartColors[index % chartColors.length]} fillOpacity={0.85} stroke={colors.layer1} strokeWidth={1}>
        <title>{`${point.label}: ${point.value}`}</title>
      </path>
    })
    return (
      <div style={styles.chartFrame}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <svg viewBox={`0 0 300 ${height}`} style={{ ...styles.chartSvg, width: '55%', flex: '0 0 55%' }} role="img" aria-label={card.title}>
            {arcs}
          </svg>
          <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
            {series.points.slice(0, 8).map((point, index) => (
              <div key={point.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: colors.secondary }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: chartColors[index % chartColors.length], flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{point.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const sy = (value: number): number => pad.top + plotH - ((value - yMin) / Math.max(1e-9, yMax - yMin)) * plotH
  if (grouped !== undefined && (card.spec.chart === 'line' || card.spec.chart === 'area')) {
    const allValues = grouped.groups.flatMap((group) => group.values)
    const groupedMax = niceMax(maxMagnitude(allValues))
    const groupedMin = Math.min(0, ...allValues)
    const groupSy = (value: number): number => pad.top + plotH - ((value - groupedMin) / Math.max(1e-9, groupedMax - groupedMin)) * plotH
    return (
      <div style={styles.chartFrame}>
        <svg viewBox={`0 0 ${width} ${height}`} style={styles.chartSvg} role="img" aria-label={card.title}>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <line key={ratio} x1={pad.left} x2={width - pad.right} y1={pad.top + plotH * ratio} y2={pad.top + plotH * ratio} stroke={colors.border} strokeDasharray="3 4" />
          ))}
          {grouped.groups.map((group, groupIndex) => {
            const points = group.values.map((value, index) => ({ x: pad.left + band * (index + 0.5), y: groupSy(value), value }))
            return (
              <g key={group.name}>
                <polyline fill="none" stroke={chartColors[groupIndex % chartColors.length]} strokeWidth={2} points={points.map((point) => `${point.x},${point.y}`).join(' ')} />
                {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={3} fill={chartColors[groupIndex % chartColors.length]}><title>{`${group.name} · ${grouped.labels[index]}: ${point.value}`}</title></circle>)}
              </g>
            )
          })}
          {grouped.labels.map((label, index) => (index % Math.max(1, Math.ceil(grouped.labels.length / 8)) === 0
            ? <text key={label} x={pad.left + band * (index + 0.5)} y={height - 16} textAnchor="middle" fontSize={10} fill={colors.tertiary}>{label}</text>
            : null))}
        </svg>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 10, color: colors.secondary }}>
          {grouped.groups.map((group, index) => (
            <span key={group.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: chartColors[index % chartColors.length] }} />{group.name}
            </span>
          ))}
        </div>
      </div>
    )
  }
  if (grouped !== undefined && card.spec.chart === 'bar') {
    const allValues = grouped.groups.flatMap((group) => group.values)
    const groupedMax = niceMax(maxMagnitude(allValues))
    const groupedMin = Math.min(0, ...allValues)
    const groupSy = (value: number): number => pad.top + plotH - ((value - groupedMin) / Math.max(1e-9, groupedMax - groupedMin)) * plotH
    const barBand = band / Math.max(1, grouped.groups.length)
    return (
      <div style={styles.chartFrame}>
        <svg viewBox={`0 0 ${width} ${height}`} style={styles.chartSvg} role="img" aria-label={card.title}>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <line key={ratio} x1={pad.left} x2={width - pad.right} y1={pad.top + plotH * ratio} y2={pad.top + plotH * ratio} stroke={colors.border} strokeDasharray="3 4" />
          ))}
          {grouped.groups.map((group, groupIndex) => group.values.map((value, index) => {
            const x = pad.left + band * index + barBand * groupIndex + barBand * 0.15
            const barWidth = Math.max(2, barBand * 0.7)
            const top = groupSy(Math.max(value, 0))
            const bottom = groupSy(Math.min(value, 0))
            return <rect key={`${group.name}-${index}`} x={x} y={top} width={barWidth} height={Math.max(1, bottom - top)} rx={2} fill={chartColors[groupIndex % chartColors.length]} fillOpacity={0.85}><title>{`${group.name} · ${grouped.labels[index]}: ${value}`}</title></rect>
          }))}
          {grouped.labels.map((label, index) => <text key={label} x={pad.left + band * index + band / 2} y={height - 16} textAnchor="middle" fontSize={10} fill={colors.tertiary}>{label}</text>)}
        </svg>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 10, color: colors.secondary }}>
          {grouped.groups.map((group, index) => (
            <span key={group.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: chartColors[index % chartColors.length] }} />{group.name}
            </span>
          ))}
        </div>
      </div>
    )
  }
  if (card.spec.chart === 'line' || card.spec.chart === 'area') {
    const points = series.points.map((point, index) => {
      const x = pad.left + band * (index + 0.5)
      return { x, y: sy(point.value), label: point.label, value: point.value }
    })
    return (
      <div style={styles.chartFrame}>
        <svg viewBox={`0 0 ${width} ${height}`} style={styles.chartSvg} role="img" aria-label={card.title}>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <line key={ratio} x1={pad.left} x2={width - pad.right} y1={pad.top + plotH * ratio} y2={pad.top + plotH * ratio} stroke={colors.border} strokeDasharray="3 4" />
          ))}
          {card.spec.chart === 'area' && points.length > 0 && (
            <path
              d={`M ${points[0]!.x} ${sy(0)} ${points.map((point) => `L ${point.x} ${point.y}`).join(' ')} L ${points[points.length - 1]!.x} ${sy(0)} Z`}
              fill={chartColors[0]}
              fillOpacity={0.18}
              stroke="none"
            />
          )}
          <polyline
            fill="none"
            stroke={chartColors[0]}
            strokeWidth={2}
            points={points.map((point) => `${point.x},${point.y}`).join(' ')}
          />
          {points.map((point) => (
            <circle key={point.label} cx={point.x} cy={point.y} r={3.5} fill={chartColors[0]}>
              <title>{`${point.label}: ${point.value}`}</title>
            </circle>
          ))}
          {points.map((point, index) => (index % Math.max(1, Math.ceil(points.length / 8)) === 0
            ? <text key={`label-${point.label}`} x={point.x} y={height - 16} textAnchor="middle" fontSize={10} fill={colors.tertiary}>{point.label}</text>
            : null))}
          {annotations.mean === true && (
            <g>
              <line x1={pad.left} x2={width - pad.right} y1={sy(mean)} y2={sy(mean)} stroke={colors.secondary} strokeDasharray="5 4" strokeWidth={1} />
              <text x={width - pad.right} y={sy(mean) - 4} textAnchor="end" fontSize={9} fill={colors.secondary}>avg {Math.round(mean * 100) / 100}</text>
            </g>
          )}
          {annotations.max === true && annotations.labels !== true && points[maxIndex] !== undefined && (
            <text x={points[maxIndex]!.x} y={points[maxIndex]!.y - 8} textAnchor="middle" fontSize={9} fill={colors.secondary}>
              ▲ {Math.round(points[maxIndex]!.value * 100) / 100}
            </text>
          )}
          {annotations.labels === true && points.map((point) => (
            <text key={`value-${point.label}`} x={point.x} y={point.y - 7} textAnchor="middle" fontSize={9} fill={colors.tertiary}>{Math.round(point.value * 100) / 100}</text>
          ))}
        </svg>
      </div>
    )
  }

  if (card.spec.chart === 'horizontalBar') {
    const rowHeight = plotH / Math.max(1, series.points.length)
    const barMax = niceMax(maxMagnitude(series.points.map((point) => point.value)))
    const barX = (value: number): number => ((value - yMin) / Math.max(1e-9, barMax - yMin)) * plotW
    return (
      <div style={styles.chartFrame}>
        <svg viewBox={`0 0 ${width} ${height}`} style={styles.chartSvg} role="img" aria-label={card.title}>
          {series.points.map((point, index) => {
            const y = pad.top + rowHeight * index + rowHeight * 0.2
            const barHeight = Math.max(2, rowHeight * 0.6)
            return (
              <g key={point.label}>
                <text x={pad.left - 6} y={y + barHeight * 0.7} textAnchor="end" fontSize={10} fill={colors.tertiary}>{point.label}</text>
                <rect x={pad.left} y={y} width={Math.max(1, barX(point.value))} height={barHeight} rx={3} fill={chartColors[index % chartColors.length]} fillOpacity={0.85}>
                  <title>{`${point.label}: ${point.value}`}</title>
                </rect>
                <text x={pad.left + Math.max(1, barX(point.value)) + 5} y={y + barHeight * 0.7} fontSize={9} fill={colors.tertiary}>{Math.round(point.value * 100) / 100}</text>
              </g>
            )
          })}
        </svg>
      </div>
    )
  }

  // bar
  return (
    <div style={styles.chartFrame}>
      <svg viewBox={`0 0 ${width} ${height}`} style={styles.chartSvg} role="img" aria-label={card.title}>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <g key={ratio}>
            <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotH * ratio} y2={pad.top + plotH * ratio} stroke={colors.border} strokeDasharray="3 4" />
            <text x={pad.left - 8} y={pad.top + plotH * ratio + 4} textAnchor="end" fontSize={10} fill={colors.tertiary}>
              {Math.round(yMax - (yMax - yMin) * ratio)}
            </text>
          </g>
        ))}
        {series.points.map((point, index) => {
          const x = pad.left + band * index + band * 0.18
          const barW = Math.max(2, band * 0.64)
          const top = sy(Math.max(point.value, 0))
          const bottom = sy(Math.min(point.value, 0))
          return (
            <g key={point.label}>
              <rect x={x} y={top} width={barW} height={Math.max(1, bottom - top)} rx={3} fill={chartColors[index % chartColors.length]} fillOpacity={0.85}>
                <title>{`${point.label}: ${point.value}`}</title>
              </rect>
              <text x={x + barW / 2} y={height - 16} textAnchor="middle" fontSize={10} fill={colors.tertiary}>{point.label}</text>
            </g>
          )
        })}
        {annotations.mean === true && (
          <g>
            <line x1={pad.left} x2={width - pad.right} y1={sy(mean)} y2={sy(mean)} stroke={colors.secondary} strokeDasharray="5 4" strokeWidth={1} />
            <text x={width - pad.right} y={sy(mean) - 4} textAnchor="end" fontSize={9} fill={colors.secondary}>avg {Math.round(mean * 100) / 100}</text>
          </g>
        )}
        {annotations.max === true && annotations.labels !== true && series.points[maxIndex] !== undefined && (
          <text x={pad.left + band * maxIndex + band / 2} y={sy(Math.max(series.points[maxIndex]!.value, 0)) - 5} textAnchor="middle" fontSize={9} fill={colors.secondary}>
            ▲ {Math.round(series.points[maxIndex]!.value * 100) / 100}
          </text>
        )}
        {annotations.labels === true && series.points.map((point, index) => (
          <text key={`value-${point.label}`} x={pad.left + band * index + band / 2} y={sy(Math.max(point.value, 0)) - 5} textAnchor="middle" fontSize={9} fill={colors.tertiary}>{Math.round(point.value * 100) / 100}</text>
        ))}
      </svg>
    </div>
  )
}
