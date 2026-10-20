/**
 * Expert dialogs: the read-only detail drawer (identity / selected preset /
 * routing / workspace / channels / workspace skills) and the create/edit
 * form. Both use the official primitives so the panel keeps the shell's
 * visual language.
 *
 * An expert SELECTS an Agent preset (capability layer) and owns the remaining
 * dimensions: identity, workspace skills, model route, permission preset and
 * channel bindings. The preset is one component, never the expert identity.
 */
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import {
  Button,
  IconEditOutlineRegular,
  IconPlusOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Modal,
  SegmentedTabs,
  Tag,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fmt, type Translate } from '../locales.ts'
import {
  createExpert,
  errorText,
  getSkill,
  listSkills,
  readPreset,
  removeSkill,
  saveSkill,
  text,
  updateExpert,
  type ChannelRow,
  type ExpertRow,
  type ModelCatalogRow,
  type PermissionCatalogRow,
  type PresetDocument,
  type PresetRow,
  type SkillRow,
  type TemplateRow,
} from './api.ts'
import { accentOf, colors, styles } from './ui.ts'

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

// ---- detail ----

export interface ExpertDetailProps {
  t: Translate
  expert: ExpertRow
  template: TemplateRow | undefined
  channels: readonly ChannelRow[]
  preset: PresetRow | undefined
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  /** Make this expert the deployment default for channel migration. */
  onSetDefault: () => void
  /** Switch to the channels panel scoped to this expert. */
  onManageChannels: () => void
  /** Switch to the channels panel with its create form opened for this expert. */
  onNewChannel: () => void
  onToast: (message: string, tone?: 'success') => void
  /** Refresh the page projection after a skill mutation (card skill count). */
  onSkillsChanged: () => void
}

export function ExpertDetailDialog(props: ExpertDetailProps): ReactElement {
  const { t, expert, template, channels, preset, onClose, onEdit, onDelete, onSetDefault, onManageChannels, onNewChannel, onToast, onSkillsChanged } = props
  const accent = accentOf(expert.id, expert.color)
  const [skills, setSkills] = useState<readonly SkillRow[]>([])
  const [skillEditor, setSkillEditor] = useState<{ mode: 'create' } | { mode: 'edit'; name: string } | undefined>(undefined)
  const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined)
  const [presetDoc, setPresetDoc] = useState<PresetDocument | undefined>(undefined)
  const [tab, setTab] = useState<'overview' | 'skills' | 'channels' | 'preset'>('overview')

  const openPreset = (): void => {
    setTab('preset')
    if (presetDoc !== undefined) return
    void readPreset(expert.agentPreset)
      .then(setPresetDoc)
      .catch((error: unknown) => onToast(errorText(t, error)))
  }

  const reloadSkills = (): void => {
    void listSkills(expert.id).then(setSkills).catch((error: unknown) => onToast(errorText(t, error)))
  }
  useEffect(reloadSkills, [expert.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async (value: string): Promise<void> => {
    const ok = await writeClipboard(value)
    onToast(ok ? t('experts.toast.copied') : value)
  }

  const confirmDelete = async (): Promise<void> => {
    const name = pendingDelete
    setPendingDelete(undefined)
    if (name === undefined) return
    try {
      await removeSkill(expert.id, name)
      onToast(t('experts.toast.deleted'), 'success')
      reloadSkills()
      onSkillsChanged()
    } catch (error) {
      onToast(errorText(t, error))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('experts.detail.title')}
      closeLabel={t('experts.action.close')}
      className="tentacle-expert-dialog"
      contentClassName="tentacle-expert-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1 }} />
          {expert.builtin ? null : (
            <Button variant="ghost" style={{ color: colors.danger }} onClick={onDelete}>
              {t('experts.action.delete')}
            </Button>
          )}
          <Button variant="outline" onClick={onManageChannels}>{t('experts.action.channels')}</Button>
          <Button variant="outline" onClick={onNewChannel}>{t('experts.action.newChannel')}</Button>
          <Button variant="primary" onClick={onEdit}>{t('experts.action.edit')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('experts.action.close')}</Button>
        </div>
      )}
    >
      <div style={styles.form}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={styles.avatar}>{expert.icon ?? text(expert.name).slice(0, 1)}</div>
          <div style={{ minWidth: 0, display: 'grid', gap: 4 }}>
            <div style={styles.cardNameRow}>
              <span style={{ ...styles.cardName, whiteSpace: 'normal' }}>{text(expert.name)}</span>
              {expert.default && <Tag tone="solid">{t('experts.badge.default')}</Tag>}
              {expert.builtin
                ? <Tag tone="neutral">{t('experts.badge.builtin')}</Tag>
                : <Tag tone="outline">{t('experts.badge.custom')}</Tag>}
            </div>
            <p style={styles.hint}>{text(expert.description)}</p>
          </div>
        </div>

        <SegmentedTabs<'overview' | 'skills' | 'channels' | 'preset'>
          label={t('experts.detail.title')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'overview', label: t('experts.detail.overview'), id: 'tentacle-expert-tab-overview', panelId: 'tentacle-expert-panel-overview' },
            { value: 'skills', label: `${t('experts.detail.skills')} (${skills.length})`, id: 'tentacle-expert-tab-skills', panelId: 'tentacle-expert-panel-skills' },
            { value: 'channels', label: `${t('experts.detail.channels')} (${channels.length})`, id: 'tentacle-expert-tab-channels', panelId: 'tentacle-expert-panel-channels' },
            { value: 'preset', label: t('experts.detail.preset'), id: 'tentacle-expert-tab-preset', panelId: 'tentacle-expert-panel-preset' },
          ]}
        />

        {tab === 'overview' && (
          <>
            <p style={styles.help}>{t('experts.detail.compositionHint')}</p>
            <div style={styles.section}>
              <p style={styles.sectionLabel}>{t('experts.detail.identity')}</p>
              <div style={styles.facts}>
                <span style={styles.factLabel}>{t('experts.card.id')}</span>
                <span style={styles.factValue}>{expert.id}</span>
                <span style={styles.factLabel}>{t('experts.detail.preset')}</span>
                <span style={{ ...styles.factValue, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: colors.code }}>{expert.agentPreset}</span>
                  <Button size="sm" variant="ghost" onClick={openPreset}>{t('experts.detail.viewPreset')}</Button>
                </span>
                <span style={styles.factLabel}>{t('experts.detail.template')}</span>
                <span style={styles.factValue}>{template === undefined ? (expert.templateId ?? t('experts.card.custom')) : text(template.label)}</span>
                <span style={styles.factLabel}>{t('experts.action.copyId')}</span>
                <span style={{ ...styles.factValue, display: 'inline-flex', gap: 8 }}>
                  <Button size="sm" variant="ghost" onClick={() => void copy(expert.id)}>{t('experts.action.copyId')}</Button>
                  {!expert.default && <Button size="sm" variant="ghost" onClick={onSetDefault}>{t('experts.action.setDefault')}</Button>}
                </span>
                <span style={styles.factLabel}>{t('experts.detail.created')}</span>
                <span style={styles.factValue}>{formatTime(expert.createdAt)}</span>
                <span style={styles.factLabel}>{t('experts.detail.updated')}</span>
                <span style={styles.factValue}>{formatTime(expert.updatedAt)}</span>
              </div>
            </div>

            <div style={styles.divider} />

            <div style={styles.section}>
              <p style={styles.sectionLabel}>{t('experts.detail.routing')}</p>
              <div style={styles.facts}>
                <span style={styles.factLabel}>{t('experts.card.model')}</span>
                <span style={styles.factValue}>
                  {expert.model === undefined
                    ? t('experts.card.deploymentDefault')
                    : `${expert.model.provider}/${expert.model.model}${expert.model.maxTokens === undefined ? '' : ` · maxTokens ${expert.model.maxTokens}`}`}
                </span>
                <span style={styles.factLabel}>{t('experts.card.permission')}</span>
                <span style={styles.factValue}>{expert.permissionPreset ?? t('experts.card.deploymentDefault')}</span>
              </div>
            </div>

            <div style={styles.section}>
              <p style={styles.sectionLabel}>{t('experts.detail.workspace')}</p>
              <p style={styles.help}>{t('experts.detail.workspaceHint')}</p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <pre style={{ ...styles.codeBlock, flex: 1, margin: 0 }}>{expert.workspacePath}</pre>
                <Button size="sm" variant="outline" onClick={() => void copy(expert.workspacePath)}>
                  {t('experts.detail.copyPath')}
                </Button>
              </div>
            </div>
          </>
        )}

        {tab === 'skills' && (
          <div style={styles.section}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <p style={{ ...styles.sectionLabel, margin: 0 }}>{t('experts.detail.skills')}</p>
              <span style={{ flex: 1 }} />
              <Button
                size="sm"
                variant="outline"
                icon={<IconPlusOutlineRegular size={14} />}
                onClick={() => setSkillEditor({ mode: 'create' })}
              >
                {t('experts.skills.add')}
              </Button>
            </div>
            <p style={styles.help}>{t('experts.detail.skillsHint')}</p>
            {skills.length === 0
              ? <p style={styles.help}>{t('experts.skills.empty')}</p>
              : skills.map((skill) => (
                <div key={skill.name} style={styles.skillRow}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ fontFamily: colors.code, fontSize: 12 }}>{skill.name}</span>
                    <span style={{ display: 'block', color: colors.secondary, fontSize: 11 }}>{skill.description || skill.path}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="toolbar"
                    aria-label={t('experts.skills.edit')}
                    title={t('experts.skills.edit')}
                    icon={<IconEditOutlineRegular size={14} />}
                    onClick={() => setSkillEditor({ mode: 'edit', name: skill.name })}
                  />
                  <Button
                    size="sm"
                    variant="toolbar"
                    aria-label={t('experts.skills.delete')}
                    title={t('experts.skills.delete')}
                    icon={<IconTrashOutlineRegular size={14} />}
                    style={{ color: colors.danger }}
                    onClick={() => setPendingDelete(skill.name)}
                  />
                </div>
              ))}
          </div>
        )}

        {tab === 'channels' && (
          <div style={styles.section}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <p style={{ ...styles.sectionLabel, margin: 0 }}>{t('experts.detail.channels')}</p>
              <span style={{ flex: 1 }} />
              <Button size="sm" variant="outline" onClick={onManageChannels}>{t('experts.action.channels')}</Button>
              <Button size="sm" variant="primary" onClick={onNewChannel}>{t('experts.action.newChannel')}</Button>
            </div>
            {channels.length === 0
              ? <p style={styles.help}>{t('experts.detail.noChannels')}</p>
              : channels.map((channel) => (
                <div key={channel.id} style={styles.channelRow}>
                  <Tag tone={channel.enabled ? 'success' : 'neutral'}>{channel.channelType}</Tag>
                  <span>{channel.name}</span>
                  <span style={{ ...styles.tiny, fontFamily: colors.code }}>{channel.id}</span>
                </div>
              ))}
          </div>
        )}

        {tab === 'preset' && (
          <div style={styles.section}>
            <p style={styles.sectionLabel}>{t('experts.detail.presetComposition')} · {expert.agentPreset}</p>
            {preset?.description !== undefined && <p style={styles.help}>{preset.description}</p>}
            {presetDoc === undefined
              ? <p style={styles.help}>{t('experts.detail.loadingPreset')}</p>
              : <pre style={{ ...styles.codeBlock, maxHeight: '46vh' }}>{presetDoc.content}</pre>}
          </div>
        )}
      </div>

      {skillEditor !== undefined && (
        <SkillEditorDialog
          t={t}
          expertId={expert.id}
          target={skillEditor}
          onClose={() => setSkillEditor(undefined)}
          onSaved={() => {
            setSkillEditor(undefined)
            reloadSkills()
            onSkillsChanged()
            onToast(t('experts.toast.saved'), 'success')
          }}
          onToast={onToast}
        />
      )}

      {pendingDelete !== undefined && (
        <Modal
          open
          onClose={() => setPendingDelete(undefined)}
          title={t('experts.skills.deleteTitle')}
          closeLabel={t('experts.action.close')}
          description={fmt(t('experts.skills.deleteConfirm'), { name: pendingDelete })}
          footer={(
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" onClick={() => setPendingDelete(undefined)}>{t('experts.action.cancel')}</Button>
              <Button variant="primary" style={{ background: colors.danger }} onClick={() => void confirmDelete()}>
                {t('experts.action.delete')}
              </Button>
            </div>
          )}
        >
          <p style={styles.hint}>{pendingDelete}</p>
        </Modal>
      )}
    </Modal>
  )
}

// ---- skill editor ----

interface SkillEditorProps {
  t: Translate
  expertId: string
  target: { mode: 'create' } | { mode: 'edit'; name: string }
  onClose: () => void
  onSaved: () => void
  onToast: (message: string, tone?: 'success') => void
}

function SkillEditorDialog({ t, expertId, target, onClose, onSaved, onToast }: SkillEditorProps): ReactElement {
  const editing = target.mode === 'edit'
  const [name, setName] = useState(editing ? target.name : '')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!editing) return
    void getSkill(expertId, target.name).then((skill) => {
      setDescription(skill.description)
      setBody(skill.body)
    }).catch((error: unknown) => onToast(errorText(t, error)))
  }, [editing, expertId, target, t, onToast])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await saveSkill(expertId, { name: name.trim(), description: description.trim(), body })
      onSaved()
    } catch (error) {
      onToast(errorText(t, error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? fmt(t('experts.skills.editTitle'), { name: target.name }) : t('experts.skills.add')}
      closeLabel={t('experts.action.close')}
      className="tentacle-expert-dialog"
      contentClassName="tentacle-expert-content"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('experts.action.cancel')}</Button>
          <Button type="submit" form="tentacle-skill-editor" variant="primary" disabled={busy}>
            {t('experts.action.save')}
          </Button>
        </div>
      )}
    >
      <form id="tentacle-skill-editor" style={styles.form} onSubmit={submit}>
        <label style={styles.field}>
          <span style={styles.label}>{t('experts.skills.name')}</span>
          <Input
            aria-label={t('experts.skills.name')}
            value={name}
            disabled={editing}
            placeholder="release-notes"
            onChange={(event) => setName(event.target.value)}
            style={{ fontFamily: colors.code }}
          />
        </label>
        <label style={styles.field}>
          <span style={styles.label}>{t('experts.skills.description')}</span>
          <Input
            aria-label={t('experts.skills.description')}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <p style={styles.help}>{t('experts.skills.nameHint')}</p>
        <label style={styles.field}>
          <span style={styles.label}>{t('experts.skills.body')}</span>
          <textarea
            aria-label={t('experts.skills.body')}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={12}
            style={styles.textarea}
          />
        </label>
      </form>
    </Modal>
  )
}

// ---- editor ----

export type EditorTarget =
  | { readonly kind: 'create' }
  | { readonly kind: 'copy'; readonly template: TemplateRow }
  | { readonly kind: 'edit'; readonly expert: ExpertRow }

export interface ExpertEditorProps {
  t: Translate
  target: EditorTarget
  presets: readonly PresetRow[]
  modelCatalog: ModelCatalogRow | undefined
  permissionCatalog: PermissionCatalogRow | undefined
  onClose: () => void
  onSaved: (created: boolean) => void
  onToast: (message: string, tone?: 'success') => void
}

interface FormState {
  id: string
  name: string
  description: string
  icon: string
  agentPreset: string
  provider: string
  model: string
  maxTokens: string
  permissionPreset: string
}

function initialForm(target: EditorTarget, presets: readonly PresetRow[]): FormState {
  if (target.kind === 'edit') {
    const expert = target.expert
    return {
      id: expert.id,
      name: text(expert.name),
      description: text(expert.description),
      icon: expert.icon ?? '',
      agentPreset: expert.agentPreset,
      provider: expert.model?.provider ?? '',
      model: expert.model?.model ?? '',
      maxTokens: expert.model?.maxTokens === undefined ? '' : String(expert.model.maxTokens),
      permissionPreset: expert.permissionPreset ?? '',
    }
  }
  const preferred = presets.find((preset) => preset.default) ?? presets[0]
  return {
    id: '',
    name: '',
    description: '',
    icon: '',
    agentPreset: target.kind === 'copy' ? target.template.agentPresetId : (preferred?.id ?? ''),
    provider: '',
    model: '',
    maxTokens: '',
    permissionPreset: '',
  }
}

export function ExpertEditorDialog({ t, target, presets, modelCatalog, permissionCatalog, onClose, onSaved, onToast }: ExpertEditorProps): ReactElement {
  const editing = target.kind === 'edit' ? target.expert : undefined
  const template = target.kind === 'copy' ? target.template : undefined
  const builtin = editing?.builtin === true
  const [form, setForm] = useState<FormState>(() => initialForm(target, presets))
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<FormState>): void => setForm((current) => ({ ...current, ...patch }))
  const modelGroups = modelCatalog?.groups ?? []
  const selectedGroup = modelGroups.find((group) => group.id === form.provider)
  const selectedModels = selectedGroup?.models ?? []

  const title = useMemo(() => {
    if (editing !== undefined) return fmt(t('experts.form.editTitle'), { name: text(editing.name) })
    if (template !== undefined) return fmt(t('experts.form.copyTitle'), { name: text(template.label) })
    return t('experts.form.createTitle')
  }, [editing, template, t])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const model = form.provider.trim() !== '' && form.model.trim() !== ''
      ? {
        provider: form.provider.trim(),
        model: form.model.trim(),
        ...(form.maxTokens.trim() === '' ? {} : { maxTokens: Number(form.maxTokens) }),
      }
      : undefined
    const permission = form.permissionPreset.trim() === '' ? undefined : form.permissionPreset.trim()
    if (target.kind === 'create') {
      if (form.name.trim() === '') {
        onToast(t('experts.form.error.name'))
        return
      }
      if (form.agentPreset === '') {
        onToast(t('experts.form.error.preset'))
        return
      }
    }

    setBusy(true)
    try {
      if (target.kind === 'edit') {
        await updateExpert({
          id: target.expert.id,
          ...(builtin ? {} : { name: form.name, description: form.description, icon: form.icon }),
          agentPreset: form.agentPreset,
          model: model ?? null,
          permissionPreset: permission ?? null,
        })
        onToast(t('experts.toast.saved'), 'success')
      } else if (target.kind === 'copy') {
        await createExpert({
          templateId: target.template.id,
          ...(form.id.trim() === '' ? {} : { id: form.id.trim() }),
          ...(form.name.trim() === '' ? {} : { name: form.name.trim() }),
          ...(form.description.trim() === '' ? {} : { description: form.description.trim() }),
        })
        onToast(t('experts.toast.created'), 'success')
      } else {
        await createExpert({
          ...(form.id.trim() === '' ? {} : { id: form.id.trim() }),
          name: form.name.trim(),
          description: form.description.trim(),
          ...(form.icon.trim() === '' ? {} : { icon: form.icon.trim() }),
          agentPreset: form.agentPreset,
          ...(model === undefined ? {} : { model }),
          ...(permission === undefined ? {} : { permissionPreset: permission }),
        })
        onToast(t('experts.toast.created'), 'success')
      }
      onSaved(target.kind !== 'edit')
    } catch (error) {
      onToast(errorText(t, error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      closeLabel={t('experts.action.close')}
      className="tentacle-expert-dialog"
      contentClassName="tentacle-expert-content"
      {...(template === undefined
        ? {}
        : { description: fmt(t('experts.form.templateHint'), { name: text(template.label) }) })}
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('experts.action.cancel')}</Button>
          <Button type="submit" form="tentacle-expert-editor" variant="primary" disabled={busy}>
            {editing !== undefined ? t('experts.action.save') : t('experts.action.createSubmit')}
          </Button>
        </div>
      )}
    >
      <form id="tentacle-expert-editor" style={styles.form} onSubmit={submit}>
        <div style={styles.section}>
          <p style={styles.sectionLabel}>{t('experts.form.basic')}</p>
          {builtin && <p style={styles.help}>{t('experts.form.builtinLocked')}</p>}
          <div style={styles.gridTwo}>
            <label style={styles.field}>
              <span style={styles.label}>{target.kind === 'copy' ? t('experts.form.nameOptional') : t('experts.form.name')}</span>
              <Input
                aria-label={t('experts.form.name')}
                value={form.name}
                placeholder={template === undefined ? '' : text(template.label)}
                disabled={builtin}
                onChange={(event) => set({ name: event.target.value })}
              />
            </label>
            {target.kind !== 'copy' && (
              <label style={styles.field}>
                <span style={styles.label}>{t('experts.form.id')}</span>
                <Input
                  aria-label={t('experts.form.id')}
                  value={form.id}
                  placeholder="expert-slug"
                  disabled={editing !== undefined}
                  onChange={(event) => set({ id: event.target.value })}
                  style={{ fontFamily: colors.code }}
                />
              </label>
            )}
            {target.kind !== 'copy' && (
              <label style={styles.field}>
                <span style={styles.label}>{t('experts.form.icon')}</span>
                <Input
                  aria-label={t('experts.form.icon')}
                  value={form.icon}
                  placeholder="🐙"
                  disabled={builtin}
                  onChange={(event) => set({ icon: event.target.value })}
                />
              </label>
            )}
          </div>
          {target.kind === 'copy'
            ? (
              <label style={styles.field}>
                <span style={styles.label}>{t('experts.form.descriptionOptional')}</span>
                <Input
                  aria-label={t('experts.form.description')}
                  value={form.description}
                  placeholder={text(template?.description ?? { zh: '', en: '' })}
                  onChange={(event) => set({ description: event.target.value })}
                />
              </label>
            )
            : (
              <label style={styles.field}>
                <span style={styles.label}>{t('experts.form.description')}</span>
                <Input
                  aria-label={t('experts.form.description')}
                  value={form.description}
                  disabled={builtin}
                  onChange={(event) => set({ description: event.target.value })}
                />
              </label>
            )}
          <p style={styles.help}>{t('experts.form.idHint')}</p>
        </div>

        <div style={styles.divider} />

        <div style={styles.section}>
          <p style={styles.sectionLabel}>{t('experts.form.preset')}</p>
          {target.kind === 'copy'
            ? (
              <p style={styles.help}>
                {fmt(t('experts.form.presetTemplate'), { preset: form.agentPreset })}
              </p>
            )
            : (
              <>
                <label style={styles.field}>
                  <span style={styles.label}>{t('experts.form.preset')}</span>
                  <select
                    aria-label={t('experts.form.preset')}
                    value={form.agentPreset}
                    onChange={(event) => set({ agentPreset: event.target.value })}
                    style={styles.input}
                  >
                    {form.agentPreset !== '' && !presets.some((preset) => preset.id === form.agentPreset) && (
                      <option value={form.agentPreset}>{form.agentPreset}</option>
                    )}
                    {presets.map((preset) => (
                      <option key={preset.id} value={preset.id} disabled={preset.broken !== undefined}>
                        {preset.name === undefined ? preset.id : `${preset.name} · ${preset.id}`}
                        {preset.default ? ` (${t('experts.form.presetDefault')})` : ''}
                        {preset.broken !== undefined ? ` — ${t('experts.form.presetBroken')}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <p style={styles.help}>{t('experts.form.presetHint')}</p>
                {(() => {
                  const selected = presets.find((preset) => preset.id === form.agentPreset)
                  return selected?.description === undefined
                    ? null
                    : <p style={styles.help}>{selected.description}</p>
                })()}
              </>
            )}
        </div>

        <div style={styles.divider} />

        <div style={styles.section}>
          <p style={styles.sectionLabel}>{t('experts.form.routing')}</p>
          <div style={styles.gridTwo}>
            <label style={styles.field}>
              <span style={styles.label}>{t('experts.form.provider')}</span>
              <select
                aria-label={t('experts.form.provider')}
                value={form.provider}
                disabled={modelCatalog === undefined}
                onChange={(event) => {
                  const provider = event.target.value
                  const group = modelGroups.find((candidate) => candidate.id === provider)
                  set({ provider, model: group?.models[0]?.id ?? '' })
                }}
                style={styles.input}
              >
                <option value="">{t('experts.card.deploymentDefault')}</option>
                {modelGroups.map((group) => (
                  <option key={group.id} value={group.id}>{group.name} · {group.id}</option>
                ))}
              </select>
            </label>
            <label style={styles.field}>
              <span style={styles.label}>{t('experts.form.model')}</span>
              <select
                aria-label={t('experts.form.model')}
                value={form.model}
                disabled={modelCatalog === undefined || form.provider === ''}
                onChange={(event) => set({ model: event.target.value })}
                style={styles.input}
              >
                {form.provider === ''
                  ? <option value="">{t('experts.card.deploymentDefault')}</option>
                  : selectedModels.map((model) => (
                    <option key={model.id} value={model.id}>{model.name} · {model.id}</option>
                  ))}
                {form.provider !== '' && form.model !== '' && !selectedModels.some((model) => model.id === form.model) && (
                  <option value={form.model}>{form.model} ({t('experts.form.currentValue')})</option>
                )}
              </select>
            </label>
          </div>
          {modelCatalog === undefined
            ? <p style={styles.help}>{t('experts.form.catalogUnavailable')}</p>
            : null}
          <label style={styles.field}>
            <span style={styles.label}>{t('experts.form.permission')}</span>
            <select
              aria-label={t('experts.form.permission')}
              value={form.permissionPreset}
              disabled={permissionCatalog === undefined}
              onChange={(event) => set({ permissionPreset: event.target.value })}
              style={styles.input}
            >
              <option value="">{t('experts.card.deploymentDefault')}</option>
              {(permissionCatalog?.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.name}{option.value === (permissionCatalog?.defaultPreset ?? '') ? ` (${t('experts.form.defaultOption')})` : ''}
                </option>
              ))}
              {form.permissionPreset !== '' && !(permissionCatalog?.options ?? []).some((option) => option.value === form.permissionPreset) && (
                <option value={form.permissionPreset}>{form.permissionPreset} ({t('experts.form.currentValue')})</option>
              )}
            </select>
          </label>
          <p style={styles.help}>{t('experts.form.permissionHint')}</p>
        </div>

        <p style={styles.help}>{t('experts.form.skillsHint')}</p>
      </form>
    </Modal>
  )
}

// ---- delete confirmation ----

export interface DeleteExpertDialogProps {
  t: Translate
  expert: ExpertRow
  onCancel: () => void
  onConfirm: () => void
}

export function DeleteExpertDialog({ t, expert, onCancel, onConfirm }: DeleteExpertDialogProps): ReactElement {
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('experts.confirm.delete.title')}
      closeLabel={t('experts.action.close')}
      description={fmt(t('experts.confirm.delete'), { name: text(expert.name) })}
      className="tentacle-expert-dialog"
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onCancel}>{t('experts.action.cancel')}</Button>
          <Button variant="primary" style={{ background: colors.danger }} onClick={onConfirm}>
            {t('experts.action.delete')}
          </Button>
        </div>
      )}
    >
      <p style={styles.hint}>{expert.id}</p>
    </Modal>
  )
}
