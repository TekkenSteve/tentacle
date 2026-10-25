/** Standalone HTML export for a Data Studio report (charts inlined as SVG). */
import { marked } from 'marked'

const STYLES = `
:root{--dsw-alias-brand-primary:#4c7dff;--dsw-alias-border-l3:#d7dbe3;--dsw-alias-label-primary:#1f2430;--dsw-alias-label-secondary:#4b5563;--dsw-alias-label-tertiary:#6b7280;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f8fafc}
*{box-sizing:border-box}
body{margin:0;padding:48px 24px;background:#fff;color:var(--dsw-alias-label-primary);font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:860px;margin:0 auto}
h1,h2,h3{line-height:1.3}
table{border-collapse:collapse;width:100%;margin:16px 0}
th,td{border:1px solid var(--dsw-alias-border-l3);padding:6px 10px;text-align:left}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:90%;background:#f3f4f6;padding:2px 4px;border-radius:4px}
pre{background:#f3f4f6;padding:12px;overflow:auto;border-radius:8px}
pre code{background:transparent;padding:0}
figure{margin:20px 0;padding:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px}
figure svg{display:block;width:100%;height:auto}
figcaption{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:6px}
.missing{padding:16px;border:1px dashed var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);border-radius:8px}
@media print{body{padding:0}figure{break-inside:avoid}}
`

export interface ReportHtmlInput {
  readonly title: string
  readonly markdown: string
  /** chart card id → serialized SVG markup */
  readonly charts: ReadonlyMap<string, string>
  /** chart card id → card title */
  readonly chartTitles?: ReadonlyMap<string, string>
}

/** Split markdown on `{{chart:<id>}}` embeds and render each chunk. */
export function buildReportHtml({ title, markdown, charts, chartTitles }: ReportHtmlInput): string {
  const parts = markdown.split(/(\{\{chart:[^}]+\}\})/g)
  const body = parts.map((part) => {
    const match = /^\{\{chart:(.+)\}\}$/.exec(part)
    if (match === null) return part.trim() === '' ? '' : marked.parse(part, { async: false }) as string
    const id = match[1]!
    const svg = charts.get(id)
    if (svg === undefined) return '<div class="missing">Chart unavailable</div>'
    const caption = chartTitles?.get(id)
    return `<figure>${svg}${caption === undefined ? '' : `<figcaption>${escapeHtml(caption)}</figcaption>`}</figure>`
  }).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
