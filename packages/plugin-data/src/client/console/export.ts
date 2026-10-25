/** Client-side export helpers: dataset CSV and chart SVG → PNG. */
import type { DatasetRows } from './api.ts'

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Serialize a dataset to CSV (with a UTF-8 BOM for spreadsheet tools). */
export function rowsToCsv(rows: DatasetRows): string {
  const header = rows.columns.map((column) => csvCell(column.name)).join(',')
  const body = rows.rows.map((row) => rows.columns.map((column) => csvCell(row[column.name])).join(','))
  return `\uFEFF${[header, ...body].join('\n')}\n`
}

export function downloadText(filename: string, text: string, type = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

const EXPORT_VARS = [
  '--dsw-alias-brand-primary:#4c7dff',
  '--dsw-alias-border-l3:#2c313c',
  '--dsw-alias-label-primary:#e7e9ee',
  '--dsw-alias-label-secondary:#9aa1ad',
  '--dsw-alias-label-tertiary:#6b7280',
  '--dsw-alias-bg-layer-1:#ffffff',
  '--dsw-alias-bg-layer-2:#ffffff',
].join(';')

/** Rasterize one chart SVG to PNG using the browser canvas. */
export async function downloadChartPng(svg: SVGSVGElement, filename: string): Promise<void> {
  const rect = svg.getBoundingClientRect()
  const width = Math.max(320, Math.round(rect.width || 640))
  const height = Math.max(200, Math.round(rect.height || 320))
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
  style.textContent = `:root{${EXPORT_VARS}}`
  clone.insertBefore(style, clone.firstChild)
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  background.setAttribute('width', '100%')
  background.setAttribute('height', '100%')
  background.setAttribute('fill', '#ffffff')
  clone.insertBefore(background, style.nextSibling)
  const source = new XMLSerializer().serializeToString(clone)
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('chart image could not be decoded'))
      image.src = url
    })
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('canvas is unavailable')
    context.scale(scale, scale)
    context.drawImage(image, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (blob === null) throw new Error('PNG encoding failed')
    const pngUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = pngUrl
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(pngUrl)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 80) || 'chart'
}
