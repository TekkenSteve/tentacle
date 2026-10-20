/**
 * The create/edit dialog for one channel instance (design 07 §5).
 *
 * The form is HOST-SCHEMA driven: the field list, control kind, required flag
 * and every label/help key come from `GET /schema`; the client renders exactly
 * the declared controls and resolves the keys through the
 * `tentacle-channels` dictionary with a raw-field-name fallback.
 *
 * Three invariants from the design are enforced here:
 *
 *  - **secrets are write-only**: the credential input starts empty, is never
 *    prefilled from the instance, and its value is excluded from the draft
 *    written to `sessionStorage`;
 *  - **save is not optimistic**: the response is awaited, then the toast fires
 *    and the parent refreshes; on failure nothing local is mutated;
 *  - **drafts persist** per scope (`instance:{id}` / `new:{type}`) and are
 *    cleared only on a successful save/delete — cancelling keeps them.
 *
 * The dialog owns its destructive action (delete → its own confirmation) so
 * the draft scope it clears is the one it is editing.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import {
  Button,
  IconSendOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Modal,
  SegmentedControl,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  channelsCall,
  errorText,
  targetKey,
  targetOfKey,
  type ChannelInstanceView,
  type ChannelTarget,
  type ChannelTypeSchema,
  type ExpertRouteView,
  type ProbeResult,
  type TeamRouteView,
} from '../../api.ts'
import { clearDraft, loadDraft, saveDraft, type ChannelDraft } from '../../draft.ts'
import { fmt, type Translate } from '../../locales.ts'
import { ConfirmDialog } from '../confirm-dialog.tsx'
import { platformMeta } from '../platform.ts'
import type { EditTarget, ToastFn } from '../contracts.ts'
import { colors, styles } from '../ui.ts'
import { CredentialField } from './credential-field.tsx'
import { FieldControl } from './field-control.tsx'
import { ProvisionPane } from './provision-pane.tsx'
import {
  baselineFor,
  configPayload,
  credentialLabel,
  credentialsPayload,
  defaultsFor,
  draftValues,
  fieldLabel,
  isBlank,
  mergeDraft,
  pickSchemaValues,
  scopeOf,
  type FormValue,
  type FormValues,
} from './form-model.ts'

export interface ChannelFormProps {
  t: Translate
  target: EditTarget
  /** Target scope picked in the console: a channel created here binds to it. */
  defaultTarget?: ChannelTarget
  schemas: readonly ChannelTypeSchema[]
  onToast: ToastFn
  /** Cancel / discard; the parent owns the unsaved-changes confirmation. */
  onClose: () => void
  onSaved: (instance: ChannelInstanceView) => void
  onDeleted: () => void
  onDirtyChange: (dirty: boolean) => void
}

/** ` · Bot @name` / ` · Bot ID 42`, appended to a successful probe. */
function identitySuffix(t: Translate, identity: { id: number; username?: string } | undefined): string {
  if (identity === undefined) return ''
  const label = identity.username === undefined
    ? fmt(t('channels.form.probe.identityId'), { id: identity.id })
    : fmt(t('channels.form.probe.identity'), { username: identity.username })
  return ` · ${label}`
}

/** One read-only instance fact (type / id / tenant / credential reference). */
function Fact({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <>
      <span style={styles.fieldLabel}>{label}</span>
      <span style={styles.factValue}>{value}</span>
    </>
  )
}

export function ChannelForm({
  t,
  target,
  defaultTarget,
  schemas,
  onToast,
  onClose,
  onSaved,
  onDeleted,
  onDirtyChange,
}: ChannelFormProps): ReactElement {
  const formId = useId()
  const instance = target.mode === 'edit' ? target.instance : undefined
  // The parent remounts the form per target (key), so this runs once per scope.
  const [initial] = useState(() => {
    const channelType = instance?.channelType ?? (target.mode === 'create' ? target.channelType : undefined) ?? schemas[0]?.channelType ?? ''
    const schema = schemas.find((candidate) => candidate.channelType === channelType)
    const base = baselineFor(schema, instance)
    const draft: ChannelDraft | undefined = loadDraft(scopeOf(target, channelType))
    return {
      channelType,
      name: draft?.name ?? instance?.name ?? '',
      values: mergeDraft(schema, base, draft),
      restored: draft !== undefined,
    }
  })
  const [channelType, setChannelType] = useState(initial.channelType)
  const [name, setName] = useState(initial.name)
  const [values, setValues] = useState<FormValues>(initial.values)
  /** Secret field name → draft value; starts empty, never prefilled, never drafted. */
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [probe, setProbe] = useState<ProbeResult | undefined>(undefined)
  /** Create-mode entry: quick (QR) when the type offers a flow, else manual. */
  const [entryMode, setEntryMode] = useState<'quick' | 'manual'>('quick')
  const [probeBusy, setProbeBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /**
   * Routing targets (design 09 for experts, 10 §7 for teams): each kind gets
   * its own shared workspace / preset / model. The selected target is kept as
   * its encoded `<select>` value; the payload carries the decoded union.
   */
  const [experts, setExperts] = useState<readonly ExpertRouteView[]>([])
  const [teams, setTeams] = useState<readonly TeamRouteView[]>([])
  const [targetKey_, setTargetKey] = useState(
    () => (instance === undefined
      ? (defaultTarget === undefined ? '' : targetKey(defaultTarget))
      : targetKey(instance.target)),
  )
  const selected = targetOfKey(targetKey_)

  useEffect(() => {
    let cancelled = false
    void channelsCall<readonly ExpertRouteView[]>('/experts')
      .then((list) => { if (!cancelled) setExperts(list) })
      .catch(() => { if (!cancelled) setExperts([]) })
    void channelsCall<readonly TeamRouteView[]>('/teams')
      .then((list) => { if (!cancelled) setTeams(list) })
      .catch(() => { if (!cancelled) setTeams([]) })
    return () => { cancelled = true }
  }, [])

  // Creating from the "all channels" view has no target scope: pre-select the
  // console's scope, else the first routable target, so the required binding
  // is visible instead of silently absent. The host re-validates the id.
  useEffect(() => {
    if (targetKey_ !== '' || instance !== undefined) return
    const fallback = defaultTarget
      ?? (experts[0] === undefined ? undefined : { kind: 'expert', id: experts[0].id } as ChannelTarget)
      ?? (teams[0] === undefined ? undefined : { kind: 'team', id: teams[0].id } as ChannelTarget)
    if (fallback !== undefined) setTargetKey(targetKey(fallback))
  }, [experts, teams, defaultTarget, targetKey_, instance])

  // The form can mount before the host schema arrives (e.g. the expert panel
  // opens it through the cross-panel hand-off, in the same tick as the panel
  // mount). Adopt the first published type instead of staying on the empty
  // placeholder, which would render "the host published no schema".
  useEffect(() => {
    if (schemas.length === 0) return
    if (schemas.some((candidate) => candidate.channelType === channelType)) return
    const next = schemas[0]
    if (next === undefined) return
    setChannelType(next.channelType)
    setValues(mergeDraft(next, defaultsFor(next), loadDraft(scopeOf(target, next.channelType))))
  }, [schemas, channelType, target])

  const schema = schemas.find((candidate) => candidate.channelType === channelType)
  // Quick setup starts a platform flow, and the flow is created FOR a target;
  // without one the pane would call the host with a missing binding, so the
  // form asks for the target first and only then offers quick/manual.
  const quickMode = instance === undefined && targetKey_ !== '' && schema?.quickSetup === true && entryMode === 'quick'
  const baseline = useMemo(() => baselineFor(schema, instance), [instance, schema])
  const picked = useMemo(() => pickSchemaValues(schema, values), [schema, values])
  const draftable = useMemo(() => draftValues(schema, values), [schema, values])
  const dirty = name.trim() !== (instance?.name ?? '').trim()
    || targetKey_ !== (instance === undefined
      ? (defaultTarget === undefined ? '' : targetKey(defaultTarget))
      : targetKey(instance.target))
    || JSON.stringify(picked) !== JSON.stringify(pickSchemaValues(schema, baseline))

  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  // Any change persists immediately — but only once it is a real change, so a
  // pristine form does not litter the session with empty drafts.
  useEffect(() => {
    if (!dirty) return
    saveDraft(scopeOf(target, channelType), { name, config: draftable })
  }, [dirty, name, draftable, channelType, target])

  const setValue = (field: string, value: FormValue): void => {
    setValues((current) => ({ ...current, [field]: value }))
  }

  /** Switching the create type re-scopes the draft; the name is kept. */
  const switchType = (next: string): void => {
    if (instance !== undefined || next === channelType) return
    const nextSchema = schemas.find((candidate) => candidate.channelType === next)
    const draft = loadDraft({ kind: 'new', channelType: next })
    // A type without a flow has no quick mode; the choice itself is kept for
    // types that do (switching back and forth must not lose the preference).
    if (nextSchema?.quickSetup !== true) setEntryMode('manual')
    setChannelType(next)
    setValues(mergeDraft(nextSchema, defaultsFor(nextSchema), draft))
    setProbe(undefined)
  }

  const save = async (): Promise<void> => {
    if (schema === undefined || busy || quickMode) return
    if (selected === undefined) {
      onToast(t('channels.form.error.target'))
      return
    }
    const trimmed = name.trim()
    if (trimmed === '') {
      onToast(t('channels.form.error.name'))
      return
    }
    const missing = schema.config.find((field) => field.required === true && isBlank(values[field.name]))
    if (missing !== undefined) {
      onToast(fmt(t('channels.form.error.required'), { field: fieldLabel(t, missing) }))
      return
    }
    if (instance === undefined) {
      const missingSecret = schema.credentials.find((field) => field.required && (secrets[field.name] ?? '').trim() === '')
      if (missingSecret !== undefined) {
        onToast(fmt(t('channels.form.error.required'), { field: credentialLabel(t, missingSecret) }))
        return
      }
    }
    // "Leave empty to keep the current secret": an empty control sends no
    // credential entry at all, so the stored record is untouched.
    const credentials = credentialsPayload(secrets)
    const body = {
      ...(instance === undefined ? { channelType, target: selected } : { id: instance.id }),
      name: trimmed,
      config: configPayload(schema, values),
      // Create always carries the target; edit only when the operator rebound
      // it. Clearing is not a representable state (design 10 §7).
      ...(instance !== undefined && targetKey_ === targetKey(instance.target) ? {} : { target: selected }),
      ...(credentials === undefined ? {} : { credentials }),
    }
    setBusy(true)
    try {
      const saved = await channelsCall<ChannelInstanceView>(instance === undefined ? '/create' : '/update', body)
      clearDraft(scopeOf(target, channelType))
      onToast(t(instance === undefined ? 'channels.toast.created' : 'channels.toast.saved'), 'success')
      onSaved(saved)
    } catch (error) {
      onToast(errorText(t, error))
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void save()
  }

  const testConnection = async (): Promise<void> => {
    if (schema === undefined || quickMode) return
    setProbeBusy(true)
    try {
      const result = instance === undefined
        ? await channelsCall<ProbeResult>('/probe', {
          channelType,
          config: configPayload(schema, values),
          credentials: credentialsPayload(secrets) ?? {},
        })
        : await channelsCall<ProbeResult>('/test', { id: instance.id })
      setProbe(result)
    } catch (error) {
      onToast(errorText(t, error))
    } finally {
      setProbeBusy(false)
    }
  }

  /** Confirmed deletion: awaited (never optimistic), then the draft is cleared. */
  const remove = async (): Promise<void> => {
    if (instance === undefined) return
    setConfirmDelete(false)
    try {
      await channelsCall('/remove', { id: instance.id })
      clearDraft(scopeOf(target, channelType))
      onToast(t('channels.toast.deleted'), 'success')
      onDeleted()
    } catch (error) {
      onToast(errorText(t, error))
    }
  }

  const title = instance === undefined
    ? t('channels.form.create')
    : fmt(t('channels.form.editNamed'), { name: instance.name })

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={title}
        closeLabel={t('channels.action.close')}
        className="tentacle-channel-dialog"
        contentClassName="tentacle-channel-content"
        description={initial.restored && dirty ? t('channels.form.hint.draft') : undefined}
        footer={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              {!quickMode && probeBusy && <span style={styles.tiny}>{t('channels.form.probe.checking')}</span>}
              {!quickMode && !probeBusy && probe !== undefined && (probe.ok
                ? (
                  <Tag tone="success">
                    {`${t('channels.form.probe.ok')}${identitySuffix(t, probe.identity)}`}
                  </Tag>
                )
                : <Tag tone="danger">{probe.error}</Tag>)}
            </span>
            {instance !== undefined && (
              <Button
                variant="ghost"
                icon={<IconTrashOutlineRegular size={16} />}
                style={styles.danger}
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                {t('channels.action.delete')}
              </Button>
            )}
            {!quickMode && (
              <Button
                variant="outline"
                icon={<IconSendOutlineRegular size={16} />}
                disabled={probeBusy || busy || schema === undefined}
                onClick={() => void testConnection()}
              >
                {t('channels.action.test')}
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={onClose}>{t('channels.action.cancel')}</Button>
            {!quickMode && (
              <Button type="submit" form={formId} variant="primary" disabled={busy || schema === undefined}>
                {t('channels.action.save')}
              </Button>
            )}
          </div>
        )}
      >
        {schema === undefined
          ? <p style={styles.hint}>{t('channels.form.hint.noSchema')}</p>
          : (
            <form id={formId} onSubmit={submit} style={styles.stack}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: `1px solid ${colors.border}`, borderRadius: 10, background: colors.layer2 }}>
                <span style={styles.platformIcon} aria-hidden="true">{platformMeta(channelType).emoji}</span>
                <div style={{ minWidth: 0, display: 'grid', gap: 1 }}>
                  <span style={styles.platformTitle}>{platformMeta(channelType).label}</span>
                  <span style={{ ...styles.tiny, fontFamily: colors.code }}>{channelType}</span>
                </div>
                <span style={{ flex: 1 }} />
                {schema?.quickSetup === true && <Tag tone="success">{t('channels.picker.quick')}</Tag>}
              </div>
              {instance === undefined && target.mode === 'create' && target.channelType === undefined && (
                <label style={styles.field}>
                  <span style={styles.fieldLabel}>{t('channels.form.type')}</span>
                  <select
                    aria-label={t('channels.form.type')}
                    value={channelType}
                    onChange={(event) => switchType(event.target.value)}
                    style={styles.select}
                  >
                    {schemas.map((candidate) => (
                      <option key={candidate.channelType} value={candidate.channelType}>{candidate.channelType}</option>
                    ))}
                  </select>
                </label>
              )}
              {instance !== undefined && (
                <div style={styles.facts}>
                  <Fact label={t('channels.form.type')} value={instance.channelType} />
                  <Fact label={t('channels.form.id')} value={instance.id} />
                  <Fact label={t('channels.form.tenant')} value={instance.tenant} />
                  {instance.tokenRef !== undefined && (
                    <Fact label={t('channels.form.tokenRef')} value={instance.tokenRef} />
                  )}
                </div>
              )}

              {/* Every channel routes to a target, so the binding is edited
                  before any create choice: the quick flow is started FOR it. */}
              <label style={styles.field}>
                <span style={styles.fieldLabel}>{t('channels.form.target')}</span>
                <select
                  aria-label={t('channels.form.target')}
                  value={targetKey_}
                  onChange={(event) => setTargetKey(event.target.value)}
                  style={styles.select}
                >
                  <option value="" disabled>{t('channels.form.target.placeholder')}</option>
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
              </label>

              {instance === undefined && schema.quickSetup === true && targetKey_ !== '' && (
                <SegmentedControl
                  id="channels-entry-mode"
                  value={entryMode}
                  label={t('channels.provision.modeLabel')}
                  options={[
                    { value: 'quick', label: t('channels.provision.quick') },
                    { value: 'manual', label: t('channels.provision.manual') },
                  ]}
                  onChange={setEntryMode}
                />
              )}

              {quickMode && (
                <ProvisionPane
                  // A different target means a different flow: remount so the
                  // host starts (and stops) the QR session in that scope.
                  key={`${channelType}:${targetKey_}`}
                  t={t}
                  channelType={channelType}
                  target={selected}
                  onSaved={onSaved}
                  onToast={onToast}
                />
              )}

              {!quickMode && (
                <>
                  <label style={styles.field}>
                    <span style={styles.fieldLabel}>{t('channels.form.name')}</span>
                    <Input
                      aria-label={t('channels.form.name')}
                      data-modal-autofocus
                      value={name}
                      placeholder={t('channels.form.name.placeholder')}
                      required
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>

                  {schema.config.map((field) => (
                    <FieldControl
                      key={field.name}
                      t={t}
                      field={field}
                      value={values[field.name]}
                      onChange={(value) => setValue(field.name, value)}
                    />
                  ))}

                  {schema.credentials.map((spec) => (
                    <CredentialField
                      key={spec.name}
                      t={t}
                      spec={spec}
                      status={instance?.credential}
                      value={secrets[spec.name] ?? ''}
                      onChange={(value) => setSecrets((current) => ({ ...current, [spec.name]: value }))}
                      mode={instance === undefined ? 'create' : 'edit'}
                    />
                  ))}
                </>
              )}
            </form>
          )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title={t('channels.confirm.delete.title')}
        description={fmt(t('channels.confirm.delete'), { name: instance?.name ?? '' })}
        closeLabel={t('channels.action.close')}
        cancelLabel={t('channels.action.cancel')}
        confirmLabel={t('channels.action.delete')}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </>
  )
}
