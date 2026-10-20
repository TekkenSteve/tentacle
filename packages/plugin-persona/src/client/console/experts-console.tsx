/**
 * The expert management page, mounted as a global main panel next to the
 * channels console (design 09 §3, the reference implementation's /experts page shape) — not as a
 * Settings section: an expert is a first-class operational resource, not a
 * preference.
 *
 * Two tabs: the user's expert instances (card grid) and the bundled template
 * library. Every write goes through `/tentacle/api/admin/experts`; the channel
 * projection is read-only and degrades to "no data" when the channels plugin
 * is absent, so the page stays usable in a persona-only deployment.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  SegmentedControl,
  SegmentedTabs,
  Tag,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../locales.ts'
import {
  errorText,
  listChannels,
  listExperts,
  listModelCatalog,
  listPermissionCatalog,
  listPresets,
  listTemplates,
  removeExpert,
  setDefaultExpert,
  text,
  type ChannelRow,
  type ExpertRow,
  type ModelCatalogRow,
  type PermissionCatalogRow,
  type PresetRow,
  type TemplateRow,
} from './api.ts'
import { DeleteExpertDialog, ExpertDetailDialog, ExpertEditorDialog, type EditorTarget } from './expert-dialogs.tsx'
import { ExpertCard } from './expert-card.tsx'
import { ExpertsTable } from './experts-table.tsx'
import { TemplateCard } from './template-card.tsx'
import { colors, styles } from './ui.ts'

type Tab = 'instances' | 'library'
type ViewMode = 'cards' | 'table'

const VIEW_STORAGE_KEY = 'tentacle:experts:view'

function loadViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'table' ? 'table' : 'cards'
  } catch {
    return 'cards'
  }
}

interface ToastMessage {
  readonly text: string
  readonly tone?: 'success'
  readonly seq: number
}

function matches(query: string, ...parts: Array<string | undefined>): boolean {
  if (query === '') return true
  return parts.some((part) => (part ?? '').toLowerCase().includes(query))
}

export function ExpertsConsoleView({ t, onOpenChannels }: {
  t: Translate
  /** Switch to the channels panel scoped to an expert (omit = action hidden). */
  onOpenChannels?: (expertId: string, create?: boolean) => void
}): ReactElement {
  const [experts, setExperts] = useState<readonly ExpertRow[]>([])
  const [templates, setTemplates] = useState<readonly TemplateRow[]>([])
  const [presets, setPresets] = useState<readonly PresetRow[]>([])
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogRow | undefined>(undefined)
  const [permissionCatalog, setPermissionCatalog] = useState<PermissionCatalogRow | undefined>(undefined)
  const [channels, setChannels] = useState<readonly ChannelRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(undefined)
  const [tab, setTab] = useState<Tab>('instances')
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode)
  const [editor, setEditor] = useState<EditorTarget | undefined>(undefined)
  const [detail, setDetail] = useState<ExpertRow | undefined>(undefined)
  const [pendingDelete, setPendingDelete] = useState<ExpertRow | undefined>(undefined)
  const [toast, setToast] = useState<ToastMessage | undefined>(undefined)

  const changeView = (next: ViewMode): void => {
    setViewMode(next)
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next)
    } catch {
      // Preference persistence is best-effort.
    }
  }

  const onToast = useCallback((message: string, tone?: 'success') => {
    setToast((current) => ({ text: message, ...(tone === undefined ? {} : { tone }), seq: (current?.seq ?? 0) + 1 }))
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [nextExperts, nextTemplates, nextPresets, nextChannels, nextModels, nextPermissions] = await Promise.all([
        listExperts(),
        listTemplates(),
        listPresets(),
        listChannels(),
        listModelCatalog(),
        listPermissionCatalog(),
      ])
      setExperts(nextExperts)
      setTemplates(nextTemplates)
      setPresets(nextPresets)
      setChannels(nextChannels)
      setModelCatalog(nextModels)
      setPermissionCatalog(nextPermissions)
      setError(undefined)
    } catch (loadError) {
      setError(loadError)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  /** Expert id → its channel instances (the cards and detail both need it). */
  const channelsByExpert = useMemo(() => {
    const map = new Map<string, ChannelRow[]>()
    for (const channel of channels) {
      if (channel.expertId === undefined) continue
      const rows = map.get(channel.expertId) ?? []
      rows.push(channel)
      map.set(channel.expertId, rows)
    }
    return map
  }, [channels])

  const templateById = useMemo(
    () => new Map(templates.map((template) => [template.id, template])),
    [templates],
  )
  const presetById = useMemo(
    () => new Map(presets.map((preset) => [preset.id, preset])),
    [presets],
  )

  const needle = query.trim().toLowerCase()
  const visibleExperts = useMemo(() => experts.filter((expert) => matches(
    needle,
    expert.id,
    expert.name.zh,
    expert.name.en,
    expert.description.zh,
    expert.description.en,
    expert.templateId,
  )), [experts, needle])

  const visibleTemplates = useMemo(() => templates.filter((template) => matches(
    needle,
    template.id,
    template.label.zh,
    template.label.en,
    template.description.zh,
    template.description.en,
  )), [templates, needle])

  const builtinCount = experts.filter((expert) => expert.builtin).length
  const boundChannels = channels.filter((channel) => channel.expertId !== undefined).length

  const closeEditor = (): void => setEditor(undefined)
  const closeDetail = (): void => setDetail(undefined)

  const afterSave = (): void => {
    closeEditor()
    closeDetail()
    void reload()
  }

  const makeDefault = async (expertId: string): Promise<void> => {
    try {
      await setDefaultExpert(expertId)
      onToast(t('experts.toast.defaultSet'), 'success')
      closeDetail()
      await reload()
    } catch (error) {
      onToast(errorText(t, error))
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (pendingDelete === undefined) return
    const expert = pendingDelete
    setPendingDelete(undefined)
    try {
      await removeExpert(expert.id)
      onToast(t('experts.toast.deleted'), 'success')
      if (detail?.id === expert.id) closeDetail()
      await reload()
    } catch (deleteError) {
      onToast(errorText(t, deleteError))
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={{ minWidth: 0 }}>
          <h2 style={styles.title}>{t('experts.panel')}</h2>
          <p style={styles.pageHint}>{t('experts.panel.hint')}</p>
          <div style={styles.stats}>
            <Tag tone="quiet">{t('experts.stats.total')} {experts.length}</Tag>
            <Tag tone="quiet">{t('experts.stats.builtin')} {builtinCount}</Tag>
            <Tag tone="quiet">{t('experts.stats.custom')} {experts.length - builtinCount}</Tag>
            <Tag tone="quiet">{t('experts.stats.channels')} {boundChannels}</Tag>
          </div>
        </div>
        <div style={styles.actions}>
          <Button
            variant="ghost"
            icon={<IconRefreshOutlineRegular size={16} />}
            disabled={loading}
            onClick={() => void reload()}
          >
            {t('experts.action.refresh')}
          </Button>
          <Button
            variant="primary"
            icon={<IconPlusOutlineRegular size={16} />}
            onClick={() => setEditor({ kind: 'create' })}
          >
            {t('experts.action.create')}
          </Button>
        </div>
      </header>

      <div style={styles.toolbar}>
        <SegmentedTabs<Tab>
          label={t('experts.panel')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'instances', label: t('experts.tab.instances'), id: 'tentacle-experts-tab-instances', panelId: 'tentacle-experts-panel-instances' },
            { value: 'library', label: t('experts.tab.library'), id: 'tentacle-experts-tab-library', panelId: 'tentacle-experts-panel-library' },
          ]}
        />
        <div style={styles.search}>
          <Input
            aria-label={t('experts.search.placeholder')}
            placeholder={t('experts.search.placeholder')}
            value={query}
            icon={<IconSearchOutlineRegular size={16} />}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <SegmentedControl<ViewMode>
          id="tentacle-experts-view"
          value={viewMode}
          label={t('experts.panel')}
          options={[
            { value: 'cards', label: t('experts.view.cards') },
            { value: 'table', label: t('experts.view.table') },
          ]}
          onChange={changeView}
        />
      </div>

      {error !== undefined && (
        <p style={{ ...styles.hint, color: colors.danger }}>
          {t('experts.error.load')} {errorText(t, error)}
        </p>
      )}

      {tab === 'instances'
        ? (
          <section id="tentacle-experts-panel-instances">
            {visibleExperts.length === 0
              ? (
                <div style={styles.empty}>
                  <p style={styles.emptyTitle}>{needle === '' ? t('experts.empty.title') : t('experts.empty.search')}</p>
                  {needle === '' && <p style={styles.hint}>{t('experts.empty.hint')}</p>}
                  {needle === '' && (
                    <Button variant="primary" icon={<IconPlusOutlineRegular size={16} />} onClick={() => setEditor({ kind: 'create' })}>
                      {t('experts.action.create')}
                    </Button>
                  )}
                </div>
              )
              : viewMode === 'table'
                ? (
                  <ExpertsTable
                    t={t}
                    experts={visibleExperts}
                    channelCountOf={(expertId) => channelsByExpert.get(expertId)?.length ?? 0}
                    onOpen={(expert) => setDetail(expert)}
                    onEdit={(expert) => setEditor({ kind: 'edit', expert })}
                  />
                )
                : (
                  <div style={styles.grid}>
                    {visibleExperts.map((expert) => (
                      <ExpertCard
                        key={expert.id}
                        t={t}
                        expert={expert}
                        channelCount={channelsByExpert.get(expert.id)?.length ?? 0}
                        onOpen={() => setDetail(expert)}
                        onEdit={() => setEditor({ kind: 'edit', expert })}
                        onDelete={() => setPendingDelete(expert)}
                        onChannels={() => onOpenChannels?.(expert.id)}
                      />
                    ))}
                  </div>
                )}
          </section>
        )
        : (
          <section id="tentacle-experts-panel-library">
            <p style={{ ...styles.hint, marginBottom: 12 }}>{t('experts.library.hint')}</p>
            {visibleTemplates.length === 0
              ? <div style={styles.empty}><p style={styles.emptyTitle}>{t('experts.library.empty')}</p></div>
              : (
                <div style={styles.grid}>
                  {visibleTemplates.map((template) => (
                    <TemplateCard
                      key={template.id}
                      t={t}
                      template={template}
                      onCopy={() => setEditor({ kind: 'copy', template })}
                    />
                  ))}
                </div>
              )}
          </section>
        )}

      {editor !== undefined && (
        <ExpertEditorDialog
          // Remount per target so the form state initializes from it.
          key={editor.kind === 'edit' ? `edit:${editor.expert.id}` : editor.kind === 'copy' ? `copy:${editor.template.id}` : 'create'}
          t={t}
          target={editor}
          presets={presets}
          modelCatalog={modelCatalog}
          permissionCatalog={permissionCatalog}
          onClose={closeEditor}
          onSaved={afterSave}
          onToast={onToast}
        />
      )}

      {detail !== undefined && (
        <ExpertDetailDialog
          t={t}
          expert={detail}
          template={detail.templateId === undefined ? undefined : templateById.get(detail.templateId)}
          channels={channelsByExpert.get(detail.id) ?? []}
          preset={presetById.get(detail.agentPreset)}
          onClose={closeDetail}
          onEdit={() => { setDetail(undefined); setEditor({ kind: 'edit', expert: detail }) }}
          onDelete={() => setPendingDelete(detail)}
          onSetDefault={() => void makeDefault(detail.id)}
          onManageChannels={() => { closeDetail(); onOpenChannels?.(detail.id) }}
          onNewChannel={() => { closeDetail(); onOpenChannels?.(detail.id, true) }}
          onToast={onToast}
          onSkillsChanged={() => void reload()}
        />
      )}

      {pendingDelete !== undefined && (
        <DeleteExpertDialog
          t={t}
          expert={pendingDelete}
          onCancel={() => setPendingDelete(undefined)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {toast !== undefined && (
        <Toast key={toast.seq} text={toast.text} {...(toast.tone === undefined ? {} : { tone: toast.tone })} onDone={() => setToast(undefined)} />
      )}
    </div>
  )
}
