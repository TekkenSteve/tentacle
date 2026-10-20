/**
 * The Tentacle channels console — a management loop equivalent to the reference implementation's
 * (design: docs/design/07-channel-admin.md §5), mounted as the `main` panel
 * the browser half declares.
 *
 * Three sections plus a modal editor, all fed by the same
 * `/tentacle/api/admin/channels` REST contract the host serves:
 *
 *  1. **instances** — stats, one row per instance (state dot, runtime line, a
 *     direct enable switch that is optimistic and rolled back on failure, and
 *     confirm-then-optimistic delete);
 *  2. **bindings** — for the selected instance: the identity table with
 *     unbind, plus a user-dropdown bind form;
 *  3. **conversations** — the read-only channel↔session link table.
 *
 * The visual language is the official one: every control is a
 * `@deepseek-ai/dsh-client-ui-primitives` atom and every color a `--dsw-*`
 * alias, so the page inherits the shell's theme instead of re-implementing it.
 * Transient outcomes are a `Toast`; every confirmation is a `Modal`.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconWarningOutlineRegular,
  Input,
  Tag,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  channelsCall,
  errorText,
  targetKey,
  targetOfKey,
  type BindableUser,
  type ChannelInstanceView,
  type ChannelOverview,
  type ChannelTarget,
  type ChannelTypeSchema,
  type ExpertRouteView,
  type InstanceRuntime,
  type TeamRouteView,
} from '../api.ts'
import { fmt, type Translate } from '../locales.ts'
import { BindingsSection } from './bindings-section.tsx'
import { ConnectionSection } from './connection-section.tsx'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { ConversationsSection } from './conversations-section.tsx'
import { sameTarget, type EditTarget, type ToastFn } from './contracts.ts'
import { ChannelForm } from './editor/channel-form.tsx'
import { InstanceRow } from './instance-row.tsx'
import { PlatformPicker } from './platform-picker.tsx'
import { platformMeta } from './platform.ts'
import { colors, styles } from './ui.ts'

/** Deferred navigation the unsaved-changes confirmation guards. */
type DiscardIntent =
  | { readonly kind: 'close' }
  | { readonly kind: 'switch'; readonly target: EditTarget }

interface ToastMessage {
  readonly text: string
  readonly tone?: 'success'
  /** Bumped per show so an identical message restarts the banner's cycle. */
  readonly seq: number
}

const EMPTY_OVERVIEW: ChannelOverview = { instances: [], bindings: [], conversations: [], pendingSenders: [] }

/**
 * Cross-panel protocol mirrored from @tentacle/persona
 * (`src/client/console/panel-events.ts`): the expert panel asks this console
 * to scope itself to one expert (and optionally open the create form). The
 * intent arrives on a window event when this panel is live, and through
 * sessionStorage when the panel is (re)mounted by the navigation itself.
 */
const OPEN_EVENT = 'tentacle:channels/open'
const OPEN_STORAGE_KEY = 'tentacle:channels:open'

export function ChannelsConsoleView({ t }: { t: Translate }): ReactElement {
  const [overview, setOverview] = useState<ChannelOverview>(EMPTY_OVERVIEW)
  const [schemas, setSchemas] = useState<readonly ChannelTypeSchema[]>([])
  const [loadError, setLoadError] = useState<unknown>(undefined)
  const [bindError, setBindError] = useState<unknown>(undefined)
  const [toast, setToast] = useState<ToastMessage | undefined>(undefined)
  const [editing, setEditing] = useState<EditTarget | undefined>(undefined)
  const [formDirty, setFormDirty] = useState(false)
  const [discard, setDiscard] = useState<DiscardIntent | undefined>(undefined)
  const [pendingDelete, setPendingDelete] = useState<ChannelInstanceView | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [users, setUsers] = useState<readonly BindableUser[]>([])
  /** Page-level target scope: choose the target first, then its channels. */
  const [experts, setExperts] = useState<readonly ExpertRouteView[]>([])
  const [teams, setTeams] = useState<readonly TeamRouteView[]>([])
  const [targetFilter, setTargetFilter] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')

  // The Toast owns its own lifetime and reports completion; a new sequence
  // number remounts it so re-showing the same text restarts the cycle.
  const onToast = useCallback<ToastFn>((text, tone) => {
    setToast((current) => ({ text, tone, seq: (current?.seq ?? 0) + 1 }))
  }, [])

  // Errors are kept as values (not formatted text) so this callback needs no
  // `t` in its closure; the render localizes them with the current locale.
  const reload = useCallback(() => {
    void channelsCall<ChannelOverview>('/')
      .then((next) => { setOverview(next); setLoadError(undefined) })
      .catch((error: unknown) => setLoadError(error))
    // A missing schema only costs the form (it says so); the list still works.
    void channelsCall<readonly ChannelTypeSchema[]>('/schema')
      .then(setSchemas)
      .catch(() => setSchemas([]))
  }, [])
  useEffect(reload, [reload])
  // Targets come from plugin-persona (experts) and plugin-teams (teams): a
  // failed fetch leaves that roster empty, which the editor reports (it cannot
  // create a channel without one) instead of inventing an unbound state. A
  // teams-less deployment simply has no team options.
  useEffect(() => {
    void channelsCall<readonly ExpertRouteView[]>('/experts')
      .then((list) => setExperts(list))
      .catch(() => setExperts([]))
    void channelsCall<readonly TeamRouteView[]>('/teams')
      .then((list) => setTeams(list))
      .catch(() => setTeams([]))
  }, [])

  /**
   * Apply one cross-panel request from the experts panel: scope the list to
   * that expert and, for the "new channel" intent, open the create editor so
   * the form's default expert is the one the operator clicked from.
   */
  const applyOpenRequest = useCallback((raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return
    const detail = raw as { expertId?: unknown; create?: unknown }
    if (typeof detail.expertId !== 'string' || detail.expertId === '') return
    setTargetFilter(`expert:${detail.expertId}`)
    setSelectedId(undefined)
    setFormDirty(false)
    if (detail.create === true) {
      setEditing(undefined)
      setPickerOpen(true)
    } else {
      setEditing(undefined)
    }
  }, [])

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(OPEN_STORAGE_KEY)
      if (raw !== null) {
        window.sessionStorage.removeItem(OPEN_STORAGE_KEY)
        applyOpenRequest(JSON.parse(raw))
      }
    } catch {
      // A malformed hand-off is ignored; the panel still opens unfiltered.
    }
    const handler = (event: Event): void => applyOpenRequest((event as CustomEvent).detail)
    window.addEventListener(OPEN_EVENT, handler)
    return () => window.removeEventListener(OPEN_EVENT, handler)
  }, [applyOpenRequest])

  // Bindable users are scoped to the selected instance's tenant on the host.
  useEffect(() => {
    if (selectedId === undefined) {
      setUsers([])
      setBindError(undefined)
      return
    }
    let cancelled = false
    void channelsCall<readonly BindableUser[]>(`/users?channelId=${encodeURIComponent(selectedId)}`)
      .then((list) => {
        if (cancelled) return
        setUsers(list)
        setBindError(undefined)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setUsers([])
        setBindError(error)
      })
    return () => { cancelled = true }
  }, [selectedId])

  const applyOpen = (target: EditTarget): void => {
    setFormDirty(false)
    setEditing(target)
  }

  const closeEditor = (): void => {
    setFormDirty(false)
    setEditing(undefined)
  }

  /** Open (or re-target) the editor, guarding an unsaved draft. */
  const openEditor = (target: EditTarget): void => {
    if (editing !== undefined) {
      if (sameTarget(editing, target)) return
      if (formDirty) {
        setDiscard({ kind: 'switch', target })
        return
      }
    }
    applyOpen(target)
  }

  /** Pick a platform first, then fill that platform's account form. */
  const openCreate = (): void => {
    setFormDirty(false)
    setEditing(undefined)
    // A single-platform deployment needs no catalog step: open its form
    // directly. Multiple platforms get the picker so the type is explicit.
    const only = schemas.length === 1 ? schemas[0] : undefined
    if (only !== undefined) openEditor({ mode: 'create', channelType: only.channelType })
    else setPickerOpen(true)
  }

  /** Ask to close; a dirty editor defers to the confirmation dialog. */
  const requestCloseEditor = (): void => {
    if (formDirty) {
      setDiscard({ kind: 'close' })
      return
    }
    closeEditor()
  }

  const resolveDiscard = (intent: DiscardIntent): void => {
    setDiscard(undefined)
    if (intent.kind === 'close') closeEditor()
    else applyOpen(intent.target)
  }

  const handleSaved = (): void => {
    closeEditor()
    reload()
  }

  /** Enable/disable directly, optimistic, with the row rolled back on failure. */
  const toggle = async (instance: ChannelInstanceView, enabled: boolean): Promise<void> => {
    const previous = instance
    setOverview((current) => ({
      ...current,
      instances: current.instances.map((candidate) => candidate.id === instance.id
        ? {
          ...candidate,
          enabled,
          runtime: enabled ? candidate.runtime : { state: 'disabled' } satisfies InstanceRuntime,
        }
        : candidate),
    }))
    try {
      const updated = await channelsCall<ChannelInstanceView>(enabled ? '/enable' : '/disable', { id: instance.id })
      setOverview((current) => ({
        ...current,
        instances: current.instances.map((candidate) => candidate.id === updated.id ? updated : candidate),
      }))
      onToast(t(enabled ? 'channels.toast.enabled' : 'channels.toast.disabled'), 'success')
    } catch (error) {
      // Put the exact pre-click row back, not a re-derived approximation.
      setOverview((current) => ({
        ...current,
        instances: current.instances.map((candidate) => candidate.id === previous.id ? previous : candidate),
      }))
      onToast(errorText(t, error))
    }
  }

  /** Delete: optimistic removal, then restore the row at its old index on failure. */
  const remove = async (instance: ChannelInstanceView): Promise<void> => {
    setPendingDelete(undefined)
    const index = overview.instances.findIndex((candidate) => candidate.id === instance.id)
    setOverview((current) => ({
      ...current,
      instances: current.instances.filter((candidate) => candidate.id !== instance.id),
    }))
    try {
      await channelsCall('/remove', { id: instance.id })
      onToast(t('channels.toast.deleted'), 'success')
      if (selectedId === instance.id) setSelectedId(undefined)
      reload()
    } catch (error) {
      setOverview((current) => {
        const restored = [...current.instances]
        restored.splice(Math.max(0, Math.min(index, restored.length)), 0, instance)
        return { ...current, instances: restored }
      })
      onToast(errorText(t, error))
    }
  }

  // Two views only: every channel (ops overview) or one target's channels.
  // There is no "unbound" view because every channel routes to a target.
  const needle = query.trim().toLowerCase()
  const visibleInstances = overview.instances
    .filter((instance) => targetFilter === '' || targetKey(instance.target) === targetFilter)
    .filter((instance) => {
      if (needle === '') return true
      return [instance.name, instance.channelType, instance.targetName, instance.id, instance.tenant]
        .some((value) => (value ?? '').toLowerCase().includes(needle))
    })
  const platformGroups = new Map<string, ChannelInstanceView[]>()
  for (const instance of visibleInstances) {
    const rows = platformGroups.get(instance.channelType) ?? []
    rows.push(instance)
    platformGroups.set(instance.channelType, rows)
  }
  const filteredTarget = targetOfKey(targetFilter)
  const filteredName = filteredTarget === undefined
    ? undefined
    : (filteredTarget.kind === 'expert'
      ? experts.find((expert) => expert.id === filteredTarget.id)?.name
      : teams.find((team) => team.id === filteredTarget.id)?.name)
  const running = visibleInstances.filter((instance) => instance.runtime.state === 'connected').length
  const selected = visibleInstances.find((instance) => instance.id === selectedId)
  const bindings = selected === undefined
    ? []
    : overview.bindings.filter((binding) => binding.channelId === selected.id)
  const pendingSenders = selected === undefined
    ? []
    : overview.pendingSenders.filter((row) => row.channelId === selected.id)
  // Conversation links are an overview: everything while nothing is selected,
  // the selected instance's rows once there is one.
  const visibleIds = new Set(visibleInstances.map((instance) => instance.id))
  const conversations = selected === undefined
    ? overview.conversations.filter((row) => visibleIds.has(row.channelId))
    : overview.conversations.filter((row) => row.channelId === selected.id)

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <h2 style={styles.title}>{t('channels.panel')}</h2>
          <p style={styles.pageHint}>{t('channels.panel.hint')}</p>
          <div style={styles.stats}>
            <Tag tone="quiet">{fmt(t('channels.stats.instances'), { n: overview.instances.length })}</Tag>
            <Tag tone="quiet">{fmt(t('channels.stats.running'), { n: running })}</Tag>
            <Tag tone="quiet">{fmt(t('channels.stats.bindings'), { n: overview.bindings.length })}</Tag>
          </div>
        </div>
        <div style={styles.actions}>
          <Button variant="ghost" icon={<IconRefreshOutlineRegular size={16} />} onClick={reload}>
            {t('channels.action.refresh')}
          </Button>
          <Button
            variant="primary"
            icon={<IconPlusOutlineRegular size={16} />}
            onClick={openCreate}
          >
            {t('channels.action.new')}
          </Button>
        </div>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ ...styles.hint, flex: '0 0 auto' }}>{t('channels.targetFilter.label')}</span>
        <select
          aria-label={t('channels.targetFilter.label')}
          value={targetFilter}
          onChange={(event) => { setTargetFilter(event.target.value); setSelectedId(undefined) }}
          style={{ ...styles.select, maxWidth: '100%', minWidth: 0, flex: '1 1 240px' }}
        >
          <option value="">{t('channels.targetFilter.all')}</option>
          {experts.length > 0 && (
            <optgroup label={t('channels.form.target.experts')}>
              {experts.map((expert) => (
                <option key={`expert:${expert.id}`} value={`expert:${expert.id}`}>{expert.name}</option>
              ))}
            </optgroup>
          )}
          {teams.length > 0 && (
            <optgroup label={t('channels.form.target.teams')}>
              {teams.map((team) => (
                <option key={`team:${team.id}`} value={`team:${team.id}`}>{team.name}</option>
              ))}
            </optgroup>
          )}
        </select>
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <Input
            aria-label={t('channels.search.placeholder')}
            placeholder={t('channels.search.placeholder')}
            value={query}
            icon={<IconSearchOutlineRegular size={16} />}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <section>
        <h3 style={styles.sectionTitle}>
          {filteredName === undefined
            ? t('channels.instances')
            : fmt(t('channels.instances.for'), { name: filteredName })}
        </h3>
        {visibleInstances.length === 0
          ? (
            <div style={styles.empty}>
              <p style={{ ...styles.hint, color: colors.text, fontSize: 13 }}>
                {filteredName === undefined ? t('channels.empty.title') : t('channels.empty.target.title')}
              </p>
              <p style={{ ...styles.hint, maxWidth: 520 }}>
                {filteredName === undefined ? t('channels.empty.hint') : t('channels.empty.target.hint')}
              </p>
              <Button
                variant="primary"
                icon={<IconPlusOutlineRegular size={16} />}
                onClick={openCreate}
              >
                {t('channels.action.new')}
              </Button>
            </div>
          )
          : (
            <div style={{ ...styles.platformCardWrap }}>
              {[...platformGroups.entries()].map(([channelType, rows]) => {
                const meta = platformMeta(channelType)
                return (
                  <section key={channelType} style={styles.card}>
                    <div style={styles.platformHeader}>
                      <span style={styles.platformIcon} aria-hidden="true">{meta.emoji}</span>
                      <div style={{ minWidth: 0, display: 'grid', gap: 1 }}>
                        <span style={styles.platformTitle}>{meta.label}</span>
                        <span style={styles.platformCount}>{fmt(t('channels.platform.accounts'), { n: rows.length })}</span>
                      </div>
                      <span style={{ flex: 1 }} />
                      <Button size="sm" variant="outline" onClick={() => openEditor({ mode: 'create', channelType })}>
                        {t('channels.platform.addAccount')}
                      </Button>
                    </div>
                    {rows.map((instance, index) => (
                      <InstanceRow
                        key={instance.id}
                        t={t}
                        instance={instance}
                        selected={instance.id === selectedId}
                        divided={index > 0}
                        onSelect={() => setSelectedId(selectedId === instance.id ? undefined : instance.id)}
                        onEdit={() => openEditor({ mode: 'edit', instance })}
                        onDelete={() => setPendingDelete(instance)}
                        onToggle={(enabled) => void toggle(instance, enabled)}
                      />
                    ))}
                  </section>
                )
              })}
            </div>
          )}
      </section>

      {selected !== undefined && (
        <section>
          <h3 style={styles.sectionTitle}>
            {fmt(t('channels.connection.for'), { name: selected.name })}
          </h3>
          <ConnectionSection
            key={selected.id}
            t={t}
            instance={selected}
            canRepair={schemas.find((candidate) => candidate.channelType === selected.channelType)?.quickSetup === true}
            onToast={onToast}
            reload={reload}
          />
        </section>
      )}

      <section>
        <h3 style={styles.sectionTitle}>
          {selected === undefined
            ? t('channels.bindings')
            : fmt(t('channels.bindings.for'), { name: selected.name })}
        </h3>
        {selected === undefined
          ? <p style={styles.hint}>{t('channels.hint.selectInstance')}</p>
          : (
            <BindingsSection
              key={selected.id}
              t={t}
              instance={selected}
              bindings={bindings}
              pendingSenders={pendingSenders}
              users={users}
              onToast={onToast}
              reload={reload}
            />
          )}
      </section>

      <section>
        <h3 style={styles.sectionTitle}>{t('channels.conversations')}</h3>
        <ConversationsSection t={t} conversations={conversations} />
      </section>

      {(overview.lastFailure !== undefined || bindError !== undefined || loadError !== undefined) && (
        <footer style={{ display: 'grid', gap: 8 }}>
          {overview.lastFailure !== undefined && (
            <p style={{ ...styles.hint, display: 'flex', gap: 6, color: colors.danger }}>
              <IconWarningOutlineRegular size={16} />
              {fmt(t('channels.hint.routingFailure'), { reason: overview.lastFailure })}
            </p>
          )}
          {bindError !== undefined && <p style={{ ...styles.hint, color: colors.danger }}>{errorText(t, bindError)}</p>}
          {loadError !== undefined && <p style={{ ...styles.hint, color: colors.danger }}>{errorText(t, loadError)}</p>}
        </footer>
      )}

      {pickerOpen && (
        <PlatformPicker
          t={t}
          schemas={schemas}
          onPick={(channelType) => {
            setPickerOpen(false)
            openEditor({ mode: 'create', channelType })
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {editing !== undefined && (
        <ChannelForm
          // Remount per target so the form state initializes from that scope's
          // draft (or from the instance being edited).
          key={editing.mode === 'edit' ? `edit:${editing.instance.id}` : 'create'}
          t={t}
          target={editing}
          defaultTarget={filteredTarget}
          schemas={schemas}
          onToast={onToast}
          onClose={requestCloseEditor}
          onSaved={handleSaved}
          onDeleted={handleSaved}
          onDirtyChange={setFormDirty}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== undefined}
        title={t('channels.confirm.delete.title')}
        description={fmt(t('channels.confirm.delete'), { name: pendingDelete?.name ?? '' })}
        closeLabel={t('channels.action.close')}
        cancelLabel={t('channels.action.cancel')}
        confirmLabel={t('channels.action.delete')}
        onCancel={() => setPendingDelete(undefined)}
        onConfirm={() => { if (pendingDelete !== undefined) void remove(pendingDelete) }}
      />

      <ConfirmDialog
        open={discard !== undefined}
        title={t('channels.confirm.discard.title')}
        description={t('channels.form.confirm.discard')}
        closeLabel={t('channels.action.close')}
        cancelLabel={t('channels.action.keepEditing')}
        confirmLabel={t('channels.action.discard')}
        onCancel={() => setDiscard(undefined)}
        onConfirm={() => { if (discard !== undefined) resolveDiscard(discard) }}
      />

      {toast !== undefined && (
        <Toast key={toast.seq} text={toast.text} tone={toast.tone} onDone={() => setToast(undefined)} />
      )}
    </div>
  )
}
