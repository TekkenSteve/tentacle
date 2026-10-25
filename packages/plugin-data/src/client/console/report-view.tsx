/**
 * Reports view — the second tab of Data Studio (Explore | Reports).
 *
 * A report is Markdown with `{{chart:<cardId>}}` embeds, persisted in the data
 * workspace. The preview renders prose through the official MarkdownText
 * primitive and chart embeds through the same ChartView the thread uses, so a
 * report never duplicates chart state.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  IconEditOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  MarkdownText,
  Modal,
  SegmentedControl,
  Toast,
  writeClipboard,
  type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fmt, type Translate } from '../locales.ts'
import {
  createReport,
  errorText,
  removeReport,
  updateReport,
  type ChartCard,
  type DataReport,
  type DataState,
  type DatasetRows,
} from './api.ts'
import { ChartView } from './charts.tsx'
import { ReportMarkdownEditor } from './report-editor.tsx'
import { downloadText, safeFilename } from './export.ts'
import { buildReportHtml } from './report-export.ts'
import { colors, styles } from './ui.ts'

interface ReportsViewProps {
  t: Translate
  state: DataState
  workspaceId: string
  activeThreadId?: string
  rowsOf: (datasetId: string) => DatasetRows | undefined
  onChanged: () => Promise<void>
}

interface ReportToast { text: string; seq: number }

function generateMarkdown(t: Translate, state: DataState, threadId: string): { title: string; markdown: string } {
  const thread = state.threads.find((row) => row.id === threadId)
  const name = thread?.name ?? t('data.report.untitled')
  const cards = state.cards.filter((card) => card.threadId === threadId)
  const charts = cards.filter((card): card is ChartCard => card.kind === 'chart')
  const notes = cards.filter((card) => card.kind === 'note')
  const lines: string[] = [
    `# ${name}`,
    '',
    `> ${fmt(t('data.report.generatedIntro'), { name })}`,
    '',
  ]
  for (const note of notes) {
    lines.push(note.text, '')
  }
  for (const chart of charts) {
    lines.push(`## ${chart.title}`, '', `{{chart:${chart.id}}}`, '')
  }
  if (charts.length === 0) lines.push('_No chart cards in this thread yet._', '')
  return {
    title: fmt(t('data.report.generatedTitle'), { name }),
    markdown: lines.join('\n'),
  }
}

function ReportPreview({ t, report, state, rowsOf }: {
  t: Translate
  report: DataReport
  state: DataState
  rowsOf: (datasetId: string) => DatasetRows | undefined
}): ReactElement {
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('data.markdown.copy'), copiedLabel: t('data.markdown.copied') },
    footnotes: t('data.markdown.footnotes'),
  }), [t])
  const parts = report.markdown.split(/(\{\{chart:[^}]+\}\})/g)
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 860 }}>
      {parts.map((part, index) => {
        const match = /^\{\{chart:(.+)\}\}$/.exec(part)
        if (match === null) {
          return part.trim() === '' ? null : (
            <div key={index} style={{ fontSize: 13, lineHeight: 1.75 }}>
              <MarkdownText text={part} labels={labels} />
            </div>
          )
        }
        const card = state.cards.find((candidate) => candidate.id === match[1] && candidate.kind === 'chart')
        if (card === undefined || card.kind !== 'chart') {
          return <p key={index} style={styles.help}>{t('data.report.chartMissing')}</p>
        }
        return (
          <div key={index} data-report-chart-id={card.id} style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 10, background: colors.layer1 }}>
            <p style={{ ...styles.hint, margin: '0 0 6px', fontWeight: 600 }}>{card.title}</p>
            <ChartView card={card} rows={rowsOf(card.datasetId)} height={240} extraFilters={state.threads.find((thread) => thread.id === card.threadId)?.filters} extraRanges={state.threads.find((thread) => thread.id === card.threadId)?.ranges} />
          </div>
        )
      })}
    </div>
  )
}

export function ReportsView({ t, state, workspaceId, activeThreadId, rowsOf, onChanged }: ReportsViewProps): ReactElement {
  const reports = state.reports.filter((report) => report.workspaceId === workspaceId)
  const [selectedId, setSelectedId] = useState<string | undefined>(reports[0]?.id)
  const selected = reports.find((report) => report.id === selectedId) ?? reports[0]
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(selected?.title ?? '')
  const [draftMarkdown, setDraftMarkdown] = useState(selected?.markdown ?? '')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<ReportToast | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const show = (text: string): void => setToast((current) => ({ text, seq: (current?.seq ?? 0) + 1 }))

  // A deletion can move selection to another report; keep drafts in sync when
  // the selected id changes (not on every reload of the same report).
  useEffect(() => {
    if (selected === undefined) return
    setDraftTitle(selected.title)
    setDraftMarkdown(selected.markdown)
  }, [selected?.id])

  const pick = (report: DataReport): void => {
    setSelectedId(report.id)
    setDraftTitle(report.title)
    setDraftMarkdown(report.markdown)
    setEditing(false)
  }

  const create = async (generated: { title: string; markdown: string } | undefined): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const report = await createReport({
        workspaceId,
        ...(activeThreadId === undefined ? {} : { threadId: activeThreadId }),
        title: generated?.title ?? t('data.report.untitled'),
        markdown: generated?.markdown ?? '# 新报告\n',
      })
      await onChanged()
      setSelectedId(report.id)
      setDraftTitle(report.title)
      setDraftMarkdown(report.markdown)
      setEditing(true)
      show(t('data.report.created'))
    } catch (error) {
      show(errorText(t, error))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (selected === undefined || busy) return
    setBusy(true)
    try {
      const updated = await updateReport({ id: selected.id, title: draftTitle.trim() || t('data.report.untitled'), markdown: draftMarkdown })
      await onChanged()
      setSelectedId(updated.id)
      setDraftTitle(updated.title)
      setDraftMarkdown(updated.markdown)
      setEditing(false)
      show(t('data.report.updated'))
    } catch (error) {
      show(errorText(t, error))
    } finally {
      setBusy(false)
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (selected === undefined || busy) return
    setBusy(true)
    try {
      await removeReport(selected.id)
      await onChanged()
      setSelectedId(undefined)
      setEditing(false)
      setConfirmDelete(false)
      show(t('data.report.deleted'))
    } catch (error) {
      show(errorText(t, error))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (selected === undefined) return
    try {
      await writeClipboard(selected.markdown)
      show(t('data.report.markdownCopied'))
    } catch (error) {
      show(String(error))
    }
  }

  const collectCharts = (): { charts: Map<string, string>; titles: Map<string, string> } => {
    const charts = new Map<string, string>()
    const titles = new Map<string, string>()
    for (const wrapper of document.querySelectorAll('[data-report-chart-id]')) {
      const id = wrapper.getAttribute('data-report-chart-id')
      const svg = wrapper.querySelector('svg')
      if (id !== null && svg !== null) charts.set(id, svg.outerHTML)
      const card = state.cards.find((candidate) => candidate.id === id)
      if (id !== null && card !== undefined) titles.set(id, card.title)
    }
    return { charts, titles }
  }

  const exportHtml = async (): Promise<void> => {
    if (selected === undefined) return
    if (editing) {
      setEditing(false)
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    const { charts, titles } = collectCharts()
    const html = buildReportHtml({ title: selected.title, markdown: selected.markdown, charts, chartTitles: titles })
    downloadText(`${safeFilename(selected.title)}.html`, html, 'text/html;charset=utf-8')
    show(t('data.report.exported'))
  }

  const printPdf = async (): Promise<void> => {
    if (selected === undefined) return
    if (editing) {
      setEditing(false)
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    const { charts, titles } = collectCharts()
    const html = buildReportHtml({ title: selected.title, markdown: selected.markdown, charts, chartTitles: titles })
    const win = window.open('', '_blank')
    if (win === null) { show(t('data.report.printBlocked')); return }
    win.document.open()
    win.document.write(html)
    win.document.close()
    win.focus()
    win.print()
  }

  const download = (): void => {
    if (selected === undefined) return
    const blob = new Blob([selected.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${selected.title.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'report'}.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="tentacle-data-reports" style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 12, minHeight: 520 }}>
      <aside style={{ ...styles.side, maxHeight: 'calc(100vh - 300px)' }}>
        <div style={styles.sideHeader}>
          <h3 style={styles.sideTitle}>{t('data.report.title')}</h3>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="toolbar" aria-label={t('data.report.fromThread')} title={t('data.report.fromThread')} disabled={activeThreadId === undefined || busy} icon={<IconRefreshOutlineRegular size={14} />} onClick={() => void create(generateMarkdown(t, state, activeThreadId!))} />
          <Button size="sm" variant="toolbar" aria-label={t('data.report.untitled')} title={t('data.report.untitled')} icon={<IconPlusOutlineRegular size={14} />} onClick={() => void create(undefined)} />
        </div>
        {reports.length === 0
          ? <div style={styles.empty}><p style={styles.emptyTitle}>{t('data.report.empty')}</p><p style={styles.help}>{t('data.report.emptyHint')}</p></div>
          : reports.map((report) => (
            <button
              key={report.id}
              type="button"
              onClick={() => pick(report)}
              style={{
                ...styles.datasetCard,
                borderColor: report.id === selected?.id ? colors.accent : colors.border,
                textAlign: 'left',
                color: 'inherit',
              }}
            >
              <span style={styles.datasetName}>{report.title}</span>
              <span style={styles.tiny}>{new Date(report.updatedAt).toLocaleString()}</span>
            </button>
          ))}
      </aside>

      <section style={{ ...styles.inspector, maxHeight: 'calc(100vh - 300px)', gap: 12 }}>
        {selected === undefined
          ? (
            <div style={styles.empty}>
              <p style={styles.emptyTitle}>{t('data.report.empty')}</p>
              <p style={styles.help}>{t('data.report.emptyHint')}</p>
              <Button variant="primary" disabled={activeThreadId === undefined || busy} onClick={() => void create(generateMarkdown(t, state, activeThreadId!))}>{t('data.report.fromThread')}</Button>
            </div>
          )
          : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <h3 style={{ ...styles.title, fontSize: 15 }}>{selected.title}</h3>
                <span style={{ flex: 1 }} />
                <SegmentedControl
                  id="tentacle-data-report-mode"
                  value={editing ? 'edit' : 'preview'}
                  options={[{ value: 'preview', label: t('data.report.preview') }, { value: 'edit', label: t('data.report.edit') }]}
                  label={t('data.report.title')}
                  onChange={(next) => {
                    if (next === 'edit') {
                      setDraftTitle(selected.title)
                      setDraftMarkdown(selected.markdown)
                    }
                    setEditing(next === 'edit')
                  }}
                />
                <Button size="sm" variant="ghost" onClick={() => void copy()}>{t('data.report.copy')}</Button>
                <Button size="sm" variant="ghost" onClick={download}>{t('data.report.download')}</Button>
                <Button size="sm" variant="ghost" onClick={() => void exportHtml()}>{t('data.report.exportHtml')}</Button>
                <Button size="sm" variant="ghost" onClick={() => void printPdf()}>{t('data.report.printPdf')}</Button>
                <Button size="sm" variant="ghost" icon={<IconTrashOutlineRegular size={13} />} style={{ color: colors.danger }} aria-label={t('data.report.delete')} onClick={() => setConfirmDelete(true)} />
              </div>

              {editing
                ? (
                  <div style={{ display: 'grid', gap: 8, minHeight: 0 }}>
                    <Input aria-label={t('data.report.title')} value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
                    <ReportMarkdownEditor
                      t={t}
                      value={draftMarkdown}
                      charts={state.cards.filter((card): card is ChartCard => card.kind === 'chart' && state.threads.some((thread) => thread.id === card.threadId && thread.workspaceId === workspaceId))}
                      onChange={setDraftMarkdown}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={styles.help}>{t('data.report.hint')}</span>
                      <span style={{ flex: 1 }} />
                      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('data.action.cancel')}</Button>
                      <Button size="sm" variant="primary" disabled={busy} icon={<IconEditOutlineRegular size={13} />} onClick={() => void save()}>{t('data.report.save')}</Button>
                    </div>
                  </div>
                )
                : <ReportPreview t={t} report={{ ...selected, title: draftTitle, markdown: draftMarkdown }} state={state} rowsOf={rowsOf} />}
            </>
          )}
      </section>

      {confirmDelete && (
        <Modal
          open
          onClose={() => setConfirmDelete(false)}
          title={t('data.report.delete')}
          closeLabel={t('data.action.close')}
          description={selected?.title}
          className="tentacle-data-dialog"
          footer={(
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('data.action.cancel')}</Button>
              <Button variant="primary" style={{ background: colors.danger }} onClick={() => void deleteSelected()}>{t('data.action.delete')}</Button>
            </div>
          )}
        >
          <p style={styles.hint}>{selected?.title}</p>
        </Modal>
      )}
      {toast !== undefined && <Toast key={toast.seq} text={toast.text} onDone={() => setToast(undefined)} />}
    </div>
  )
}
