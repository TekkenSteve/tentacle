import { describe, expect, it } from 'vitest'
import { buildReportHtml } from '../src/client/console/report-export.js'

describe('report HTML export', () => {
  it('renders markdown and inlines chart SVG', () => {
    const html = buildReportHtml({
      title: 'Revenue <Q1>',
      markdown: '# Revenue\n\n| month | revenue |\n| --- | --- |\n| Jan | 10 |\n\n{{chart:card-1}}',
      charts: new Map([['card-1', '<svg id="chart"></svg>']]),
      chartTitles: new Map([['card-1', 'Revenue chart']]),
    })
    expect(html).toContain('<title>Revenue &lt;Q1&gt;</title>')
    expect(html).toContain('<h1>Revenue</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('<svg id="chart"></svg>')
    expect(html).toContain('<figcaption>Revenue chart</figcaption>')
    expect(html).not.toContain('{{chart:card-1}}')
  })

  it('renders a missing-chart placeholder', () => {
    const html = buildReportHtml({ title: 'x', markdown: 'Before\n\n{{chart:missing}}', charts: new Map() })
    expect(html).toContain('Chart unavailable')
  })
})
