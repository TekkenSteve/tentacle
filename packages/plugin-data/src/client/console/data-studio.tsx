/**
 * Data Studio — the global data workspace panel.
 *
 * Layout follows Data Formulator's three-part shape:
 *   data sources (left) · thread board (center) · inspector (right)
 * Threads are columns; cards are the visible analysis story. All mutations go
 * through the host admin API and reload the persisted state.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import {
  Button,
  IconApiOutlineRegular,
  IconBranchOutlineRegular,
  IconChevronRightOutlineRegular,
  IconDatabaseOutlineRegular,
  IconEditOutlineRegular,
  IconEnhanceOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconGlobeOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconSlidersTwoOutlineRegular,
  IconSendOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Modal,
  SegmentedControl,
  Tag,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fmt, type DataStudioLocaleKey, type Translate } from '../locales.ts'
import {
  askAgentStream,
  closeDuckDb,
  closeSqlite,
  createCard,
  createRelation,
  createThread,
  listRelationSuggestions,
  createWorkspace,
  deriveDataset,
  importSqlite,
  importUrl,
  importDatabase,
  importDatabaseQuery,
  importDuckDb,
  importObject,
  importWorkspaceFile,
  listConnections,
  listDatabaseTables,
  listObjectStore,
  listWorkspaceFiles,
  listWorkspaceSources,
  saveConnection,
  joinDatasets,
  openDuckDb,
  openSqlite,
  errorText,
  forkThread,
  importDataset,
  loadDatasetRows,
  loadState,
  removeCard,
  refineChart,
  refreshDataset,
  removeDataset,
  setThreadFilters,
  setAutoRefresh,
  removeRelation,
  removeThread,
  renameThread,
  updateCard,
  type AggregateFunction,
  type ChartAggregate,
  type ChartAnnotations,
  type ChartRange,
  type ChartSort,
  type ChartCard,
  type ChartFilter,
  type ChartKind,
  type ChartSpec,
  type ChartTheme,
  type DataCard,
  type DataOperation,
  type DataRelation,
  type DataState,
  type RelationSuggestion,
  type DatasetCard,
  type DatasetMeta,
  type DatasetRows,
  type DataThread,
  type DataConnectionProfile,
  type DatabaseConfig,
  type DatabaseEngine,
  type DatabaseTable,
  type FilterOperator,
  type ObjectEntry,
  type ObjectStoreConfig,
  type ObjectStoreProvider,
  type JoinKind,
  type WorkspaceFileEntry,
  type WorkspaceFileListing,
  type WorkspaceSource,
  type DataWorkspace,
  type NoteCard,
  type PlanCard,
} from './api.ts'
import { recommendCharts, type ChartRecommendation } from '../../shared/recommend.ts'
import { ChartView } from './charts.tsx'
import { downloadChartPng, downloadText, rowsToCsv, safeFilename } from './export.ts'
import { ReportsView } from './report-view.tsx'
import { flintOptions, isFlintChart } from './flint-chart.tsx'
import { colors, styles } from './ui.ts'

interface ToastMessage { readonly text: string; readonly tone?: 'success'; readonly seq: number }

function useToast(): { toast: ToastMessage | undefined; show: (text: string, tone?: 'success') => void; done: () => void } {
  const [toast, setToast] = useState<ToastMessage | undefined>(undefined)
  const show = (text: string, tone?: 'success'): void => {
    setToast((current) => ({ text, ...(tone === undefined ? {} : { tone }), seq: (current?.seq ?? 0) + 1 }))
  }
  return { toast, show, done: () => setToast(undefined) }
}

function datasetOf(state: DataState, datasetId: string): DatasetMeta | undefined {
  return state.datasets.find((dataset) => dataset.id === datasetId)
}

function threadOf(state: DataState, threadId: string): DataThread | undefined {
  return state.threads.find((thread) => thread.id === threadId)
}

function cardsOf(state: DataState, threadId: string): readonly DataCard[] {
  return state.cards.filter((card) => card.threadId === threadId)
}

function chartCount(state: DataState): number {
  return state.cards.filter((card) => card.kind === 'chart').length
}

function DefaultCardHeader({ card, onOpen, onDelete }: { card: DataCard; onOpen: () => void; onDelete: () => void }): ReactElement {
  return (
    <div style={styles.cardHeader}>
      <button type="button" onClick={onOpen} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', color: 'inherit', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
        <IconChevronRightOutlineRegular size={12} />
        <span style={styles.cardTitle}>{card.title}</span>
      </button>
      <Button size="sm" variant="ghost" aria-label="delete card" icon={<IconTrashOutlineRegular size={12} />} onClick={onDelete} style={{ color: colors.danger }} />
    </div>
  )
}

// ---- table preview ----

function DatasetTable({ rows, t }: { rows: DatasetRows | undefined; t: Translate }): ReactElement {
  if (rows === undefined) return <p style={styles.help}>{t('data.table.empty')}</p>
  if (rows.rows.length === 0) return <p style={styles.help}>{t('data.table.empty')}</p>
  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead><tr>{rows.columns.map((column) => <th key={column.name} style={styles.th}>{column.name}</th>)}</tr></thead>
        <tbody>
          {rows.rows.slice(0, 20).map((row, index) => (
            <tr key={index}>
              {rows.columns.map((column) => (
                <td key={column.name} style={styles.td} title={String(row[column.name] ?? '')}>
                  {row[column.name] === null || row[column.name] === undefined ? '—' : String(row[column.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

// ---- dialogs ----

function NameDialog({ t, title, label, initial, onSubmit, onClose }: {
  t: Translate
  title: string
  label: string
  initial?: string
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState(initial ?? '')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button variant="primary" disabled={busy || name.trim() === ''} onClick={() => {
            setBusy(true)
            void onSubmit(name.trim()).finally(() => setBusy(false))
          }}>{t('data.action.create')}</Button>
        </div>
      )}
    >
      <form onSubmit={(event) => { event.preventDefault() }}>
        <label style={styles.field}>
          <span style={styles.label}>{label}</span>
          <Input aria-label={label} value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
      </form>
    </Modal>
  )
}

function ConfirmDialog({ t, title, description, onConfirm, onClose }: {
  t: Translate
  title: string
  description: string
  onConfirm: () => void
  onClose: () => void
}): ReactElement {
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      closeLabel={t('data.action.close')}
      description={description}
      className="tentacle-data-dialog"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button variant="primary" style={{ background: colors.danger }} onClick={onConfirm}>{t('data.action.delete')}</Button>
        </div>
      )}
    >
      <p style={styles.hint}>{description}</p>
    </Modal>
  )
}

function ImportDialog({ t, workspaceId, onImported, onClose }: {
  t: Translate
  workspaceId: string
  onImported: (dataset: DatasetMeta) => void
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'text' | 'url'>('text')
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [content, setContent] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = name.trim() !== '' && (mode === 'url' ? url.trim() !== '' : content.trim() !== '')
  const submit = async (): Promise<void> => {
    if (busy || !ready) return
    setBusy(true); setError('')
    try {
      const dataset = mode === 'url'
        ? await importUrl({ workspaceId, name: name.trim(), url: url.trim(), format })
        : await importDataset({ workspaceId, name: name.trim(), format, content })
      onImported(dataset)
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('data.dataset.import')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1, color: colors.danger, fontSize: 11 }}>{error}</span>
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button variant="primary" disabled={busy || !ready} onClick={() => void submit()}>{t('data.dataset.import')}</Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <SegmentedControl
          id="tentacle-data-import-mode"
          value={mode}
          options={[{ value: 'text', label: t('data.dataset.tab.text') }, { value: 'url', label: t('data.dataset.tab.url') }]}
          label={t('data.dataset.import')}
          onChange={setMode}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 10 }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.dataset.name')}</span>
            <Input aria-label={t('data.dataset.name')} value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.dataset.format')}</span>
            <select value={format} onChange={(event) => setFormat(event.target.value === 'json' ? 'json' : 'csv')} style={styles.input}>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
          </label>
        </div>
        {mode === 'url' ? (
          <>
            <label style={styles.field}>
              <span style={styles.label}>{t('data.dataset.url')}</span>
              <Input
                aria-label={t('data.dataset.url')}
                value={url}
                placeholder="https://example.com/data.csv"
                onChange={(event) => setUrl(event.target.value)}
                onBlur={() => {
                  if (name.trim() !== '') return
                  try {
                    const file = new URL(url).pathname.split('/').filter(Boolean).pop()
                    if (file !== undefined) setName(file.replace(/\.(csv|json)$/i, ''))
                  } catch { /* the host reports invalid URLs on submit */ }
                }}
                autoFocus
              />
            </label>
            <p style={styles.help}>{t('data.dataset.urlHint')}</p>
          </>
        ) : (
          <>
            <label style={styles.field}>
              <span style={styles.label}>{t('data.dataset.content')}</span>
              <textarea
                aria-label={t('data.dataset.content')}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder={format === 'csv' ? 'month,revenue\nJan,120\nFeb,180' : '[{"month":"Jan","revenue":120}]'}
                style={styles.textarea}
              />
            </label>
            <label style={{ ...styles.label, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span>{t('data.dataset.upload')}</span>
              <input
                type="file"
                accept=".csv,.json,text/csv,application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file === undefined) return
                  void file.text().then((text) => {
                    setContent(text)
                    if (name.trim() === '') setName(file.name.replace(/\.(csv|json)$/i, ''))
                    if (/\.json$/i.test(file.name)) setFormat('json')
                  })
                }}
              />
            </label>
          </>
        )}
      </div>
    </Modal>
  )
}

interface ChartDraft {
  threadId: string
  cardId?: string
  datasetId: string
  title: string
  chart: ChartKind
  x: string
  y: string
  color: string
  size: string
  facet: string
  value: string
  open: string
  high: string
  low: string
  close: string
  x2: string
  goal: string
  y2: string
  sort: ChartSort
  aggregate: ChartAggregate
  theme: ChartTheme
}

function ChartDialog({ t, draft, datasets, rowsOf, onSubmit, onClose }: {
  t: Translate
  draft: ChartDraft
  datasets: readonly DatasetMeta[]
  rowsOf: (datasetId: string) => DatasetRows | undefined
  onSubmit: (draft: ChartDraft) => Promise<void>
  onClose: () => void
}): ReactElement {
  const [form, setForm] = useState<ChartDraft>(draft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const rows = rowsOf(form.datasetId)
  const columns = rows?.columns ?? []
  const set = (patch: Partial<ChartDraft>): void => setForm((current) => ({ ...current, ...patch }))
  useEffect(() => {
    if (columns.length === 0) return
    if (!columns.some((column) => column.name === form.x)) set({ x: columns[0]!.name })
    if (!columns.some((column) => column.name === form.y)) {
      const measure = columns.find((column) => column.type === 'number')
      set({ y: measure?.name ?? columns[0]!.name })
    }
  }, [columns, form.x, form.y])
  return (
    <Modal
      open
      onClose={onClose}
      title={form.cardId === undefined ? t('data.chart.new') : t('data.chart.edit')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1, color: colors.danger, fontSize: 11 }}>{error}</span>
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy || form.datasetId === '' || form.x === ''}
            onClick={() => {
              setBusy(true); setError('')
              void onSubmit(form).catch((err: unknown) => setError(errorText(t, err))).finally(() => setBusy(false))
            }}
          >
            {form.cardId === undefined ? t('data.chart.create') : t('data.chart.save')}
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.chart.title')}</span>
            <Input aria-label={t('data.chart.title')} value={form.title} onChange={(event) => set({ title: event.target.value })} />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.thread.dataset')}</span>
            <select
              value={form.datasetId}
              onChange={(event) => set({ datasetId: event.target.value, x: '', y: '' })}
              style={styles.input}
            >
              {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.chart.kind')}</span>
            <select value={form.chart} onChange={(event) => set({ chart: event.target.value as ChartKind })} style={styles.input}>
              <option value="bar">{t('data.chart.bar')}</option>
              <option value="line">{t('data.chart.line')}</option>
              <option value="area">{t('data.chart.area')}</option>
              <option value="scatter">{t('data.chart.scatter')}</option>
              <option value="pie">{t('data.chart.pie')}</option>
              <option value="donut">{t('data.chart.donut')}</option>
              <option value="horizontalBar">{t('data.chart.horizontalBar')}</option>
        <option value="heatmap">{t('data.chart.heatmap')}</option>
              <option value="heatmap">{t('data.chart.heatmap')}</option>
              <option value="boxplot">{t('data.chart.boxplot')}</option>
              <option value="bump">{t('data.chart.bump')}</option>
              <option value="streamgraph">{t('data.chart.streamgraph')}</option>
              <option value="waterfall">{t('data.chart.waterfall')}</option>
              <option value="rose">{t('data.chart.rose')}</option>
              <option value="radar">{t('data.chart.radar')}</option>
              <option value="groupedBar">{t('data.chart.groupedBar')}</option>
              <option value="stackedBar">{t('data.chart.stackedBar')}</option>
              <option value="candlestick">{t('data.chart.candlestick')}</option>
              <option value="gantt">{t('data.chart.gantt')}</option>
              <option value="histogram">{t('data.chart.histogram')}</option>
              <option value="density">{t('data.chart.density')}</option>
              <option value="violin">{t('data.chart.violin')}</option>
              <option value="kpi">{t('data.chart.kpi')}</option>
              <option value="rangeArea">{t('data.chart.rangeArea')}</option>
              <option value="bullet">{t('data.chart.bullet')}</option>
              <option value="barTable">{t('data.chart.barTable')}</option>
              <option value="table">{t('data.chart.table')}</option>
              <option value="rangeDot">{t('data.chart.rangeDot')}</option>
              <option value="map">{t('data.chart.map')}</option>
              <option value="choropleth">{t('data.chart.choropleth')}</option>
              <option value="marginal">{t('data.chart.marginal')}</option>
              <option value="regression">{t('data.chart.regression')}</option>
              <option value="connectedScatter">{t('data.chart.connectedScatter')}</option>
              <option value="strip">{t('data.chart.strip')}</option>
              <option value="lollipop">{t('data.chart.lollipop')}</option>
              <option value="pyramid">{t('data.chart.pyramid')}</option>
              <option value="slope">{t('data.chart.slope')}</option>
              <option value="sparkline">{t('data.chart.sparkline')}</option>
              <option value="ridgeline">{t('data.chart.ridgeline')}</option>
              <option value="ecdf">{t('data.chart.ecdf')}</option>
              <option value="calendarHeatmap">{t('data.chart.calendarHeatmap')}</option>

            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.chart.x')}</span>
            <select value={form.x} onChange={(event) => set({ x: event.target.value })} style={styles.input}>
              {columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.chart.y')}</span>
            <select value={form.y} onChange={(event) => set({ y: event.target.value })} style={styles.input}>
              {columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.chart.color')}</span>
            <select value={form.color} onChange={(event) => set({ color: event.target.value })} style={styles.input}>
              <option value="">{t('data.chart.noChannel')}</option>
              {columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.chart.size')}</span>
            <select value={form.size} onChange={(event) => set({ size: event.target.value })} style={styles.input} disabled={form.chart !== 'scatter'}>
              <option value="">{t('data.chart.noChannel')}</option>
              {columns.filter((column) => column.type === 'number').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </label>
        </div>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.facet')}</span>
          <select value={form.facet} onChange={(event) => set({ facet: event.target.value })} style={styles.input}>
            <option value="">{t('data.chart.noChannel')}</option>
            {columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.value')}</span>
          <select value={form.value} onChange={(event) => set({ value: event.target.value })} style={styles.input} disabled={form.chart !== 'heatmap'}>
            <option value="">{t('data.chart.noChannel')}</option>
            {columns.filter((column) => column.type === 'number').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
          </select>
        </label>
        {form.chart === 'candlestick' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
            {(['open', 'high', 'low', 'close'] as const).map((key) => (
              <label key={key} style={styles.field}>
                <span style={styles.label}>{t(`data.chart.${key}` as DataStudioLocaleKey)}</span>
                <select value={form[key]} onChange={(event) => set({ [key]: event.target.value })} style={styles.input}>
                  <option value="">{t('data.chart.noChannel')}</option>
                  {columns.filter((column) => column.type === 'number').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}
        {(form.chart === 'kpi' || form.chart === 'bullet') && (
          <label style={styles.field}>
            <span style={styles.label}>{t('data.chart.goal')}</span>
            <select value={form.goal} onChange={(event) => set({ goal: event.target.value })} style={styles.input}>
              <option value="">{t('data.chart.noChannel')}</option>
              {columns.filter((column) => column.type === 'number').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </label>
        )}
        {form.chart === 'rangeArea' && (
          <label style={styles.field}>
            <span style={styles.label}>{t('data.chart.y2')}</span>
            <select value={form.y2} onChange={(event) => set({ y2: event.target.value })} style={styles.input}>
              <option value="">{t('data.chart.noChannel')}</option>
              {columns.filter((column) => column.type === 'number').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </label>
        )}
        {form.chart === 'gantt' && (
          <label style={styles.field}>
            <span style={styles.label}>{t('data.chart.x2')}</span>
            <select value={form.x2} onChange={(event) => set({ x2: event.target.value })} style={styles.input}>
              <option value="">{t('data.chart.noChannel')}</option>
              {columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </label>
        )}
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.sort')}</span>
          <select value={form.sort} onChange={(event) => set({ sort: event.target.value as ChartSort })} style={styles.input}>
            <option value="none">{t('data.chart.sortNone')}</option>
            <option value="asc">{t('data.chart.sortAsc')}</option>
            <option value="desc">{t('data.chart.sortDesc')}</option>
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.aggregate')}</span>
          <select value={form.aggregate} onChange={(event) => set({ aggregate: event.target.value as ChartAggregate })} style={styles.input}>
            <option value="sum">{t('data.chart.sum')}</option>
            <option value="avg">{t('data.chart.avg')}</option>
            <option value="count">{t('data.chart.count')}</option>
            <option value="none">{t('data.chart.none')}</option>
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.theme')}</span>
          <select value={form.theme} onChange={(event) => set({ theme: event.target.value as ChartTheme })} style={styles.input}>
            <option value="default">{t('data.theme.default')}</option>
            <option value="warm">{t('data.theme.warm')}</option>
            <option value="cool">{t('data.theme.cool')}</option>
            <option value="mono">{t('data.theme.mono')}</option>
          </select>
        </label>
        {rows !== undefined && <DatasetTable rows={rows} t={t} />}
      </div>
    </Modal>
  )
}

function joinSummary(join: NonNullable<DatasetMeta['join']>, datasets: readonly DatasetMeta[]): string {
  const left = datasets.find((dataset) => dataset.id === join.leftDatasetId)
  const right = datasets.find((dataset) => dataset.id === join.rightDatasetId)
  return `${join.how} join ${left?.name ?? join.leftDatasetId}.${join.leftColumn} = ${right?.name ?? join.rightDatasetId}.${join.rightColumn}`
}

function recommendationReason(t: Translate, spec: ChartSpec): string {
  if (spec.chart === 'line') return fmt(t('data.recommend.line'), { x: spec.x, y: spec.y ?? '' })
  if (spec.chart === 'scatter') return fmt(t('data.recommend.scatter'), { x: spec.x, y: spec.y ?? '' })
  if (spec.aggregate === 'count') return fmt(t('data.recommend.count'), { x: spec.x })
  if (spec.chart === 'pie') return fmt(t('data.recommend.pie'), { x: spec.x, y: spec.y ?? '' })
  return fmt(t('data.recommend.bar'), { x: spec.x, y: spec.y ?? '' })
}

function operationSummary(operation: DataOperation): string {
  if (operation.kind === 'filter') return `filter ${operation.column} ${operation.op} ${String(operation.value)}`
  return `group by ${operation.groupBy.join(', ')} → ${operation.aggregates.map((aggregate) => `${aggregate.fn}(${aggregate.column})`).join(', ')}`
}

function DeriveDialog({ t, dataset, onSubmit, onClose }: {
  t: Translate
  dataset: DatasetMeta
  onSubmit: (name: string, operation: DataOperation) => Promise<void>
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState(`${dataset.name} · 派生`)
  const [mode, setMode] = useState<'group' | 'filter'>('group')
  const numeric = dataset.columns.find((column) => column.type === 'number') ?? dataset.columns[0]
  const [groupBy, setGroupBy] = useState<string[]>([dataset.columns[0]?.name ?? ''])
  const [aggColumn, setAggColumn] = useState(numeric?.name ?? '')
  const [aggFn, setAggFn] = useState<AggregateFunction>('sum')
  const [filterColumn, setFilterColumn] = useState(dataset.columns[0]?.name ?? '')
  const [filterOp, setFilterOp] = useState<FilterOperator>('eq')
  const [filterValue, setFilterValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const filterType = dataset.columns.find((column) => column.name === filterColumn)?.type
  const disabled = busy || name.trim() === '' || (mode === 'group' ? groupBy.length === 0 || aggColumn === '' : filterValue === '')

  const submit = async (): Promise<void> => {
    if (disabled) return
    setBusy(true); setError('')
    try {
      const operation: DataOperation = mode === 'group'
        ? { kind: 'group', groupBy, aggregates: [{ column: aggColumn, fn: aggFn }] }
        : {
          kind: 'filter',
          column: filterColumn,
          op: filterOp,
          value: filterType === 'number' && Number.isFinite(Number(filterValue)) ? Number(filterValue) : filterValue,
        }
      await onSubmit(name.trim(), operation)
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('data.derive.title')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1, color: colors.danger, fontSize: 11 }}>{error}</span>
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button variant="primary" disabled={disabled} onClick={() => void submit()}>{t('data.derive.create')}</Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 10 }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.derive.name')}</span>
            <Input aria-label={t('data.derive.name')} value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.derive.mode')}</span>
            <select value={mode} onChange={(event) => setMode(event.target.value === 'filter' ? 'filter' : 'group')} style={styles.input}>
              <option value="group">{t('data.derive.group')}</option>
              <option value="filter">{t('data.derive.filter')}</option>
            </select>
          </label>
        </div>

        {mode === 'group' ? (
          <>
            <div style={styles.field}>
              <span style={styles.label}>{t('data.derive.groupBy')}</span>
              <div style={{ ...styles.tableWrap, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', gap: 10, maxHeight: 130 }}>
                {dataset.columns.map((column) => (
                  <label key={column.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: colors.secondary }}>
                    <input
                      type="checkbox"
                      checked={groupBy.includes(column.name)}
                      onChange={(event) => setGroupBy((current) => event.target.checked
                        ? [...current, column.name]
                        : current.filter((value) => value !== column.name))}
                    />
                    {column.name}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 10 }}>
              <label style={styles.field}>
                <span style={styles.label}>{t('data.derive.aggregate')}</span>
                <select value={aggColumn} onChange={(event) => setAggColumn(event.target.value)} style={styles.input}>
                  {dataset.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                </select>
              </label>
              <label style={styles.field}>
                <span style={styles.label}>{t('data.derive.fn')}</span>
                <select value={aggFn} onChange={(event) => setAggFn(event.target.value as AggregateFunction)} style={styles.input}>
                  <option value="sum">{t('data.fn.sum')}</option>
                  <option value="avg">{t('data.fn.avg')}</option>
                  <option value="count">{t('data.fn.count')}</option>
                  <option value="min">{t('data.fn.min')}</option>
                  <option value="max">{t('data.fn.max')}</option>
                </select>
              </label>
            </div>
          </>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 1fr', gap: 10 }}>
            <label style={styles.field}>
              <span style={styles.label}>{t('data.derive.filterColumn')}</span>
              <select value={filterColumn} onChange={(event) => setFilterColumn(event.target.value)} style={styles.input}>
                {dataset.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span style={styles.label}>{t('data.derive.operator')}</span>
              <select value={filterOp} onChange={(event) => setFilterOp(event.target.value as FilterOperator)} style={styles.input}>
                {(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'] as const).map((op) => (
                  <option key={op} value={op}>{t(`data.op.${op}` as DataStudioLocaleKey)}</option>
                ))}
              </select>
            </label>
            <label style={styles.field}>
              <span style={styles.label}>{t('data.derive.value')}</span>
              <Input aria-label={t('data.derive.value')} value={filterValue} onChange={(event) => setFilterValue(event.target.value)} />
            </label>
          </div>
        )}
        <p style={styles.help}>{t('data.derive.hint')}</p>
      </div>
    </Modal>
  )
}

function RelationDialog({ t, datasets, onSubmit, onClose }: {
  t: Translate
  datasets: readonly DatasetMeta[]
  onSubmit: (input: { leftDatasetId: string; leftColumn: string; rightDatasetId: string; rightColumn: string }) => Promise<void>
  onClose: () => void
}): ReactElement {
  const [leftId, setLeftId] = useState(datasets[0]?.id ?? '')
  const [rightId, setRightId] = useState(datasets[1]?.id ?? datasets[0]?.id ?? '')
  const [leftColumn, setLeftColumn] = useState('')
  const [rightColumn, setRightColumn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const left = datasets.find((dataset) => dataset.id === leftId)
  const right = datasets.find((dataset) => dataset.id === rightId)
  useEffect(() => {
    if (left === undefined) return
    setLeftColumn((current) => left.columns.some((column) => column.name === current) ? current : (left.columns[0]?.name ?? ''))
  }, [left?.id])
  useEffect(() => {
    if (right === undefined) return
    const same = right.columns.find((column) => column.name === leftColumn)?.name
    setRightColumn((current) => right.columns.some((column) => column.name === current) ? current : (same ?? right.columns[0]?.name ?? ''))
  }, [right?.id, leftColumn])
  const disabled = busy || left === undefined || right === undefined || left.id === right.id || leftColumn === '' || rightColumn === ''
  const submit = async (): Promise<void> => {
    if (disabled) return
    setBusy(true); setError('')
    try {
      await onSubmit({ leftDatasetId: left.id, leftColumn, rightDatasetId: right.id, rightColumn })
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('data.relation.add')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1, color: colors.danger, fontSize: 11 }}>{error}</span>
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button variant="primary" disabled={disabled} onClick={() => void submit()}>{t('data.relation.create')}</Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.relation.leftDataset')}</span>
            <select value={leftId} onChange={(event) => setLeftId(event.target.value)} style={styles.input}>
              {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.relation.rightDataset')}</span>
            <select value={rightId} onChange={(event) => setRightId(event.target.value)} style={styles.input}>
              {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.relation.leftColumn')}</span>
            <select value={leftColumn} onChange={(event) => setLeftColumn(event.target.value)} style={styles.input}>
              {left?.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.relation.rightColumn')}</span>
            <select value={rightColumn} onChange={(event) => setRightColumn(event.target.value)} style={styles.input}>
              {right?.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </label>
        </div>
        <p style={styles.help}>{t('data.relation.hint')}</p>
      </div>
    </Modal>
  )
}

function JoinDialog({ t, dataset, datasets, relations, onSubmit, onClose }: {
  t: Translate
  dataset: DatasetMeta
  datasets: readonly DatasetMeta[]
  relations: readonly DataRelation[]
  onSubmit: (input: { rightDatasetId: string; leftColumn: string; rightColumn: string; how: JoinKind; name: string }) => Promise<void>
  onClose: () => void
}): ReactElement {
  const candidates = datasets.filter((candidate) => candidate.id !== dataset.id)
  const [rightId, setRightId] = useState(candidates[0]?.id ?? '')
  const [leftColumn, setLeftColumn] = useState(dataset.columns[0]?.name ?? '')
  const [rightColumn, setRightColumn] = useState('')
  const [how, setHow] = useState<JoinKind>('left')
  const [name, setName] = useState(`${dataset.name} · 连接`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const right = candidates.find((candidate) => candidate.id === rightId)
  useEffect(() => {
    if (right === undefined) return
    const known = relations.find((relation) =>
      (relation.leftDatasetId === dataset.id && relation.rightDatasetId === right.id)
      || (relation.rightDatasetId === dataset.id && relation.leftDatasetId === right.id))
    const suggested = known?.leftDatasetId === dataset.id ? known.rightColumn : known?.leftColumn
    setRightColumn((current) => right.columns.some((column) => column.name === current)
      ? current
      : (suggested ?? right.columns.find((column) => column.name === leftColumn)?.name ?? right.columns[0]?.name ?? ''))
  }, [right?.id, leftColumn, relations])
  const disabled = busy || right === undefined || leftColumn === '' || rightColumn === '' || name.trim() === ''
  const submit = async (): Promise<void> => {
    if (disabled) return
    setBusy(true); setError('')
    try {
      await onSubmit({ rightDatasetId: right.id, leftColumn, rightColumn, how, name: name.trim() })
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('data.join.title')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1, color: colors.danger, fontSize: 11 }}>{error}</span>
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button variant="primary" disabled={disabled} onClick={() => void submit()}>{t('data.join.create')}</Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.join.name')}</span>
          <Input aria-label={t('data.join.name')} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.join.rightDataset')}</span>
          <select value={rightId} onChange={(event) => setRightId(event.target.value)} style={styles.input}>
            {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 160px', gap: 10 }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.join.leftColumn')}</span>
            <select value={leftColumn} onChange={(event) => setLeftColumn(event.target.value)} style={styles.input}>
              {dataset.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.join.rightColumn')}</span>
            <select value={rightColumn} onChange={(event) => setRightColumn(event.target.value)} style={styles.input}>
              {right?.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.join.how')}</span>
            <select value={how} onChange={(event) => setHow(event.target.value === 'inner' ? 'inner' : 'left')} style={styles.input}>
              <option value="left">{t('data.join.left')}</option>
              <option value="inner">{t('data.join.inner')}</option>
            </select>
          </label>
        </div>
        <p style={styles.help}>{t('data.join.hint')}</p>
      </div>
    </Modal>
  )
}

function SqliteDialog({ t, workspaceId, onImported, onClose }: {
  t: Translate
  workspaceId: string
  onImported: (dataset: DatasetMeta) => void
  onClose: () => void
}): ReactElement {
  const [kind, setKind] = useState<'sqlite' | 'duckdb'>('sqlite')
  const [connectorId, setConnectorId] = useState('')
  const [tables, setTables] = useState<readonly string[]>([])
  const [table, setTable] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = (): void => {
    if (connectorId !== '') {
      const closing = kind === 'duckdb' ? closeDuckDb(connectorId) : closeSqlite(connectorId)
      void closing.catch(() => undefined)
    }
    onClose()
  }
  const choose = async (file: File): Promise<void> => {
    setBusy(true); setError('')
    const nextKind = /\.duckdb$/i.test(file.name) ? 'duckdb' : 'sqlite'
    setKind(nextKind)
    try {
      const base64 = await fileToBase64(file)
      const opened = nextKind === 'duckdb' ? await openDuckDb(base64) : await openSqlite(base64)
      setConnectorId(opened.id)
      setTables(opened.tables)
      setTable(opened.tables[0] ?? '')
      setName(opened.tables[0] ?? file.name.replace(/\.(sqlite|db)$/i, ''))
    } catch (err) {
      setError(errorText(t, err))
    } finally {
      setBusy(false)
    }
  }
  const submit = async (): Promise<void> => {
    if (busy || connectorId === '' || table === '' || name.trim() === '') return
    setBusy(true); setError('')
    try {
      const dataset = kind === 'duckdb'
        ? await importDuckDb({ connectorId, table, workspaceId, name: name.trim() })
        : await importSqlite({ connectorId, table, workspaceId, name: name.trim() })
      const closing = kind === 'duckdb' ? closeDuckDb(connectorId) : closeSqlite(connectorId)
      void closing.catch(() => undefined)
      onImported(dataset)
    } catch (err) {
      setError(errorText(t, err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={close}
      title={t('data.connector.localDb')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1, color: colors.danger, fontSize: 11 }}>{error}</span>
          <Button variant="ghost" onClick={close}>{t('data.action.cancel')}</Button>
          <Button variant="primary" disabled={busy || connectorId === '' || table === '' || name.trim() === ''} onClick={() => void submit()}>
            {busy ? t('data.connector.importing') : t('data.connector.import')}
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <p style={styles.help}>{t('data.connector.localDbHint')}</p>
        <label style={{ ...styles.field, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={styles.label}>{t('data.connector.chooseDbFile')}</span>
          <input
            type="file"
            accept=".sqlite,.db,.duckdb,application/x-sqlite3,application/vnd.sqlite3,application/octet-stream"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file !== undefined) void choose(file)
            }}
          />
        </label>
        {busy && connectorId === '' && <p style={styles.help}>{t('data.connector.parsing')}</p>}
        {tables.length > 0 && (
          <>
            <p style={styles.help}>{fmt(t('data.connector.opened'), { n: String(tables.length) })}</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label style={styles.field}>
                <span style={styles.label}>{t('data.connector.table')}</span>
                <select value={table} onChange={(event) => setTable(event.target.value)} style={styles.input}>
                  {tables.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
                </select>
              </label>
              <label style={styles.field}>
                <span style={styles.label}>{t('data.connector.datasetName')}</span>
                <Input aria-label={t('data.connector.datasetName')} value={name} onChange={(event) => setName(event.target.value)} />
              </label>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function WorkspaceFileDialog({ t, workspaceId, onImported, onClose }: {
  t: Translate
  workspaceId: string
  onImported: (dataset: DatasetMeta) => void
  onClose: () => void
}): ReactElement {
  const [sources, setSources] = useState<readonly WorkspaceSource[] | undefined>(undefined)
  const [sourceId, setSourceId] = useState('')
  const [listing, setListing] = useState<WorkspaceFileListing | undefined>(undefined)
  const [selected, setSelected] = useState<WorkspaceFileEntry | undefined>(undefined)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void listWorkspaceSources().then((rows) => {
      if (cancelled) return
      setSources(rows)
      setSourceId(rows[0]?.id ?? '')
    }).catch((err: unknown) => {
      if (!cancelled) { setSources([]); setError(errorText(t, err)) }
    })
    return () => { cancelled = true }
  }, [t])

  useEffect(() => {
    if (sourceId === '') return
    let cancelled = false
    setBusy(true); setError(''); setSelected(undefined); setListing(undefined)
    void listWorkspaceFiles(sourceId, '').then((next) => {
      if (!cancelled) setListing(next)
    }).catch((err: unknown) => {
      if (!cancelled) setError(errorText(t, err))
    }).finally(() => {
      if (!cancelled) setBusy(false)
    })
    return () => { cancelled = true }
  }, [sourceId, t])

  const navigate = async (path: string): Promise<void> => {
    if (sourceId === '' || busy) return
    setBusy(true); setError(''); setSelected(undefined)
    try {
      setListing(await listWorkspaceFiles(sourceId, path))
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }

  const submit = async (): Promise<void> => {
    if (busy || selected === undefined || sourceId === '') return
    setBusy(true); setError('')
    try {
      const dataset = await importWorkspaceFile({
        dataWorkspaceId: workspaceId,
        dshWorkspaceId: sourceId,
        path: selected.path,
        name: name.trim() || selected.name.replace(/\.(csv|json)$/i, ''),
      })
      onImported(dataset)
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('data.connector.workspace')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1, color: colors.danger, fontSize: 11 }}>{error}</span>
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button variant="primary" disabled={busy || selected === undefined} onClick={() => void submit()}>{t('data.connector.workspaceImport')}</Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 8 }}>
        <p style={styles.help}>{t('data.connector.workspaceHint')}</p>
        {sources === undefined
          ? <p style={styles.help}>{t('data.connector.workspaceLoading')}</p>
          : sources.length === 0
            ? <p style={styles.help}>{t('data.connector.workspaceEmpty')}</p>
            : (
              <select
                aria-label={t('data.connector.workspace')}
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                style={styles.input}
              >
                {sources.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
              </select>
            )}
        {listing !== undefined && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ ...styles.tiny, flex: 1 }}>{listing.path === '' ? t('data.connector.workspaceHere') : listing.path}</span>
              {listing.parent !== undefined && <Button size="sm" variant="ghost" onClick={() => void navigate(listing.parent ?? '')}>{t('data.connector.workspaceParent')}</Button>}
            </div>
            <div style={{ ...styles.tableWrap, maxHeight: 260, padding: 4 }}>
              {listing.entries.length === 0
                ? <p style={styles.help}>{t('data.connector.workspaceNoFiles')}</p>
                : listing.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => {
                      if (entry.type === 'directory') void navigate(entry.path)
                      else { setSelected(entry); setName(entry.name.replace(/\.(csv|json)$/i, '')) }
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 'none', background: entry.path === selected?.path ? colors.hover : 'transparent',
                      color: 'inherit', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontSize: 12,
                    }}
                  >
                    <span style={{ width: 14, color: colors.tertiary }}>{entry.type === 'directory' ? '▸' : '·'}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
                    {entry.type === 'file' && entry.size !== undefined && <span style={styles.tiny}>{Math.max(1, Math.round(entry.size / 1024))} KB</span>}
                  </button>
                ))}
            </div>
          </>
        )}
        {selected !== undefined && (
          <label style={styles.field}>
            <span style={styles.label}>{t('data.dataset.name')}</span>
            <Input aria-label={t('data.dataset.name')} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        )}
      </div>
    </Modal>
  )
}

function ThreadFilterDialog({ t, datasets, rowsOf, filters, ranges, onSubmit, onClose }: {
  t: Translate
  datasets: readonly DatasetMeta[]
  rowsOf: (datasetId: string) => DatasetRows | undefined
  filters: readonly ChartFilter[]
  ranges: readonly ChartRange[]
  onSubmit: (filters: readonly ChartFilter[], ranges: readonly ChartRange[]) => Promise<void>
  onClose: () => void
}): ReactElement {
  const [current, setCurrent] = useState<readonly ChartFilter[]>(filters)
  const [currentRanges, setCurrentRanges] = useState<readonly ChartRange[]>(ranges)
  const [rangeColumn, setRangeColumn] = useState('')
  const [rangeMin, setRangeMin] = useState('')
  const [rangeMax, setRangeMax] = useState('')
  const [column, setColumn] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const columnNames = [...new Set(datasets.flatMap((dataset) => dataset.columns
    .filter((candidate) => candidate.type === 'string' || candidate.type === 'boolean')
    .map((candidate) => candidate.name)))]
  const numericNames = [...new Set(datasets.flatMap((dataset) => dataset.columns
    .filter((candidate) => candidate.type === 'number')
    .map((candidate) => candidate.name)))]
  const values = (() => {
    if (column === '') return []
    for (const dataset of datasets) {
      if (!dataset.columns.some((candidate) => candidate.name === column)) continue
      const rows = rowsOf(dataset.id)
      if (rows === undefined) continue
      return [...new Set(rows.rows.map((row) => String(row[column] ?? '')).filter((entry) => entry !== ''))].slice(0, 30)
    }
    return []
  })()
  const add = (): void => {
    if (column === '' || value === '') return
    setCurrent((previous) => [...previous.filter((filter) => filter.column !== column), { column, values: [value] }])
    setColumn(''); setValue('')
  }
  const addRange = (): void => {
    if (rangeColumn === '') return
    const min = rangeMin.trim() === '' ? undefined : Number(rangeMin)
    const max = rangeMax.trim() === '' ? undefined : Number(rangeMax)
    if (min !== undefined && !Number.isFinite(min)) return
    if (max !== undefined && !Number.isFinite(max)) return
    setCurrentRanges((previous) => [
      ...previous.filter((range) => range.column !== rangeColumn),
      { column: rangeColumn, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) },
    ])
    setRangeColumn(''); setRangeMin(''); setRangeMax('')
  }
  const save = async (): Promise<void> => {
    setBusy(true); setError('')
    try { await onSubmit(current, currentRanges) } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('data.thread.filters')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1, color: colors.danger, fontSize: 11 }}>{error}</span>
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>{t('data.action.save')}</Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 8 }}>
        <p style={styles.help}>{t('data.thread.filterHint')}</p>
        {current.map((filter) => (
          <div key={filter.column} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={styles.badge}>{filter.column} = {filter.values.join(', ')}</span>
            <Button size="sm" variant="ghost" onClick={() => setCurrent((previous) => previous.filter((candidate) => candidate.column !== filter.column))}>×</Button>
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6 }}>
          <select value={column} onChange={(event) => { setColumn(event.target.value); setValue('') }} style={styles.input}>
            <option value="">{t('data.chart.filterColumn')}</option>
            {columnNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <select value={value} disabled={column === ''} onChange={(event) => setValue(event.target.value)} style={styles.input}>
            <option value="">{t('data.chart.filterValue')}</option>
            {values.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
          <Button size="sm" variant="outline" disabled={column === '' || value === ''} onClick={add}>{t('data.chart.add')}</Button>
        </div>
        {current.length > 0 && <Button size="sm" variant="ghost" onClick={() => setCurrent([])}>{t('data.chart.clearFilters')}</Button>}
        <div style={{ height: 1, background: colors.border, margin: '2px 0' }} />
        <span style={styles.label}>{t('data.thread.ranges')}</span>
        {currentRanges.map((range) => (
          <div key={range.column} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={styles.badge}>{range.column}: {range.min ?? '−∞'} ~ {range.max ?? '+∞'}</span>
            <Button size="sm" variant="ghost" onClick={() => setCurrentRanges((previous) => previous.filter((candidate) => candidate.column !== range.column))}>×</Button>
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) auto', gap: 6 }}>
          <select value={rangeColumn} onChange={(event) => setRangeColumn(event.target.value)} style={styles.input}>
            <option value="">{t('data.chart.rangeColumn')}</option>
            {numericNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <Input aria-label={t('data.chart.rangeMin')} placeholder={t('data.chart.rangeMin')} value={rangeMin} disabled={rangeColumn === ''} onChange={(event) => setRangeMin(event.target.value)} />
          <Input aria-label={t('data.chart.rangeMax')} placeholder={t('data.chart.rangeMax')} value={rangeMax} disabled={rangeColumn === ''} onChange={(event) => setRangeMax(event.target.value)} />
          <Button size="sm" variant="outline" disabled={rangeColumn === ''} onClick={addRange}>{t('data.chart.add')}</Button>
        </div>
      </div>
    </Modal>
  )
}

function DatabaseDialog({ t, workspaceId, onImported, onClose }: {
  t: Translate
  workspaceId: string
  onImported: (dataset: DatasetMeta) => void
  onClose: () => void
}): ReactElement {
  const [profiles, setProfiles] = useState<readonly DataConnectionProfile[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [saveName, setSaveName] = useState('')
  const [engine, setEngine] = useState<DatabaseEngine>('postgres')
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState('5432')
  const [database, setDatabase] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [ssl, setSsl] = useState(false)
  const [mode, setMode] = useState<'table' | 'sql'>('table')
  const [tables, setTables] = useState<readonly DatabaseTable[]>([])
  const [table, setTable] = useState('')
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const config = (): DatabaseConfig => ({
    engine,
    host: host.trim(),
    port: Number(port),
    database: database.trim(),
    user: user.trim(),
    password,
    ...(ssl ? { ssl: true } : {}),
  })
  useEffect(() => {
    let cancelled = false
    void listConnections().then((rows) => {
      if (!cancelled) setProfiles(rows.filter((profile) => profile.kind === 'database'))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  const applyProfile = (id: string): void => {
    setConnectionId(id)
    const profile = profiles.find((candidate) => candidate.id === id)
    if (profile === undefined) return
    const value = profile.config as unknown as DatabaseConfig
    setEngine(value.engine)
    setHost(value.host)
    setPort(String(value.port ?? (value.engine === 'postgres' ? 5432 : value.engine === 'mssql' ? 1433 : 3306)))
    setDatabase(value.database)
    setUser(value.user)
    setPassword('')
    setSsl(value.ssl === true)
    setTables([]); setTable('')
  }
  const persist = async (): Promise<void> => {
    if (saveName.trim() === '' || password === '') return
    setBusy(true); setError('')
    try {
      const { password: _secret, ...configWithoutSecret } = config()
      const profile = await saveConnection({ kind: 'database', name: saveName.trim(), config: configWithoutSecret as unknown as Record<string, unknown>, secret: password })
      setProfiles((current) => [...current, profile])
      setConnectionId(profile.id)
      setSaveName('')
      setPassword('')
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }
  const test = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const next = await listDatabaseTables(connectionId === '' ? { config: config() } : { connectionId })
      setTables(next)
      setTable(next[0]?.name ?? '')
      if (name.trim() === '' && next[0] !== undefined) setName(next[0].name)
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }
  const submit = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const target = connectionId === '' ? { config: config() } : { connectionId }
      const dataset = mode === 'sql'
        ? await importDatabaseQuery({ ...target, query, workspaceId, name: name.trim() })
        : await (async () => {
          const selected = tables.find((candidate) => candidate.name === table)
          if (selected === undefined) throw new Error(t('data.connector.selectTable'))
          return await importDatabase({ ...target, table: selected, workspaceId, name: name.trim() })
        })()
      onImported(dataset)
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('data.connector.database')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1, color: colors.danger, fontSize: 11 }}>{error}</span>
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button variant="primary" disabled={busy || name.trim() === '' || (mode === 'table' ? table === '' : query.trim() === '')} onClick={() => void submit()}>
            {busy ? t('data.connector.importingTable') : mode === 'sql' ? t('data.connector.importQuery') : t('data.connector.importTable')}
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <p style={styles.help}>{t('data.connector.databaseHint')}</p>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.connection.saved')}</span>
          <select value={connectionId} onChange={(event) => applyProfile(event.target.value)} style={styles.input}>
            <option value="">{t('data.connection.none')}</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
        {connectionId !== '' && <p style={styles.help}>{t('data.connection.usingStored')}</p>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10 }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.connector.engine')}</span>
            <select value={engine} onChange={(event) => {
              const next = event.target.value === 'mysql' ? 'mysql' : event.target.value === 'mssql' ? 'mssql' : 'postgres'
              setEngine(next)
              setPort(next === 'mysql' ? '3306' : next === 'mssql' ? '1433' : '5432')
              setTables([]); setTable('')
            }} style={styles.input}>
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL / MariaDB</option>
              <option value="mssql">SQL Server</option>
            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.connector.port')}</span>
            <Input aria-label={t('data.connector.port')} value={port} onChange={(event) => setPort(event.target.value)} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.connector.host')}</span>
            <Input aria-label={t('data.connector.host')} value={host} onChange={(event) => setHost(event.target.value)} />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.connector.databaseName')}</span>
            <Input aria-label={t('data.connector.databaseName')} value={database} onChange={(event) => setDatabase(event.target.value)} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.connector.user')}</span>
            <Input aria-label={t('data.connector.user')} value={user} onChange={(event) => setUser(event.target.value)} />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('data.connector.password')}</span>
            <Input aria-label={t('data.connector.password')} type="password" value={password} disabled={connectionId !== ''} onChange={(event) => setPassword(event.target.value)} />
          </label>
        </div>
        <label style={{ ...styles.label, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={ssl} onChange={(event) => setSsl(event.target.checked)} />
          {t('data.connector.ssl')}
        </label>
        <SegmentedControl
          id="tentacle-data-db-mode"
          value={mode}
          options={[{ value: 'table', label: t('data.connector.modeTable') }, { value: 'sql', label: t('data.connector.modeSql') }]}
          label={t('data.connector.database')}
          onChange={setMode}
        />
        {mode === 'sql' && (
          <>
            <label style={styles.field}>
              <span style={styles.label}>{t('data.connector.sql')}</span>
              <textarea
                aria-label={t('data.connector.sql')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="SELECT month, SUM(revenue) AS revenue FROM sales GROUP BY month"
                style={styles.textarea}
              />
            </label>
            <p style={styles.help}>{t('data.connector.sqlHint')}</p>
          </>
        )}
        {connectionId === '' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
            <Input aria-label={t('data.connection.saveName')} placeholder={t('data.connection.saveName')} value={saveName} onChange={(event) => setSaveName(event.target.value)} />
            <Button variant="outline" disabled={busy || saveName.trim() === '' || password === ''} onClick={() => void persist()}>{t('data.connection.save')}</Button>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button variant="outline" disabled={busy} onClick={() => void test()}>{busy ? t('data.connector.testing') : t('data.connector.test')}</Button>
          {tables.length > 0 && <span style={styles.help}>{fmt(t('data.connector.tablesFound'), { n: String(tables.length) })}</span>}
        </div>
        {mode === 'table' && tables.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={styles.field}>
              <span style={styles.label}>{t('data.connector.selectTable')}</span>
              <select value={table} onChange={(event) => { setTable(event.target.value); setName(event.target.value) }} style={styles.input}>
                {tables.map((candidate) => <option key={candidate.label} value={candidate.name}>{candidate.label}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span style={styles.label}>{t('data.dataset.name')}</span>
              <Input aria-label={t('data.dataset.name')} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          </div>
        )}
      </div>
    </Modal>
  )
}

function ObjectStoreDialog({ t, workspaceId, onImported, onClose }: {
  t: Translate
  workspaceId: string
  onImported: (dataset: DatasetMeta) => void
  onClose: () => void
}): ReactElement {
  const [profiles, setProfiles] = useState<readonly DataConnectionProfile[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [saveName, setSaveName] = useState('')
  const [provider, setProvider] = useState<ObjectStoreProvider>('s3')
  const [bucket, setBucket] = useState('')
  const [region, setRegion] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [container, setContainer] = useState('')
  const [connectionString, setConnectionString] = useState('')
  const [prefix, setPrefix] = useState('')
  const [objects, setObjects] = useState<readonly ObjectEntry[]>([])
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const config = (): ObjectStoreConfig => provider === 's3'
    ? {
      provider: 's3', bucket: bucket.trim(), region: region.trim(),
      accessKeyId: accessKey.trim(), secretAccessKey: secretKey.trim(),
      ...(endpoint.trim() === '' ? {} : { endpoint: endpoint.trim() }),
      ...(prefix.trim() === '' ? {} : { prefix: prefix.trim() }),
    }
    : {
      provider: 'azure', container: container.trim(), connectionString: connectionString.trim(),
      ...(prefix.trim() === '' ? {} : { prefix: prefix.trim() }),
    }
  useEffect(() => {
    let cancelled = false
    void listConnections().then((rows) => {
      if (!cancelled) setProfiles(rows.filter((profile) => profile.kind === 'objectstore'))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  const applyProfile = (id: string): void => {
    setConnectionId(id)
    const profile = profiles.find((candidate) => candidate.id === id)
    if (profile === undefined) return
    const value = profile.config as unknown as ObjectStoreConfig
    setProvider(value.provider)
    setPrefix(value.prefix ?? '')
    if (value.provider === 's3') {
      setBucket(value.bucket); setRegion(value.region); setEndpoint(value.endpoint ?? '')
      setAccessKey(value.accessKeyId); setSecretKey('')
      setContainer(''); setConnectionString('')
    } else {
      setContainer(value.container); setConnectionString('')
      setBucket(''); setRegion(''); setEndpoint(''); setAccessKey(''); setSecretKey('')
    }
    setObjects([]); setKey('')
  }
  const persist = async (): Promise<void> => {
    if (saveName.trim() === '') return
    const value = config()
    const secret = value.provider === 's3' ? secretKey : connectionString
    if (secret.trim() === '') return
    setBusy(true); setError('')
    try {
      const profile = await saveConnection({
        kind: 'objectstore',
        name: saveName.trim(),
        config: value.provider === 's3' ? { ...value, secretAccessKey: '' } : { ...value, connectionString: '' },
        secret,
      })
      setProfiles((current) => [...current, profile])
      setConnectionId(profile.id)
      setSaveName('')
      setSecretKey(''); setConnectionString('')
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }
  const test = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const next = await listObjectStore(connectionId === '' ? { config: config() } : { connectionId })
      setObjects(next)
      setKey(next[0]?.key ?? '')
      if (name.trim() === '' && next[0] !== undefined) setName(next[0].key.split('/').pop() ?? '')
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }
  const submit = async (): Promise<void> => {
    if (key === '') return
    setBusy(true); setError('')
    try {
      const dataset = await importObject({ ...(connectionId === '' ? { config: config() } : { connectionId }), key, workspaceId, name: name.trim() })
      onImported(dataset)
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('data.connector.objectStore')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1, color: colors.danger, fontSize: 11 }}>{error}</span>
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button variant="primary" disabled={busy || key === '' || name.trim() === ''} onClick={() => void submit()}>{t('data.connector.importObject')}</Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <p style={styles.help}>{t('data.connector.objectStoreHint')}</p>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.connection.saved')}</span>
          <select value={connectionId} onChange={(event) => applyProfile(event.target.value)} style={styles.input}>
            <option value="">{t('data.connection.none')}</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
        {connectionId !== '' && <p style={styles.help}>{t('data.connection.usingStored')}</p>}
        <label style={styles.field}>
          <span style={styles.label}>{t('data.connector.provider')}</span>
          <select value={provider} onChange={(event) => {
            const next = event.target.value === 'azure' ? 'azure' : 's3'
            setProvider(next); setObjects([]); setKey('')
          }} style={styles.input}>
            <option value="s3">Amazon S3 / S3-compatible</option>
            <option value="azure">Azure Blob Storage</option>
          </select>
        </label>
        {provider === 's3' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label style={styles.field}><span style={styles.label}>{t('data.connector.bucket')}</span><Input aria-label={t('data.connector.bucket')} value={bucket} onChange={(event) => setBucket(event.target.value)} /></label>
              <label style={styles.field}><span style={styles.label}>{t('data.connector.region')}</span><Input aria-label={t('data.connector.region')} value={region} onChange={(event) => setRegion(event.target.value)} /></label>
            </div>
            <label style={styles.field}><span style={styles.label}>{t('data.connector.endpoint')}</span><Input aria-label={t('data.connector.endpoint')} value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label style={styles.field}><span style={styles.label}>{t('data.connector.accessKey')}</span><Input aria-label={t('data.connector.accessKey')} value={accessKey} onChange={(event) => setAccessKey(event.target.value)} /></label>
              <label style={styles.field}><span style={styles.label}>{t('data.connector.secretKey')}</span><Input aria-label={t('data.connector.secretKey')} type="password" value={secretKey} disabled={connectionId !== ''} onChange={(event) => setSecretKey(event.target.value)} /></label>
            </div>
          </>
        ) : (
          <>
            <label style={styles.field}><span style={styles.label}>{t('data.connector.container')}</span><Input aria-label={t('data.connector.container')} value={container} onChange={(event) => setContainer(event.target.value)} /></label>
            <label style={styles.field}><span style={styles.label}>{t('data.connector.connectionString')}</span><Input aria-label={t('data.connector.connectionString')} type="password" value={connectionString} disabled={connectionId !== ''} onChange={(event) => setConnectionString(event.target.value)} /></label>
          </>
        )}
        <label style={styles.field}><span style={styles.label}>{t('data.connector.prefix')}</span><Input aria-label={t('data.connector.prefix')} value={prefix} onChange={(event) => setPrefix(event.target.value)} /></label>
        {connectionId === '' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
            <Input aria-label={t('data.connection.saveName')} placeholder={t('data.connection.saveName')} value={saveName} onChange={(event) => setSaveName(event.target.value)} />
            <Button variant="outline" disabled={busy || saveName.trim() === ''} onClick={() => void persist()}>{t('data.connection.save')}</Button>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button variant="outline" disabled={busy} onClick={() => void test()}>{t('data.connector.listObjects')}</Button>
          {objects.length > 0 && <span style={styles.help}>{fmt(t('data.connector.objectsFound'), { n: String(objects.length) })}</span>}
        </div>
        {objects.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <label style={styles.field}>
              <span style={styles.label}>{t('data.connector.selectObject')}</span>
              <select value={key} onChange={(event) => { setKey(event.target.value); setName(event.target.value.split('/').pop() ?? '') }} style={styles.input}>
                {objects.map((object) => <option key={object.key} value={object.key}>{object.key}</option>)}
              </select>
            </label>
            <label style={styles.field}><span style={styles.label}>{t('data.dataset.name')}</span><Input aria-label={t('data.dataset.name')} value={name} onChange={(event) => setName(event.target.value)} /></label>
          </div>
        )}
      </div>
    </Modal>
  )
}

function SuggestRelationsDialog({ t, workspaceId, onCreate, onClose }: {
  t: Translate
  workspaceId: string
  onCreate: (suggestion: RelationSuggestion) => Promise<void>
  onClose: () => void
}): ReactElement {
  const [suggestions, setSuggestions] = useState<readonly RelationSuggestion[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void listRelationSuggestions(workspaceId).then((rows) => {
      if (!cancelled) setSuggestions(rows)
    }).catch((err: unknown) => {
      if (!cancelled) { setSuggestions([]); setError(errorText(t, err)) }
    })
    return () => { cancelled = true }
  }, [workspaceId, t])
  const accept = async (suggestion: RelationSuggestion): Promise<void> => {
    setBusy(true); setError('')
    try {
      await onCreate(suggestion)
      setSuggestions((current) => current?.filter((row) => row !== suggestion))
    } catch (err) { setError(errorText(t, err)) } finally { setBusy(false) }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('data.relation.suggest')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1, color: colors.danger, fontSize: 11 }}>{error}</span>
          <Button variant="ghost" onClick={onClose}>{t('data.action.close')}</Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 8 }}>
        <p style={styles.help}>{t('data.relation.suggestHint')}</p>
        {suggestions === undefined
          ? <p style={styles.help}>{t('data.connector.workspaceLoading')}</p>
          : suggestions.length === 0
            ? <p style={styles.help}>{t('data.relation.suggestEmpty')}</p>
            : suggestions.map((suggestion) => (
              <div key={`${suggestion.leftDatasetId}.${suggestion.leftColumn}-${suggestion.rightDatasetId}.${suggestion.rightColumn}`} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ ...styles.hint, margin: 0 }}>
                    {suggestion.leftDatasetName}.{suggestion.leftColumn} = {suggestion.rightDatasetName}.{suggestion.rightColumn}
                  </p>
                  <p style={{ ...styles.help, margin: '2px 0 0' }}>
                    {fmt(t('data.relation.overlap'), {
                      score: String(Math.round(suggestion.score * 100)),
                      left: String(suggestion.leftDistinct),
                      right: String(suggestion.rightDistinct),
                    })}
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void accept(suggestion)}>{t('data.chart.add')}</Button>
              </div>
            ))}
      </div>
    </Modal>
  )
}

function QuickChartBar({ t, card, onType, onTheme, onAnnotations }: {
  t: Translate
  card: ChartCard
  onType: (chart: ChartKind) => void
  onTheme: (theme: ChartTheme) => void
  onAnnotations: (annotations: ChartAnnotations) => void
}): ReactElement {
  const annotations = card.spec.annotations ?? {}
  const themes: readonly ChartTheme[] = ['default', 'warm', 'cool', 'mono']
  return (
    <div
      data-quick-config
      onClick={(event) => event.stopPropagation()}
      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px', borderTop: `1px solid ${colors.border}`, background: colors.layer1, flexWrap: 'wrap' }}
    >
      <select
        aria-label={t('data.chart.kind')}
        value={card.spec.chart}
        onChange={(event) => onType(event.target.value as ChartKind)}
        style={{ ...styles.input, width: 'auto', padding: '2px 4px', fontSize: 10 }}
      >
        <option value="bar">{t('data.chart.bar')}</option>
        <option value="line">{t('data.chart.line')}</option>
        <option value="area">{t('data.chart.area')}</option>
        <option value="scatter">{t('data.chart.scatter')}</option>
        <option value="pie">{t('data.chart.pie')}</option>
        <option value="donut">{t('data.chart.donut')}</option>
        <option value="horizontalBar">{t('data.chart.horizontalBar')}</option>
        <option value="heatmap">{t('data.chart.heatmap')}</option>
        <option value="boxplot">{t('data.chart.boxplot')}</option>
        <option value="bump">{t('data.chart.bump')}</option>
        <option value="streamgraph">{t('data.chart.streamgraph')}</option>
        <option value="waterfall">{t('data.chart.waterfall')}</option>
        <option value="rose">{t('data.chart.rose')}</option>
        <option value="radar">{t('data.chart.radar')}</option>
        <option value="groupedBar">{t('data.chart.groupedBar')}</option>
        <option value="stackedBar">{t('data.chart.stackedBar')}</option>
        <option value="candlestick">{t('data.chart.candlestick')}</option>
        <option value="gantt">{t('data.chart.gantt')}</option>
        <option value="histogram">{t('data.chart.histogram')}</option>
        <option value="density">{t('data.chart.density')}</option>
        <option value="violin">{t('data.chart.violin')}</option>
        <option value="kpi">{t('data.chart.kpi')}</option>
        <option value="rangeArea">{t('data.chart.rangeArea')}</option>
        <option value="bullet">{t('data.chart.bullet')}</option>
        <option value="barTable">{t('data.chart.barTable')}</option>
        <option value="table">{t('data.chart.table')}</option>
        <option value="rangeDot">{t('data.chart.rangeDot')}</option>
        <option value="map">{t('data.chart.map')}</option>
        <option value="choropleth">{t('data.chart.choropleth')}</option>
        <option value="marginal">{t('data.chart.marginal')}</option>
        <option value="regression">{t('data.chart.regression')}</option>
        <option value="connectedScatter">{t('data.chart.connectedScatter')}</option>
        <option value="strip">{t('data.chart.strip')}</option>
        <option value="lollipop">{t('data.chart.lollipop')}</option>
        <option value="pyramid">{t('data.chart.pyramid')}</option>
        <option value="slope">{t('data.chart.slope')}</option>
        <option value="sparkline">{t('data.chart.sparkline')}</option>
        <option value="ridgeline">{t('data.chart.ridgeline')}</option>
        <option value="ecdf">{t('data.chart.ecdf')}</option>
        <option value="calendarHeatmap">{t('data.chart.calendarHeatmap')}</option>
      </select>
      <span style={{ width: 1, height: 14, background: colors.border }} />
      {themes.map((theme) => (
        <button
          key={theme}
          type="button"
          aria-label={t(`data.theme.${theme}` as DataStudioLocaleKey)}
          title={t(`data.theme.${theme}` as DataStudioLocaleKey)}
          onClick={() => onTheme(theme)}
          style={{
            width: 13, height: 13, borderRadius: '50%', padding: 0, cursor: 'pointer',
            border: (card.spec.theme ?? 'default') === theme ? `2px solid ${colors.accent}` : `1px solid ${colors.border}`,
            background: theme === 'default' ? '#64748b' : theme === 'warm' ? '#f97316' : theme === 'cool' ? '#06b6d4' : '#334155',
          }}
        />
      ))}
      <span style={{ width: 1, height: 14, background: colors.border }} />
      {([
        ['max', '高'],
        ['mean', '均'],
        ['labels', '标'],
      ] as const).map(([key, label]) => (
        <button
          key={key}
          type="button"
          title={t(`data.chart.annotate${key === 'max' ? 'Max' : key === 'mean' ? 'Mean' : 'Labels'}` as DataStudioLocaleKey)}
          onClick={() => onAnnotations({ ...annotations, [key]: !annotations[key] })}
          style={{
            border: `1px solid ${annotations[key] === true ? colors.accent : colors.border}`,
            background: annotations[key] === true ? colors.hover : 'transparent',
            color: annotations[key] === true ? colors.accent : colors.secondary,
            borderRadius: 5, fontSize: 9, lineHeight: '14px', padding: '0 4px', cursor: 'pointer',
          }}
        >{label}</button>
      ))}
    </div>
  )
}

// ---- main panel ----

export function DataStudioView({ t }: { t: Translate }): ReactElement {
  const [state, setState] = useState<DataState | undefined>(undefined)
  const [view, setView] = useState<'explore' | 'reports'>('explore')
  const [workspaceId, setWorkspaceId] = useState('')
  const [selectedCardId, setSelectedCardId] = useState<string | undefined>(undefined)
  const [previewDatasetId, setPreviewDatasetId] = useState<string | undefined>(undefined)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [liveSteps, setLiveSteps] = useState<readonly string[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined)
  const [rows, setRows] = useState<Readonly<Record<string, DatasetRows | undefined>>>({})
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [threadOpen, setThreadOpen] = useState(false)
  const [renameThreadTarget, setRenameThreadTarget] = useState<DataThread | undefined>(undefined)
  const [chartDraft, setChartDraft] = useState<ChartDraft | undefined>(undefined)
  const [deriveTarget, setDeriveTarget] = useState<{ dataset: DatasetMeta; threadId: string } | undefined>(undefined)
  const [joinTarget, setJoinTarget] = useState<{ dataset: DatasetMeta; threadId: string } | undefined>(undefined)
  const [relationOpen, setRelationOpen] = useState(false)
  const [relationSuggestOpen, setRelationSuggestOpen] = useState(false)
  const [threadFilterTarget, setThreadFilterTarget] = useState<DataThread | undefined>(undefined)
  const [sqliteOpen, setSqliteOpen] = useState(false)
  const [databaseOpen, setDatabaseOpen] = useState(false)
  const [objectStoreOpen, setObjectStoreOpen] = useState(false)
  const [workspaceFileOpen, setWorkspaceFileOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: 'thread'; thread: DataThread }
    | { kind: 'card'; card: DataCard }
    | { kind: 'dataset'; dataset: DatasetMeta }
    | undefined
  >(undefined)
  const { toast, show, done } = useToast()

  const reload = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await loadState()
      setState(next)
      setWorkspaceId((current) => next.workspaces.some((workspace) => workspace.id === current)
        ? current
        : (next.workspaces[0]?.id ?? ''))
      setLoadError('')
      const entries = await Promise.all(next.datasets.map(async (dataset) => {
        try { return [dataset.id, await loadDatasetRows(dataset.id)] as const } catch { return [dataset.id, undefined] as const }
      }))
      setRows(Object.fromEntries(entries))
    } catch (error) {
      setLoadError(errorText(t, error))
    } finally {
      setBusy(false)
    }
  }, [t])

  useEffect(() => { void reload() }, [reload])

  const workspace = state?.workspaces.find((row) => row.id === workspaceId)
  const datasets = useMemo(() => state === undefined ? [] : state.datasets.filter((dataset) => dataset.workspaceId === workspaceId), [state, workspaceId])
  const threads = useMemo(() => state === undefined ? [] : state.threads.filter((thread) => thread.workspaceId === workspaceId), [state, workspaceId])
  useEffect(() => {
    if (activeThreadId !== undefined && threads.some((thread) => thread.id === activeThreadId)) return
    setActiveThreadId(threads[0]?.id)
  }, [threads, activeThreadId])
  const selectedCard = state?.cards.find((card) => card.id === selectedCardId)
  const previewDataset = previewDatasetId === undefined ? undefined : state?.datasets.find((dataset) => dataset.id === previewDatasetId)
  const activeThread = activeThreadId === undefined ? undefined : state?.threads.find((thread) => thread.id === activeThreadId)
  const hasAutoRefresh = state?.datasets.some((dataset) => (dataset.autoRefreshSec ?? 0) > 0) === true
  useEffect(() => {
    if (!hasAutoRefresh) return
    const timer = setInterval(() => { void reload() }, 20_000)
    return () => { clearInterval(timer) }
  }, [hasAutoRefresh, reload])

  const activeThreadDataset = state === undefined || activeThread === undefined
    ? undefined
    : (() => {
      const card = state.cards.find((candidate): candidate is DatasetCard => candidate.threadId === activeThread.id && candidate.kind === 'dataset')
      return card === undefined ? undefined : datasetOf(state, card.datasetId)
    })()

  const rowsOf = (datasetId: string): DatasetRows | undefined => rows[datasetId]

  const mutate = async (action: () => Promise<unknown>, message?: string): Promise<void> => {
    try {
      await action()
      if (message !== undefined) show(message, 'success')
      await reload()
    } catch (error) {
      show(errorText(t, error))
    }
  }

  const addDatasetCard = (thread: DataThread, dataset: DatasetMeta): void => {
    void mutate(() => createCard({ threadId: thread.id, kind: 'dataset', title: dataset.name, datasetId: dataset.id }), t('data.toast.created'))
  }

  const createThreadFromDataset = async (name: string, datasetId: string | undefined): Promise<void> => {
    await mutate(async () => {
      const thread = await createThread({ workspaceId, name, ...(datasetId === undefined ? {} : { datasetId }) })
      setThreadOpen(false)
      return thread
    }, t('data.toast.created'))
  }

  const submitChart = async (draft: ChartDraft): Promise<void> => {
    const spec: ChartSpec = {
      chart: draft.chart,
      x: draft.x,
      ...(draft.y === '' ? {} : { y: draft.y }),
      ...(draft.color === '' ? {} : { color: draft.color }),
      ...(draft.size === '' ? {} : { size: draft.size }),
      ...(draft.facet === '' ? {} : { facet: draft.facet }),
      ...(draft.value === '' ? {} : { value: draft.value }),
      ...(draft.open === '' ? {} : { open: draft.open }),
      ...(draft.high === '' ? {} : { high: draft.high }),
      ...(draft.low === '' ? {} : { low: draft.low }),
      ...(draft.close === '' ? {} : { close: draft.close }),
      ...(draft.x2 === '' ? {} : { x2: draft.x2 }),
      ...(draft.goal === '' ? {} : { goal: draft.goal }),
      ...(draft.y2 === '' ? {} : { y2: draft.y2 }),
      ...(draft.sort === 'none' ? {} : { sort: draft.sort }),
      aggregate: draft.aggregate,
      ...(draft.title.trim() === '' ? {} : { title: draft.title.trim() }),
      theme: draft.theme,
    }
    if (draft.cardId === undefined) {
      await createCard({ threadId: draft.threadId, kind: 'chart', title: draft.title.trim() || `${draft.chart} · ${draft.x}`, datasetId: draft.datasetId, spec })
    } else {
      await updateCard({ id: draft.cardId, title: draft.title.trim() || t('data.chart.new'), spec })
    }
    setChartDraft(undefined)
    show(t('data.toast.saved'), 'success')
    await reload()
  }

  const submitDerive = async (name: string, operation: DataOperation): Promise<void> => {
    const target = deriveTarget
    if (target === undefined) return
    const derived = await deriveDataset({ datasetId: target.dataset.id, name, operation })
    await createCard({ threadId: target.threadId, kind: 'dataset', title: derived.name, datasetId: derived.id })
    setDeriveTarget(undefined)
    show(t('data.toast.derived'), 'success')
    await reload()
  }

  const addRecommendation = async (dataset: DatasetMeta, threadId: string, recommendation: ChartRecommendation): Promise<void> => {
    try {
      const card = await createCard({
        threadId,
        kind: 'chart',
        title: recommendation.spec.title ?? `${recommendation.spec.x} chart`,
        datasetId: dataset.id,
        spec: recommendation.spec,
      })
      await reload()
      setSelectedCardId(card.id)
      setPreviewDatasetId(undefined)
      show(t('data.chart.created'), 'success')
    } catch (error) {
      show(errorText(t, error))
    }
  }

  const changeAutoRefresh = async (dataset: DatasetMeta, seconds: number): Promise<void> => {
    try {
      await setAutoRefresh(dataset.id, seconds)
      await reload()
      show(t('data.toast.autoRefresh'), 'success')
    } catch (error) {
      show(errorText(t, error))
    }
  }

  const refresh = async (dataset: DatasetMeta): Promise<void> => {
    try {
      await refreshDataset(dataset.id)
      await reload()
      show(t('data.dataset.refreshed'), 'success')
    } catch (error) {
      show(errorText(t, error))
    }
  }

  const patchChart = async (card: ChartCard, patch: Partial<ChartSpec>): Promise<void> => {
    try {
      await updateCard({ id: card.id, spec: { ...card.spec, ...patch } })
      await reload()
      setSelectedCardId(card.id)
    } catch (error) {
      show(errorText(t, error))
    }
  }

  const switchChart = async (card: ChartCard, chart: ChartKind): Promise<void> => {
    if (chart === 'rangeArea') {
      await patchChart(card, { chart, y2: card.spec.y })
      return
    }
    if (chart === 'gantt') {
      const columns = rowsOf(card.datasetId)?.columns ?? []
      await patchChart(card, { chart, x2: columns[1]?.name ?? card.spec.x, y: columns[0]?.name ?? card.spec.y })
      return
    }
    if (chart === 'candlestick') {
      const numeric = (rowsOf(card.datasetId)?.columns ?? []).filter((column) => column.type === 'number').map((column) => column.name)
      await patchChart(card, {
        chart,
        open: numeric[0],
        high: numeric[1] ?? numeric[0],
        low: numeric[2] ?? numeric[0],
        close: numeric[3] ?? numeric[0],
      })
      return
    }
    let aggregate = card.spec.aggregate
    if (chart === 'scatter') aggregate = 'none'
    else if (chart === 'heatmap') aggregate = 'count'
    else if (aggregate === 'none') aggregate = 'sum'
    await patchChart(card, { chart, aggregate })
  }

  const duplicateChart = async (card: ChartCard): Promise<void> => {
    try {
      const copy = await createCard({
        threadId: card.threadId,
        kind: 'chart',
        title: `${card.title}${t('data.chart.copySuffix')}`,
        datasetId: card.datasetId,
        spec: card.spec,
      })
      await reload()
      setSelectedCardId(copy.id)
    } catch (error) {
      show(errorText(t, error))
    }
  }

  const exportChart = async (card: ChartCard): Promise<void> => {
    const svg = document.querySelector(`[data-chart-id="${card.id}"] svg`) as SVGSVGElement | null
    if (svg === null) { show(t('data.chart.exportMissing')); return }
    try {
      await downloadChartPng(svg, `${safeFilename(card.title)}.png`)
    } catch (error) {
      show(error instanceof Error ? error.message : String(error))
    }
  }

  const threadDatasets = (thread: DataThread): readonly DatasetMeta[] => {
    if (state === undefined) return []
    const ids = cardsOf(state, thread.id).filter((card): card is DatasetCard => card.kind === 'dataset').map((card) => card.datasetId)
    return datasets.filter((dataset) => ids.includes(dataset.id))
  }

  const openChart = (thread: DataThread, card?: ChartCard): void => {
    if (card !== undefined) {
      setChartDraft({
        threadId: thread.id,
        cardId: card.id,
        datasetId: card.datasetId,
        title: card.title,
        chart: card.spec.chart,
        x: card.spec.x,
        y: card.spec.y ?? '',
        color: card.spec.color ?? '',
        size: card.spec.size ?? '',
        facet: card.spec.facet ?? '',
        value: card.spec.value ?? '',
        open: card.spec.open ?? '',
        high: card.spec.high ?? '',
        low: card.spec.low ?? '',
        close: card.spec.close ?? '',
        x2: card.spec.x2 ?? '',
        goal: card.spec.goal ?? '',
        y2: card.spec.y2 ?? '',
        sort: card.spec.sort ?? 'none',
        aggregate: card.spec.aggregate,
        theme: card.spec.theme ?? 'default',
      })
      return
    }
    const dataset = threadDatasets(thread)[0] ?? datasets[0]
    if (dataset === undefined) {
      show(t('data.dataset.emptyHint'))
      return
    }
    const columns = rowsOf(dataset.id)?.columns ?? dataset.columns
    setChartDraft({
      threadId: thread.id,
      datasetId: dataset.id,
      title: '',
      chart: 'bar',
      x: columns[0]?.name ?? '',
      y: columns.find((column) => column.type === 'number')?.name ?? '',
      color: '',
      size: '',
      facet: '',
      value: '',
      open: '',
      high: '',
      low: '',
      close: '',
      x2: '',
      goal: '',
      y2: '',
      sort: 'none',
      aggregate: 'sum',
      theme: 'default',
    })
  }

  const ask = async (): Promise<void> => {
    if (activeThread === undefined || activeThreadDataset === undefined || question.trim() === '' || asking) return
    setAsking(true)
    setLiveSteps([])
    try {
      const result = await askAgentStream(
        { threadId: activeThread.id, prompt: question.trim(), datasetId: activeThreadDataset.id },
        (event) => { if (event.type === 'step' && event.step !== undefined) setLiveSteps((current) => [...current, event.step!]) },
      )
      setQuestion('')
      await reload()
      const created = result.cards.find((card): card is ChartCard | DatasetCard => card.kind === 'chart' || card.kind === 'dataset')
      if (created !== undefined) {
        setSelectedCardId(created.id)
        setPreviewDatasetId(undefined)
      }
      show(result.reply.kind === 'answer' ? result.reply.answer : t('data.toast.created'), 'success')
    } catch (error) {
      show(errorText(t, error))
    } finally {
      setAsking(false)
      setLiveSteps([])
    }
  }

  const confirmDelete = (): void => {
    const target = deleteTarget
    setDeleteTarget(undefined)
    if (target === undefined) return
    if (target.kind === 'thread') void mutate(() => removeThread(target.thread.id), t('data.toast.deleted'))
    else if (target.kind === 'card') void mutate(() => removeCard(target.card.id), t('data.toast.deleted'))
    else void mutate(() => removeDataset(target.dataset.id), t('data.toast.deleted'))
  }

  if (state === undefined) {
    return (
      <div style={styles.page}>
        <header style={styles.header}><div><h2 style={styles.title}>{t('data.panel')}</h2><p style={styles.pageHint}>{t('data.panel.hint')}</p></div></header>
        {loadError !== '' ? <p style={{ ...styles.hint, color: colors.danger }}>{t('data.error.load')} {loadError}</p> : <p style={styles.hint}>{t('data.action.refresh')}…</p>}
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h2 style={styles.title}>{t('data.panel')}</h2>
          <p style={styles.pageHint}>{t('data.panel.hint')}</p>
          <div style={styles.stats}>
            <Tag tone="quiet">{t('data.stats.datasets')} {datasets.length}</Tag>
            <Tag tone="quiet">{t('data.stats.threads')} {threads.length}</Tag>
            <Tag tone="quiet">{t('data.stats.charts')} {chartCount(state)}</Tag>
          </div>
        </div>
        <div style={styles.actions}>
          <Button variant="ghost" icon={<IconRefreshOutlineRegular size={16} />} disabled={busy} onClick={() => void reload()}>{t('data.action.refresh')}</Button>
          {view === 'explore' && (
            <>
              <Button variant="outline" icon={<IconPlusOutlineRegular size={16} />} onClick={() => setWorkspaceOpen(true)}>{t('data.workspace.new')}</Button>
              <Button variant="outline" icon={<IconPlusOutlineRegular size={16} />} onClick={() => setThreadOpen(true)}>{t('data.thread.new')}</Button>
              <Button variant="primary" icon={<IconPlusOutlineRegular size={16} />} onClick={() => setImportOpen(true)}>{t('data.dataset.import')}</Button>
            </>
          )}
        </div>
      </header>

      <div style={styles.toolbar}>
        <SegmentedControl
          id="tentacle-data-view"
          value={view}
          options={[{ value: 'explore', label: t('data.view.explore') }, { value: 'reports', label: t('data.view.reports') }]}
          label={t('data.panel')}
          onChange={setView}
        />
        <span style={styles.hint}>{t('data.workspace.label')}</span>
        <select aria-label={t('data.workspace.label')} value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setSelectedCardId(undefined) }} style={{ ...styles.input, maxWidth: 260 }}>
          {state.workspaces.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
        {workspace !== undefined && <span style={styles.tiny}>{workspace.name}</span>}
        {loadError !== '' && <span style={{ ...styles.hint, color: colors.danger }}>{loadError}</span>}
      </div>

      {view === 'reports' ? (
        <ReportsView
          key={workspaceId}
          t={t}
          state={state}
          workspaceId={workspaceId}
          {...(activeThreadId === undefined ? {} : { activeThreadId })}
          rowsOf={rowsOf}
          onChanged={reload}
        />
      ) : (
      <>
      <div style={styles.main}>
        <aside className={`tentacle-data-side`} style={styles.side}>
          <div style={styles.sideHeader}>
            <h3 style={styles.sideTitle}>{t('data.dataset.sources')}</h3>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="toolbar" aria-label={t('data.connector.objectStore')} title={t('data.connector.objectStore')} icon={<IconGlobeOutlineRegular size={14} />} onClick={() => setObjectStoreOpen(true)} />
            <Button size="sm" variant="toolbar" aria-label={t('data.connector.database')} title={t('data.connector.database')} icon={<IconApiOutlineRegular size={14} />} onClick={() => setDatabaseOpen(true)} />
            <Button size="sm" variant="toolbar" aria-label={t('data.connector.workspace')} title={t('data.connector.workspace')} icon={<IconFolderOpenOutlineRegular size={14} />} onClick={() => setWorkspaceFileOpen(true)} />
            <Button size="sm" variant="toolbar" aria-label={t('data.connector.localDb')} title={t('data.connector.localDb')} icon={<IconDatabaseOutlineRegular size={14} />} onClick={() => setSqliteOpen(true)} />
            <Button size="sm" variant="toolbar" aria-label={t('data.dataset.import')} icon={<IconPlusOutlineRegular size={14} />} onClick={() => setImportOpen(true)} />
          </div>
          {datasets.length === 0
            ? <div style={styles.empty}><p style={styles.emptyTitle}>{t('data.dataset.empty')}</p><p style={styles.help}>{t('data.dataset.emptyHint')}</p></div>
            : datasets.map((dataset) => (
              <div key={dataset.id} style={styles.datasetCard}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <IconDatabaseOutlineRegular size={14} />
                  <span style={styles.datasetName} title={dataset.name}>{dataset.name}</span>
                  <span style={{ flex: 1 }} />
                  <span style={styles.badge}>{dataset.format.toUpperCase()}</span>
                </div>
                <div style={styles.datasetMeta}>
                  <span>{fmt(t('data.dataset.rows'), { n: String(dataset.rowCount) })}</span>
                  <span>{fmt(t('data.dataset.cols'), { n: String(dataset.columns.length) })}</span>
                  {dataset.source !== undefined && (
                    <span style={styles.badge}>{dataset.source.kind === 'url' ? t('data.dataset.sourceUrl') : t('data.dataset.sourceWorkspace')}</span>
                  )}
                  {(dataset.autoRefreshSec ?? 0) > 0 && <span style={styles.badge}>{t('data.dataset.autoBadge')}</span>}
                </div>
                <div style={styles.datasetActions}>
                  <Button size="sm" variant="toolbar" aria-label={t('data.dataset.preview')} title={t('data.dataset.preview')} onClick={() => { setSelectedCardId(undefined); setPreviewDatasetId(dataset.id) }} icon={<IconChevronRightOutlineRegular size={12} />} />
                  {activeThread !== undefined && (
                    <Button size="sm" variant="toolbar" aria-label={t('data.dataset.addToThread')} title={t('data.dataset.addToThread')} onClick={() => addDatasetCard(activeThread, dataset)} icon={<IconPlusOutlineRegular size={12} />} />
                  )}
                  {dataset.source !== undefined && (
                    <Button size="sm" variant="toolbar" aria-label={t('data.dataset.refresh')} title={t('data.dataset.refresh')} icon={<IconRefreshOutlineRegular size={12} />} onClick={() => void refresh(dataset)} />
                  )}
                  <Button size="sm" variant="toolbar" aria-label={t('data.dataset.remove')} title={t('data.dataset.remove')} icon={<IconTrashOutlineRegular size={12} />} style={{ color: colors.danger }} onClick={() => setDeleteTarget({ kind: 'dataset', dataset })} />
                </div>
              </div>
            ))}

          <div style={styles.divider} />
          <div style={styles.sideHeader}>
            <h3 style={styles.sideTitle}>{t('data.relation.title')}</h3>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="toolbar" aria-label={t('data.relation.suggest')} title={t('data.relation.suggest')} disabled={datasets.length < 2} icon={<IconEnhanceOutlineRegular size={14} />} onClick={() => setRelationSuggestOpen(true)} />
            <Button size="sm" variant="toolbar" aria-label={t('data.relation.add')} title={t('data.relation.add')} disabled={datasets.length < 2} icon={<IconPlusOutlineRegular size={14} />} onClick={() => setRelationOpen(true)} />
          </div>
          {state.relations.filter((relation) => relation.workspaceId === workspaceId).length === 0
            ? <p style={styles.help}>{t('data.relation.empty')}</p>
            : state.relations.filter((relation) => relation.workspaceId === workspaceId).map((relation) => {
              const left = datasetOf(state, relation.leftDatasetId)
              const right = datasetOf(state, relation.rightDatasetId)
              return (
                <div key={relation.id} style={{ ...styles.datasetCard, cursor: 'default' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5, minWidth: 0 }}>
                    <div style={{ display: 'grid', gap: 2, minWidth: 0, flex: 1 }}>
                      <span style={{ ...styles.datasetName, fontSize: 11 }} title={`${left?.name ?? relation.leftDatasetId}.${relation.leftColumn}`}>{left?.name ?? relation.leftDatasetId}.{relation.leftColumn}</span>
                      <span style={{ ...styles.datasetName, fontSize: 11, color: colors.tertiary }} title={`${right?.name ?? relation.rightDatasetId}.${relation.rightColumn}`}>= {right?.name ?? relation.rightDatasetId}.{relation.rightColumn}</span>
                    </div>
                    <Button size="sm" variant="ghost" aria-label={t('data.relation.title')} icon={<IconTrashOutlineRegular size={11} />} style={{ color: colors.danger }} onClick={() => void mutate(() => removeRelation(relation.id), t('data.relation.deleted'))} />
                  </div>
                </div>
              )
            })}
        </aside>

        <section className="tentacle-data-board" style={styles.board}>
          {threads.length === 0
            ? <div style={{ ...styles.empty, flex: 1 }}><p style={styles.emptyTitle}>{t('data.thread.empty')}</p><p style={styles.help}>{t('data.thread.emptyHint')}</p><Button variant="primary" onClick={() => setThreadOpen(true)}>{t('data.thread.new')}</Button></div>
            : threads.map((thread) => {
              const cards = cardsOf(state, thread.id)
              const threadDatasetList = threadDatasets(thread)
              return (
                <div key={thread.id} onClick={() => setActiveThreadId(thread.id)} style={{ ...styles.threadColumn, ...(thread.id === activeThreadId ? { borderColor: colors.accent } : {}) }}>
                  <div style={styles.threadHeader}>
                    <span style={styles.threadName} title={thread.name}>{thread.name}</span>
                    {thread.parentThreadId !== undefined && <Tag tone="outline">{t('data.thread.branch')}</Tag>}
                    <span style={{ flex: 1 }} />
                    <Button size="sm" variant="toolbar" aria-label={t('data.thread.filters')} title={t('data.thread.filters')} icon={<IconSlidersTwoOutlineRegular size={13} />} onClick={() => setThreadFilterTarget(thread)} />
                    <Button size="sm" variant="toolbar" aria-label={t('data.thread.branch')} title={t('data.thread.branch')} icon={<IconBranchOutlineRegular size={13} />} onClick={() => void mutate(async () => { await forkThread(thread.id); show(t('data.toast.branched'), 'success') })} />
                    <Button size="sm" variant="toolbar" aria-label={t('data.thread.rename')} title={t('data.thread.rename')} icon={<IconEditOutlineRegular size={13} />} onClick={() => setRenameThreadTarget(thread)} />
                    <Button size="sm" variant="toolbar" aria-label={t('data.thread.delete')} title={t('data.thread.delete')} icon={<IconTrashOutlineRegular size={13} />} style={{ color: colors.danger }} onClick={() => setDeleteTarget({ kind: 'thread', thread })} />
                  </div>
                  {(thread.filters ?? []).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                      {thread.filters!.map((filter) => (
                        <span key={filter.column} style={styles.badge}>{filter.column} = {filter.values.join(', ')}</span>
                      ))}
                      <Button size="sm" variant="ghost" aria-label={t('data.chart.clearFilters')} onClick={() => void mutate(() => setThreadFilters(thread.id, []), t('data.toast.saved'))}>×</Button>
                    </div>
                  )}
                  <div className={`tentacle-data-thread-cards`} style={styles.threadCards}>
                    {cards.length === 0 && <p style={styles.threadEmpty}>{t('data.thread.emptyHint')}</p>}
                    {cards.map((card) => {
                      const selected = card.id === selectedCardId
                      if (card.kind === 'chart') {
                        return (
                          <div key={card.id} data-chart-id={card.id} style={{ ...styles.card, ...(selected ? styles.cardSelected : {}) }} onClick={() => { setPreviewDatasetId(undefined); setSelectedCardId(card.id) }}>
                            <DefaultCardHeader card={card} onOpen={() => { setPreviewDatasetId(undefined); setSelectedCardId(card.id) }} onDelete={() => setDeleteTarget({ kind: 'card', card })} />
                            <div style={styles.cardBody}>
                              {card.spec.title !== undefined && card.spec.title !== card.title && (
                                <p style={{ ...styles.tiny, margin: '0 0 4px' }}>{card.spec.title}</p>
                              )}
                              <ChartView card={card} rows={rowsOf(card.datasetId)} height={220} extraFilters={thread.filters} extraRanges={thread.ranges} />
                            </div>
                            <QuickChartBar
                              t={t}
                              card={card}
                              onType={(chart) => void switchChart(card, chart)}
                              onTheme={(theme) => void patchChart(card, { theme })}
                              onAnnotations={(annotations) => void patchChart(card, { annotations })}
                            />
                          </div>
                        )
                      }
                      if (card.kind === 'dataset') {
                        const dataset = datasetOf(state, card.datasetId)
                        return (
                          <div key={card.id} data-chart-id={card.id} style={{ ...styles.card, ...(selected ? styles.cardSelected : {}) }} onClick={() => { setPreviewDatasetId(undefined); setSelectedCardId(card.id) }}>
                            <DefaultCardHeader card={card} onOpen={() => { setPreviewDatasetId(undefined); setSelectedCardId(card.id) }} onDelete={() => setDeleteTarget({ kind: 'card', card })} />
                            <div style={styles.cardBody}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: colors.secondary, fontSize: 11 }}>
                                <IconDatabaseOutlineRegular size={13} />
                                <span>{dataset === undefined ? t('data.error.noDataset') : `${fmt(t('data.dataset.rows'), { n: String(dataset.rowCount) })} · ${fmt(t('data.dataset.cols'), { n: String(dataset.columns.length) })}`}</span>
                                {dataset?.operation !== undefined && <span style={styles.badge}>{t('data.dataset.derived')}</span>}
                                {dataset?.join !== undefined && <span style={styles.badge}>{t('data.dataset.joined')}</span>}
                              </div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                                {dataset?.columns.slice(0, 8).map((column) => (
                                  <span key={column.name} style={styles.badge} title={column.type}>{column.name}</span>
                                ))}
                                {(dataset?.columns.length ?? 0) > 8 && <span style={styles.badge}>+{(dataset?.columns.length ?? 0) - 8}</span>}
                              </div>
                            </div>
                          </div>
                        )
                      }
                      if (card.kind === 'plan') {
                        const plan = card as PlanCard
                        return (
                          <div key={plan.id} style={{ ...styles.card, ...(selected ? styles.cardSelected : {}) }} onClick={() => { setPreviewDatasetId(undefined); setSelectedCardId(plan.id) }}>
                            <DefaultCardHeader card={plan} onOpen={() => { setPreviewDatasetId(undefined); setSelectedCardId(plan.id) }} onDelete={() => setDeleteTarget({ kind: 'card', card: plan })} />
                            <div style={styles.cardBody}>
                              <p style={{ ...styles.help, margin: '0 0 4px' }}>{plan.prompt}</p>
                              {plan.steps.map((step, index) => (
                                <p key={index} style={{ ...styles.tiny, margin: '2px 0', color: step.startsWith('✗') ? colors.danger : step.startsWith('✓') ? colors.accent : colors.secondary }}>{step}</p>
                              ))}
                            </div>
                          </div>
                        )
                      }
                      const note = card as NoteCard
                      return (
                        <div key={note.id} style={{ ...styles.card, ...(selected ? styles.cardSelected : {}) }} onClick={() => setSelectedCardId(note.id)}>
                          <DefaultCardHeader card={note} onOpen={() => { setPreviewDatasetId(undefined); setSelectedCardId(note.id) }} onDelete={() => setDeleteTarget({ kind: 'card', card: note })} />
                          <div style={styles.cardBody}><p style={{ ...styles.hint, whiteSpace: 'pre-wrap' }}>{note.text || t('data.card.noteHint')}</p></div>
                        </div>
                      )
                    })}
                  </div>
                  <div style={styles.threadFooter}>
                    <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular size={13} />} onClick={() => openChart(thread)} disabled={threadDatasetList.length === 0}>{t('data.card.addChart')}</Button>
                  </div>
                </div>
              )
            })}
        </section>

        <aside style={styles.inspector}>
          <h3 style={styles.inspectorTitle}>{t('data.inspector.title')}</h3>
          {previewDataset !== undefined
            ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <p style={styles.hint}>{previewDataset.name}</p>
                <div style={{ display: 'grid', gap: 3, fontSize: 11, color: colors.secondary }}>
                  <span>{fmt(t('data.dataset.rows'), { n: String(previewDataset.rowCount) })} · {fmt(t('data.dataset.cols'), { n: String(previewDataset.columns.length) })}</span>
                  <span>{previewDataset.columns.map((column) => column.name).join(' · ')}</span>
                </div>
                <DatasetTable rows={rowsOf(previewDataset.id)} t={t} />
              </div>
            )
            : selectedCard === undefined
            ? <p style={styles.help}>{t('data.inspector.empty')}</p>
            : selectedCard.kind === 'chart'
              ? (
                <ChartInspector
                  t={t}
                  card={selectedCard}
                  datasets={datasets}
                  rows={rowsOf(selectedCard.datasetId)}
                  onEdit={() => {
                    const thread = threadOf(state, selectedCard.threadId)
                    if (thread !== undefined) openChart(thread, selectedCard)
                  }}
                  onDelete={() => setDeleteTarget({ kind: 'card', card: selectedCard })}
                  onSwitch={(chart) => void switchChart(selectedCard, chart)}
                  onTheme={(theme) => void patchChart(selectedCard, { theme })}
                  onFilters={(filters) => void patchChart(selectedCard, { filters })}
                  onAnnotations={(annotations) => void patchChart(selectedCard, { annotations })}
                  onColor={(color, size, facet) => void patchChart(selectedCard, { color, size, facet })}
                  onRange={(range) => void patchChart(selectedCard, { range })}
                  onAggregate={(aggregate) => void patchChart(selectedCard, { aggregate })}
                  onSort={(sort) => void patchChart(selectedCard, { sort })}
                  onValue={(value) => void patchChart(selectedCard, { value })}
                  onOhlc={(key, value) => void patchChart(selectedCard, { [key]: value })}
                  onX2={(value) => void patchChart(selectedCard, { x2: value })}
                  onGoal={(value) => void patchChart(selectedCard, { goal: value })}
                  onY2={(value) => void patchChart(selectedCard, { y2: value })}
                  onFlintOption={(key, value) => void patchChart(selectedCard, { chartProperties: { ...(selectedCard.spec.chartProperties ?? {}), [key]: value } })}
                  onVariant={(spec) => void patchChart(selectedCard, spec)}
                  onDropEncoding={(channel, column) => void patchChart(selectedCard, channel === 'size' ? { size: column } : { [channel]: column })}
                  onRefined={async (rationale) => {
                    await reload()
                    setSelectedCardId(selectedCard.id)
                    show(rationale ?? t('data.chart.refined'), 'success')
                  }}
                  onDuplicate={() => void duplicateChart(selectedCard)}
                  onExport={() => void exportChart(selectedCard)}
                />
              )
              : selectedCard.kind === 'dataset'
                ? (() => {
                  const dataset = datasetOf(state, selectedCard.datasetId)
                  if (dataset === undefined) return <p style={styles.help}>{t('data.error.noDataset')}</p>
                  return (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <p style={styles.hint}>{dataset.name}</p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        <span style={styles.badge}>{fmt(t('data.dataset.rows'), { n: String(dataset.rowCount) })}</span>
                        <span style={styles.badge}>{fmt(t('data.dataset.cols'), { n: String(dataset.columns.length) })}</span>
                        {dataset.operation !== undefined && <span style={styles.badge}>{t('data.dataset.derived')}</span>}
                        {dataset.join !== undefined && <span style={styles.badge}>{t('data.dataset.joined')}</span>}
                        {dataset.source !== undefined && <span style={styles.badge}>{dataset.source.kind === 'url' ? t('data.dataset.sourceUrl') : t('data.dataset.sourceWorkspace')}</span>}
                      </div>
                      {dataset.source !== undefined && (
                        <p style={styles.help}>
                          {dataset.source.kind === 'url' ? dataset.source.url : dataset.source.path}
                          {dataset.refreshedAt !== undefined && ` · ${fmt(t('data.dataset.refreshedAt'), { time: new Date(dataset.refreshedAt).toLocaleString() })}`}
                        </p>
                      )}
                      {dataset.source !== undefined && (
                        <label style={styles.field}>
                          <span style={styles.label}>{t('data.dataset.autoRefresh')}</span>
                          <select
                            value={String(dataset.autoRefreshSec ?? 0)}
                            onChange={(event) => void changeAutoRefresh(dataset, Number(event.target.value))}
                            style={styles.input}
                          >
                            <option value="0">{t('data.dataset.autoOff')}</option>
                            <option value="60">{t('data.dataset.auto1m')}</option>
                            <option value="300">{t('data.dataset.auto5m')}</option>
                            <option value="900">{t('data.dataset.auto15m')}</option>
                            <option value="3600">{t('data.dataset.auto1h')}</option>
                          </select>
                        </label>
                      )}
                      {dataset.lastRefreshError !== undefined && (
                        <p style={{ ...styles.help, color: colors.danger }}>{fmt(t('data.dataset.refreshError'), { message: dataset.lastRefreshError })}</p>
                      )}
                      {dataset.operation !== undefined && <p style={styles.help}>{operationSummary(dataset.operation)}</p>}
                      {dataset.join !== undefined && <p style={styles.help}>{joinSummary(dataset.join, datasets)}</p>}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular size={13} />} onClick={() => setDeriveTarget({ dataset, threadId: selectedCard.threadId })}>{t('data.derive.title')}</Button>
                        <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular size={13} />} disabled={datasets.length < 2} onClick={() => setJoinTarget({ dataset, threadId: selectedCard.threadId })}>{t('data.join.title')}</Button>
                        {dataset.source !== undefined && (
                          <Button size="sm" variant="outline" icon={<IconRefreshOutlineRegular size={13} />} onClick={() => void refresh(dataset)}>{t('data.dataset.refresh')}</Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => {
                          const rows = rowsOf(dataset.id)
                          if (rows !== undefined) downloadText(`${safeFilename(dataset.name)}.csv`, rowsToCsv(rows), 'text/csv;charset=utf-8')
                        }}>{t('data.dataset.exportCsv')}</Button>
                      </div>
                      {(() => {
                        const datasetRows = rowsOf(dataset.id)
                        const recommendations = datasetRows === undefined ? [] : recommendCharts(datasetRows)
                        if (recommendations.length === 0) return null
                        return (
                          <div style={{ display: 'grid', gap: 6 }}>
                            <p style={{ ...styles.label, marginTop: 2 }}>{t('data.chart.recommendations')}</p>
                            {recommendations.map((recommendation, index) => {
                              const previewCard: ChartCard = {
                                id: `recommendation-${index}`,
                                threadId: selectedCard.threadId,
                                kind: 'chart',
                                title: recommendation.spec.title ?? 'chart',
                                createdAt: 0,
                                datasetId: dataset.id,
                                spec: recommendation.spec,
                              }
                              return (
                                <div key={index} style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: 8, background: colors.layer2 }}>
                                  <ChartView card={previewCard} rows={datasetRows} height={110} />
                                  <p style={{ ...styles.help, margin: '4px 0' }}>{recommendationReason(t, recommendation.spec)}</p>
                                  <Button size="sm" variant="outline" onClick={() => void addRecommendation(dataset, selectedCard.threadId, recommendation)}>{t('data.chart.add')}</Button>
                                </div>
                              )
                            })}
                          </div>
                        )
                      })()}
                      <DatasetTable rows={rowsOf(dataset.id)} t={t} />
                    </div>
                  )
                })()
                : selectedCard.kind === 'plan'
                  ? (
                    <div style={{ display: 'grid', gap: 6 }}>
                      <p style={styles.hint}>{selectedCard.prompt}</p>
                      {selectedCard.steps.map((step, index) => (
                        <p key={index} style={{ ...styles.tiny, margin: 0, color: step.startsWith('✗') ? colors.danger : step.startsWith('✓') ? colors.accent : colors.secondary }}>{step}</p>
                      ))}
                    </div>
                  )
                  : <p style={{ ...styles.hint, whiteSpace: 'pre-wrap' }}>{selectedCard.text}</p>}
        </aside>
      </div>

      {asking && (
        <div style={{ ...styles.planLive }}>
          <style>{`@keyframes tentacle-plan-shimmer { 0%, 100% { opacity: .45 } 50% { opacity: 1 } }`}</style>
          <div style={{ ...styles.agentPlanRunning }}>
            <span style={{ animation: 'tentacle-plan-shimmer 1.4s ease-in-out infinite' }}>◌</span>
            <span>{t('data.agent.planRunning')}</span>
          </div>
          {liveSteps.map((step, index) => (
            <p key={index} style={{ ...styles.tiny, margin: '2px 0', color: step.startsWith('✗') ? colors.danger : colors.secondary }}>{step}</p>
          ))}
          {liveSteps.length === 0 && <p style={{ ...styles.tiny, margin: 0, color: colors.tertiary }}>{t('data.agent.planWaiting')}</p>}
        </div>
      )}
      <div style={styles.agentBar}>
        <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 4 }}>
          <Input
            aria-label={t('data.agent.placeholder')}
            placeholder={activeThreadDataset === undefined ? t('data.dataset.emptyHint') : t('data.agent.placeholder')}
            value={question}
            disabled={asking || activeThreadDataset === undefined}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void ask() }}
          />
          <span style={styles.help}>{t('data.agent.hint')}</span>
        </div>
        <Button
          variant="primary"
          icon={<IconSendOutlineRegular size={16} />}
          disabled={asking || activeThreadDataset === undefined || question.trim() === ''}
          onClick={() => void ask()}
        >
          {asking ? t('data.agent.thinking') : t('data.agent.ask')}
        </Button>
      </div>
      </>
      )}

      {importOpen && (
        <ImportDialog
          t={t}
          workspaceId={workspaceId}
          onImported={() => { setImportOpen(false); show(t('data.toast.imported'), 'success'); void reload() }}
          onClose={() => setImportOpen(false)}
        />
      )}
      {workspaceOpen && (
        <NameDialog t={t} title={t('data.workspace.new')} label={t('data.workspace.name')} onSubmit={async (name) => {
          const workspace = await createWorkspace(name)
          setWorkspaceOpen(false)
          setWorkspaceId(workspace.id)
          show(t('data.toast.created'), 'success')
          await reload()
        }} onClose={() => setWorkspaceOpen(false)} />
      )}
      {threadOpen && (
        <ThreadDialog t={t} datasets={datasets} onCreate={createThreadFromDataset} onClose={() => setThreadOpen(false)} />
      )}
      {renameThreadTarget !== undefined && (
        <NameDialog
          t={t}
          title={t('data.thread.rename')}
          label={t('data.thread.name')}
          initial={renameThreadTarget.name}
          onSubmit={async (name) => {
            await renameThread(renameThreadTarget.id, name)
            setRenameThreadTarget(undefined)
            show(t('data.toast.saved'), 'success')
            await reload()
          }}
          onClose={() => setRenameThreadTarget(undefined)}
        />
      )}
      {chartDraft !== undefined && (
        <ChartDialog
          t={t}
          draft={chartDraft}
          datasets={datasets}
          rowsOf={rowsOf}
          onSubmit={submitChart}
          onClose={() => setChartDraft(undefined)}
        />
      )}
      {deriveTarget !== undefined && (
        <DeriveDialog t={t} dataset={deriveTarget.dataset} onSubmit={submitDerive} onClose={() => setDeriveTarget(undefined)} />
      )}
      {joinTarget !== undefined && (
        <JoinDialog
          t={t}
          dataset={joinTarget.dataset}
          datasets={datasets}
          relations={state.relations.filter((relation) => relation.workspaceId === workspaceId)}
          onSubmit={async (input) => {
            const joined = await joinDatasets({
              leftDatasetId: joinTarget.dataset.id,
              rightDatasetId: input.rightDatasetId,
              leftColumn: input.leftColumn,
              rightColumn: input.rightColumn,
              how: input.how,
              name: input.name,
            })
            await createCard({ threadId: joinTarget.threadId, kind: 'dataset', title: joined.name, datasetId: joined.id })
            setJoinTarget(undefined)
            show(t('data.join.created'), 'success')
            await reload()
          }}
          onClose={() => setJoinTarget(undefined)}
        />
      )}
      {objectStoreOpen && (
        <ObjectStoreDialog
          t={t}
          workspaceId={workspaceId}
          onImported={() => { setObjectStoreOpen(false); show(t('data.connector.objectImported'), 'success'); void reload() }}
          onClose={() => setObjectStoreOpen(false)}
        />
      )}
      {databaseOpen && (
        <DatabaseDialog
          t={t}
          workspaceId={workspaceId}
          onImported={() => { setDatabaseOpen(false); show(t('data.connector.databaseImported'), 'success'); void reload() }}
          onClose={() => setDatabaseOpen(false)}
        />
      )}
      {workspaceFileOpen && (
        <WorkspaceFileDialog
          t={t}
          workspaceId={workspaceId}
          onImported={() => { setWorkspaceFileOpen(false); show(t('data.connector.workspaceImported'), 'success'); void reload() }}
          onClose={() => setWorkspaceFileOpen(false)}
        />
      )}
      {sqliteOpen && (
        <SqliteDialog
          t={t}
          workspaceId={workspaceId}
          onImported={() => { setSqliteOpen(false); show(t('data.connector.imported'), 'success'); void reload() }}
          onClose={() => setSqliteOpen(false)}
        />
      )}
      {threadFilterTarget !== undefined && (
        <ThreadFilterDialog
          t={t}
          datasets={threadDatasets(threadFilterTarget)}
          rowsOf={rowsOf}
          filters={threadFilterTarget.filters ?? []}
          ranges={threadFilterTarget.ranges ?? []}
          onSubmit={async (filters, ranges) => {
            const next = await setThreadFilters(threadFilterTarget.id, filters, ranges)
            setThreadFilterTarget(undefined)
            setState((current) => current === undefined ? current : { ...current, threads: current.threads.map((thread) => thread.id === next.id ? next : thread) })
            await reload()
            show(t('data.toast.saved'), 'success')
          }}
          onClose={() => setThreadFilterTarget(undefined)}
        />
      )}
      {relationSuggestOpen && (
        <SuggestRelationsDialog
          t={t}
          workspaceId={workspaceId}
          onCreate={async (suggestion) => {
            await createRelation({
              workspaceId,
              leftDatasetId: suggestion.leftDatasetId,
              leftColumn: suggestion.leftColumn,
              rightDatasetId: suggestion.rightDatasetId,
              rightColumn: suggestion.rightColumn,
            })
            await reload()
            show(t('data.relation.created'), 'success')
          }}
          onClose={() => setRelationSuggestOpen(false)}
        />
      )}
      {relationOpen && (
        <RelationDialog
          t={t}
          datasets={datasets}
          onSubmit={async (input) => {
            await createRelation({ workspaceId, ...input })
            setRelationOpen(false)
            show(t('data.relation.created'), 'success')
            await reload()
          }}
          onClose={() => setRelationOpen(false)}
        />
      )}
      {deleteTarget !== undefined && (
        <ConfirmDialog
          t={t}
          title={t('data.action.delete')}
          description={deleteTarget.kind === 'thread' ? deleteTarget.thread.name : deleteTarget.kind === 'card' ? deleteTarget.card.title : deleteTarget.dataset.name}
          onConfirm={confirmDelete}
          onClose={() => setDeleteTarget(undefined)}
        />
      )}
      {toast !== undefined && <Toast key={toast.seq} text={toast.text} tone={toast.tone} onDone={done} />}
    </div>
  )
}

function ThreadDialog({ t, datasets, onCreate, onClose }: {
  t: Translate
  datasets: readonly DatasetMeta[]
  onCreate: (name: string, datasetId: string | undefined) => Promise<void>
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState('')
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? '')
  return (
    <Modal
      open
      onClose={onClose}
      title={t('data.thread.new')}
      closeLabel={t('data.action.close')}
      className="tentacle-data-dialog"
      contentClassName="tentacle-data-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose}>{t('data.action.cancel')}</Button>
          <Button variant="primary" disabled={name.trim() === ''} onClick={() => void onCreate(name.trim(), datasetId === '' ? undefined : datasetId)}>{t('data.action.create')}</Button>
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.thread.name')}</span>
          <Input aria-label={t('data.thread.name')} value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.thread.dataset')}</span>
          <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)} style={styles.input}>
            <option value="">—</option>
            {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
          </select>
        </label>
      </div>
    </Modal>
  )
}

function ChartInspector({ t, card, datasets, rows, onEdit, onDelete, onSwitch, onTheme, onFilters, onAnnotations, onColor, onRange, onAggregate, onSort, onValue, onOhlc, onX2, onGoal, onY2, onFlintOption, onVariant, onDropEncoding, onRefined, onDuplicate, onExport }: {
  t: Translate
  card: ChartCard
  datasets: readonly DatasetMeta[]
  rows: DatasetRows | undefined
  onEdit: () => void
  onDelete: () => void
  onSwitch: (chart: ChartKind) => void
  onTheme: (theme: ChartTheme) => void
  onFilters: (filters: readonly ChartFilter[]) => void
  onAnnotations: (annotations: ChartAnnotations) => void
  onColor: (color: string | undefined, size?: string | undefined, facet?: string | undefined) => void
  onRange: (range: ChartRange | undefined) => void
  onAggregate: (aggregate: ChartAggregate) => void
  onSort: (sort: ChartSort) => void
  onValue: (value: string | undefined) => void
  onOhlc: (key: 'open' | 'high' | 'low' | 'close', value: string | undefined) => void
  onX2: (value: string | undefined) => void
  onGoal: (value: string | undefined) => void
  onY2: (value: string | undefined) => void
  onFlintOption: (key: string, value: unknown) => void
  onVariant: (spec: ChartSpec) => void
  onDropEncoding: (channel: 'x' | 'y' | 'color' | 'size' | 'facet', column: string) => void
  onRefined: (rationale?: string) => Promise<void>
  onDuplicate: () => void
  onExport: () => void
}): ReactElement {
  const dataset = datasets.find((row) => row.id === card.datasetId)
  const [filterColumn, setFilterColumn] = useState('')
  const [filterValue, setFilterValue] = useState('')
  const [instruction, setInstruction] = useState('')
  const [refining, setRefining] = useState(false)
  const [refineError, setRefineError] = useState('')
  const [fieldQuery, setFieldQuery] = useState('')
  const [fieldType, setFieldType] = useState<'all' | 'number' | 'string' | 'boolean' | 'date'>('all')
  const [rangeColumn, setRangeColumn] = useState(card.spec.range?.column ?? '')
  const [rangeMin, setRangeMin] = useState(card.spec.range?.min === undefined ? '' : String(card.spec.range.min))
  const [rangeMax, setRangeMax] = useState(card.spec.range?.max === undefined ? '' : String(card.spec.range.max))
  const filterable = rows?.columns.filter((column) => column.type === 'string' || column.type === 'boolean') ?? []
  const values = rows === undefined || filterColumn === ''
    ? []
    : [...new Set(rows.rows.map((row) => String(row[filterColumn] ?? '')).filter((value) => value !== ''))].slice(0, 30)
  const filters = card.spec.filters ?? []
  const flintControls = isFlintChart(card.spec.chart) ? flintOptions(card, rows) : []
  useEffect(() => {
    setRangeColumn(card.spec.range?.column ?? '')
    setRangeMin(card.spec.range?.min === undefined ? '' : String(card.spec.range.min))
    setRangeMax(card.spec.range?.max === undefined ? '' : String(card.spec.range.max))
  }, [card.spec.range?.column, card.spec.range?.min, card.spec.range?.max])
  const applyRange = (): void => {
    if (rangeColumn === '') { onRange(undefined); return }
    const min = rangeMin.trim() === '' ? undefined : Number(rangeMin)
    const max = rangeMax.trim() === '' ? undefined : Number(rangeMax)
    if (min !== undefined && !Number.isFinite(min)) return
    if (max !== undefined && !Number.isFinite(max)) return
    onRange({ column: rangeColumn, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) })
  }
  const refine = async (): Promise<void> => {
    if (instruction.trim() === '' || refining) return
    setRefining(true); setRefineError('')
    try {
      const result = await refineChart({ cardId: card.id, instruction: instruction.trim() })
      if (result.kind === 'out_of_scope') {
        setRefineError(fmt(t('data.chart.refineOutOfScope'), { reason: result.rationale ?? '' }))
        return
      }
      setInstruction('')
      await onRefined(result.rationale)
    } catch (err) { setRefineError(errorText(t, err)) } finally { setRefining(false) }
  }
  const setFilter = (column: string, value: string): void => {
    if (column === '' || value === '') return
    const next = filters.filter((filter) => filter.column !== column)
    onFilters([...next, { column, values: [value] }])
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <p style={{ ...styles.hint, fontSize: 12 }}>{card.title}</p>
      <label style={styles.field}>
        <span style={styles.label}>{t('data.chart.kind')}</span>
        <select value={card.spec.chart} onChange={(event) => onSwitch(event.target.value as ChartKind)} style={styles.input}>
          <option value="bar">{t('data.chart.bar')}</option>
          <option value="line">{t('data.chart.line')}</option>
          <option value="area">{t('data.chart.area')}</option>
          <option value="scatter">{t('data.chart.scatter')}</option>
          <option value="pie">{t('data.chart.pie')}</option>
          <option value="donut">{t('data.chart.donut')}</option>
          <option value="horizontalBar">{t('data.chart.horizontalBar')}</option>
          <option value="heatmap">{t('data.chart.heatmap')}</option>
          <option value="boxplot">{t('data.chart.boxplot')}</option>
          <option value="bump">{t('data.chart.bump')}</option>
          <option value="streamgraph">{t('data.chart.streamgraph')}</option>
          <option value="waterfall">{t('data.chart.waterfall')}</option>
          <option value="rose">{t('data.chart.rose')}</option>
          <option value="radar">{t('data.chart.radar')}</option>
          <option value="groupedBar">{t('data.chart.groupedBar')}</option>
          <option value="stackedBar">{t('data.chart.stackedBar')}</option>
          <option value="candlestick">{t('data.chart.candlestick')}</option>
          <option value="gantt">{t('data.chart.gantt')}</option>
          <option value="histogram">{t('data.chart.histogram')}</option>
          <option value="density">{t('data.chart.density')}</option>
          <option value="violin">{t('data.chart.violin')}</option>
          <option value="kpi">{t('data.chart.kpi')}</option>
          <option value="rangeArea">{t('data.chart.rangeArea')}</option>
          <option value="bullet">{t('data.chart.bullet')}</option>
          <option value="barTable">{t('data.chart.barTable')}</option>
          <option value="table">{t('data.chart.table')}</option>
          <option value="rangeDot">{t('data.chart.rangeDot')}</option>
          <option value="map">{t('data.chart.map')}</option>
          <option value="choropleth">{t('data.chart.choropleth')}</option>
          <option value="marginal">{t('data.chart.marginal')}</option>
          <option value="regression">{t('data.chart.regression')}</option>
          <option value="connectedScatter">{t('data.chart.connectedScatter')}</option>
          <option value="strip">{t('data.chart.strip')}</option>
          <option value="lollipop">{t('data.chart.lollipop')}</option>
          <option value="pyramid">{t('data.chart.pyramid')}</option>
          <option value="slope">{t('data.chart.slope')}</option>
          <option value="sparkline">{t('data.chart.sparkline')}</option>
          <option value="ridgeline">{t('data.chart.ridgeline')}</option>
          <option value="ecdf">{t('data.chart.ecdf')}</option>
          <option value="calendarHeatmap">{t('data.chart.calendarHeatmap')}</option>
        </select>
      </label>
      {card.spec.chart === 'rangeArea' && (
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.y2')}</span>
          <select value={card.spec.y2 ?? ''} onChange={(event) => onY2(event.target.value === '' ? undefined : event.target.value)} style={styles.input}>
            <option value="">{t('data.chart.noChannel')}</option>
            {(rows?.columns ?? []).filter((column) => column.type === 'number').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
          </select>
        </label>
      )}
      {(card.spec.chart === 'kpi' || card.spec.chart === 'bullet') && (
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.goal')}</span>
          <select value={card.spec.goal ?? ''} onChange={(event) => onGoal(event.target.value === '' ? undefined : event.target.value)} style={styles.input}>
            <option value="">{t('data.chart.noChannel')}</option>
            {(rows?.columns ?? []).filter((column) => column.type === 'number').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
          </select>
        </label>
      )}
      {card.spec.chart === 'gantt' && (
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.x2')}</span>
          <select value={card.spec.x2 ?? ''} onChange={(event) => onX2(event.target.value === '' ? undefined : event.target.value)} style={styles.input}>
            <option value="">{t('data.chart.noChannel')}</option>
            {(rows?.columns ?? []).map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
          </select>
        </label>
      )}
      {card.spec.chart === 'candlestick' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 6 }}>
          {(['open', 'high', 'low', 'close'] as const).map((key) => (
            <label key={key} style={styles.field}>
              <span style={styles.label}>{t(`data.chart.${key}` as DataStudioLocaleKey)}</span>
              <select value={card.spec[key] ?? ''} onChange={(event) => onOhlc(key, event.target.value === '' ? undefined : event.target.value)} style={styles.input}>
                <option value="">{t('data.chart.noChannel')}</option>
                {(rows?.columns ?? []).filter((column) => column.type === 'number').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
      {card.spec.chart === 'heatmap' && (
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.value')}</span>
          <select value={card.spec.value ?? ''} onChange={(event) => onValue(event.target.value === '' ? undefined : event.target.value)} style={styles.input}>
            <option value="">{t('data.chart.noChannel')}</option>
            {(rows?.columns ?? []).filter((column) => column.type === 'number').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
          </select>
        </label>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 6 }}>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.aggregate')}</span>
          <select value={card.spec.aggregate} onChange={(event) => onAggregate(event.target.value as ChartAggregate)} style={styles.input}>
            <option value="sum">{t('data.chart.sum')}</option>
            <option value="avg">{t('data.chart.avg')}</option>
            <option value="count">{t('data.chart.count')}</option>
            <option value="none">{t('data.chart.none')}</option>
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.sort')}</span>
          <select value={card.spec.sort ?? 'none'} onChange={(event) => onSort(event.target.value as ChartSort)} style={styles.input}>
            <option value="none">{t('data.chart.sortNone')}</option>
            <option value="asc">{t('data.chart.sortAsc')}</option>
            <option value="desc">{t('data.chart.sortDesc')}</option>
          </select>
        </label>
      </div>
      {flintControls.length > 0 && (
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={styles.label}>{t('data.chart.flintProperties')}</span>
          {flintControls.map((option) => {
            const value = card.spec.chartProperties?.[option.key] ?? option.value
            if (option.type === 'continuous') {
              return (
                <label key={option.key} style={{ display: 'grid', gridTemplateColumns: '1fr 90px', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <span>{option.label}</span>
                  <Input aria-label={option.label} type="number" min={option.min} max={option.max} step={option.step ?? 1} value={String(value ?? option.min ?? 0)} onChange={(event) => onFlintOption(option.key, Number(event.target.value))} />
                </label>
              )
            }
            if (option.type === 'binary') {
              return (
                <label key={option.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <input type="checkbox" checked={value === true} onChange={(event) => onFlintOption(option.key, event.target.checked)} />
                  {option.label}
                </label>
              )
            }
            return (
              <label key={option.key} style={{ display: 'grid', gridTemplateColumns: '1fr 120px', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <span>{option.label}</span>
                <select value={String(value ?? '')} onChange={(event) => onFlintOption(option.key, event.target.value)} style={styles.input}>
                  {(option.options ?? []).map((entry) => <option key={String(entry.value)} value={String(entry.value)}>{entry.label}</option>)}
                </select>
              </label>
            )
          })}
        </div>
      )}
      {(card.variants?.length ?? 0) > 0 && (
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={styles.label}>{t('data.chart.variants')}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {card.variants!.map((variant) => {
              const active = JSON.stringify(variant.spec) === JSON.stringify(card.spec)
              return (
                <button
                  key={variant.id}
                  type="button"
                  title={variant.rationale ?? variant.label}
                  onClick={() => onVariant(variant.spec)}
                  style={{
                    border: `1px solid ${active ? colors.accent : colors.border}`,
                    background: active ? colors.hover : 'transparent',
                    color: active ? colors.accent : colors.secondary,
                    borderRadius: 5, fontSize: 10, padding: '1px 6px', cursor: 'pointer',
                  }}
                >{variant.label}</button>
              )
            })}
          </div>
        </div>
      )}
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={styles.label}>{t('data.chart.fields')}</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 74px', gap: 4 }}>
          <Input aria-label={t('data.chart.searchFields')} placeholder={t('data.chart.searchFields')} value={fieldQuery} onChange={(event) => setFieldQuery(event.target.value)} />
          <select aria-label={t('data.chart.fieldType')} value={fieldType} onChange={(event) => setFieldType(event.target.value as typeof fieldType)} style={{ ...styles.input, fontSize: 10 }}>
            <option value="all">{t('data.chart.fieldAll')}</option>
            <option value="number">{t('data.chart.fieldNumber')}</option>
            <option value="string">{t('data.chart.fieldString')}</option>
            <option value="boolean">{t('data.chart.fieldBoolean')}</option>
            <option value="date">{t('data.chart.fieldDate')}</option>
          </select>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {(rows?.columns ?? []).filter((column) => (fieldType === 'all' || column.type === fieldType) && column.name.toLowerCase().includes(fieldQuery.trim().toLowerCase())).map((column) => (
            <span
              key={column.name}
              draggable
              onDragStart={(event) => { event.dataTransfer.setData('text/plain', column.name); event.dataTransfer.effectAllowed = 'copy' }}
              title={t('data.chart.dragHint')}
              style={{ ...styles.badge, cursor: 'grab', border: `1px solid ${colors.border}` }}
            >{column.name}</span>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 4 }}>
          {([
            ['x', t('data.chart.x'), card.spec.x],
            ['y', t('data.chart.y'), card.spec.y],
            ['color', t('data.chart.color'), card.spec.color],
            ['size', t('data.chart.size'), card.spec.size],
            ['facet', t('data.chart.facet'), card.spec.facet],
          ] as const).map(([channel, label, value]) => (
            <div
              key={channel}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                const column = event.dataTransfer.getData('text/plain')
                if (column !== '') onDropEncoding(channel, column)
              }}
              style={{ minWidth: 0, border: `1px dashed ${colors.border}`, borderRadius: 6, padding: '3px 5px', fontSize: 9, color: value === undefined ? colors.tertiary : colors.text }}
            >
              <div style={{ color: colors.tertiary }}>{label}</div>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value ?? '—'}</div>
            </div>
          ))}
        </div>
      </div>
      <label style={styles.field}>
        <span style={styles.label}>{t('data.chart.theme')}</span>
        <select value={card.spec.theme ?? 'default'} onChange={(event) => onTheme(event.target.value as ChartTheme)} style={styles.input}>
          <option value="default">{t('data.theme.default')}</option>
          <option value="warm">{t('data.theme.warm')}</option>
          <option value="cool">{t('data.theme.cool')}</option>
          <option value="mono">{t('data.theme.mono')}</option>
        </select>
      </label>
      <div style={styles.field}>
        <span style={styles.label}>{t('data.chart.annotations')}</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {([
            ['max', t('data.chart.annotateMax')],
            ['mean', t('data.chart.annotateMean')],
            ['labels', t('data.chart.annotateLabels')],
          ] as const).map(([key, label]) => (
            <label key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: colors.secondary }}>
              <input
                type="checkbox"
                checked={card.spec.annotations?.[key] === true}
                onChange={(event) => onAnnotations({ ...(card.spec.annotations ?? {}), [key]: event.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 6 }}>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.color')}</span>
          <select value={card.spec.color ?? ''} onChange={(event) => onColor(event.target.value === '' ? undefined : event.target.value)} style={styles.input}>
            <option value="">{t('data.chart.noChannel')}</option>
            {(rows?.columns ?? []).map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.label}>{t('data.chart.size')}</span>
          <select value={card.spec.size ?? ''} onChange={(event) => onColor(undefined, event.target.value === '' ? undefined : event.target.value)} style={styles.input} disabled={card.spec.chart !== 'scatter'}>
            <option value="">{t('data.chart.noChannel')}</option>
            {(rows?.columns ?? []).filter((column) => column.type === 'number').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
          </select>
        </label>
      </div>
      <label style={styles.field}>
        <span style={styles.label}>{t('data.chart.facet')}</span>
        <select value={card.spec.facet ?? ''} onChange={(event) => onColor(card.spec.color, card.spec.size, event.target.value === '' ? undefined : event.target.value)} style={styles.input}>
          <option value="">{t('data.chart.noChannel')}</option>
          {(rows?.columns ?? []).map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
        </select>
      </label>
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={styles.label}>{t('data.chart.range')}</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) auto', gap: 4 }}>
          <select value={rangeColumn} onChange={(event) => setRangeColumn(event.target.value)} style={styles.input} aria-label={t('data.chart.rangeColumn')}>
            <option value="">{t('data.chart.noChannel')}</option>
            {(rows?.columns ?? []).filter((column) => column.type === 'number').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
          </select>
          <Input aria-label={t('data.chart.rangeMin')} placeholder={t('data.chart.rangeMin')} value={rangeMin} disabled={rangeColumn === ''} onChange={(event) => setRangeMin(event.target.value)} />
          <Input aria-label={t('data.chart.rangeMax')} placeholder={t('data.chart.rangeMax')} value={rangeMax} disabled={rangeColumn === ''} onChange={(event) => setRangeMax(event.target.value)} />
          <Button size="sm" variant="outline" disabled={rangeColumn === ''} onClick={applyRange}>{t('data.chart.applyRange')}</Button>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={styles.label}>{t('data.chart.refine')}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <Input
            aria-label={t('data.chart.refine')}
            placeholder={t('data.chart.refinePlaceholder')}
            value={instruction}
            disabled={refining}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void refine() }}
          />
          <Button size="sm" variant="outline" disabled={refining || instruction.trim() === ''} onClick={() => void refine()}>
            {refining ? t('data.chart.refining') : t('data.chart.refineAction')}
          </Button>
        </div>
        {refineError !== '' && <p style={{ ...styles.help, color: colors.danger }}>{refineError}</p>}
      </div>
      {filterable.length > 0 && (
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={styles.label}>{t('data.chart.filters')}</span>
          {filters.map((filter) => (
            <div key={filter.column} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
              <span style={{ ...styles.badge }}>{filter.column} = {filter.values.join(', ')}</span>
              <Button size="sm" variant="ghost" aria-label={t('data.chart.clearFilters')} onClick={() => onFilters(filters.filter((candidate) => candidate.column !== filter.column))}>×</Button>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 6 }}>
            <select
              aria-label={t('data.chart.filterColumn')}
              value={filterColumn}
              onChange={(event) => { setFilterColumn(event.target.value); setFilterValue('') }}
              style={styles.input}
            >
              <option value="">{t('data.chart.filterColumn')}</option>
              {filterable.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
            <select
              aria-label={t('data.chart.filterValue')}
              value={filterValue}
              disabled={filterColumn === ''}
              onChange={(event) => { setFilterValue(event.target.value); setFilter(filterColumn, event.target.value) }}
              style={styles.input}
            >
              <option value="">{t('data.chart.filterValue')}</option>
              {values.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
        </div>
      )}
      <div style={{ display: 'grid', gap: 3, fontSize: 11, color: colors.secondary }}>
        <span>{t('data.chart.x')}: {card.spec.x}</span>
        {card.spec.y !== undefined && <span>{t('data.chart.y')}: {card.spec.y}</span>}
        <span>{t('data.chart.aggregate')}: {t(`data.chart.${card.spec.aggregate}` as DataStudioLocaleKey)}</span>
        <span>{t('data.thread.dataset')}: {dataset?.name ?? card.datasetId}</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Button size="sm" variant="outline" onClick={onEdit}>{t('data.chart.edit')}</Button>
        <Button size="sm" variant="ghost" onClick={onDuplicate}>{t('data.chart.duplicate')}</Button>
        <Button size="sm" variant="ghost" onClick={onExport}>{t('data.chart.exportPng')}</Button>
        <Button size="sm" variant="ghost" icon={<IconTrashOutlineRegular size={12} />} style={{ color: colors.danger }} onClick={onDelete} />
      </div>
      <DatasetTable rows={rows} t={t} />
    </div>
  )
}
