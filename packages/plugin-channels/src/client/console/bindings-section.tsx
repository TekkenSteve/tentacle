/**
 * The identity-binding block of the selected instance: the binding table with
 * its unbind action, and the one-line bind form.
 *
 * Unbinding is destructive and goes through the shared confirmation dialog
 * (never `window.confirm`); binding is additive and submits straight away.
 * Both reload the parent overview on success, exactly as the REST contract
 * reports it.
 */
import { useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  channelsCall,
  errorText,
  type BindableUser,
  type BindingView,
  type ChannelInstanceView,
  type PendingSenderView,
} from '../api.ts'
import { fmt, type Translate } from '../locales.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'
import type { ToastFn } from './contracts.ts'
import { relativeLabel } from './relative-time.ts'
import { colors, styles } from './ui.ts'

export interface BindingsSectionProps {
  t: Translate
  instance: ChannelInstanceView
  bindings: readonly BindingView[]
  /** Refused unbound senders (reject policy) — bind one without a code. */
  pendingSenders: readonly PendingSenderView[]
  users: readonly BindableUser[]
  onToast: ToastFn
  reload: () => void
}

export function BindingsSection({ t, instance, bindings, pendingSenders, users, onToast, reload }: BindingsSectionProps): ReactElement {
  const [subjectId, setSubjectId] = useState('')
  const [platformId, setPlatformId] = useState('')
  const [pendingUnbind, setPendingUnbind] = useState<BindingView | undefined>(undefined)
  /** Per-row user choice for the pending-sender inbox, keyed by platformId. */
  const [rowChoice, setRowChoice] = useState<Record<string, string>>({})
  // The directory list is the whole choice space; defaulting to its first entry
  // keeps the control from sitting on an empty placeholder.
  const chosenUser = subjectId === '' ? (users[0]?.subjectId ?? '') : subjectId

  const unbind = async (binding: BindingView): Promise<void> => {
    setPendingUnbind(undefined)
    try {
      await channelsCall('/unbind', { channelId: binding.channelId, platformId: binding.platformId })
      onToast(t('channels.toast.unbound'), 'success')
      reload()
    } catch (error) {
      onToast(errorText(t, error))
    }
  }

  /** Bind one refused sender straight from the inbox row (no /bind code). */
  const bindPending = async (row: PendingSenderView): Promise<void> => {
    const choice = rowChoice[row.platformId] ?? users[0]?.subjectId ?? ''
    if (choice === '') return
    try {
      await channelsCall('/bind', { channelId: instance.id, platformId: row.platformId, subjectId: choice })
      onToast(t('channels.toast.bound'), 'success')
      reload()
    } catch (error) {
      onToast(errorText(t, error))
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const platform = platformId.trim()
    if (chosenUser === '' || platform === '') return
    try {
      await channelsCall('/bind', { channelId: instance.id, platformId: platform, subjectId: chosenUser })
      onToast(t('channels.toast.bound'), 'success')
      setPlatformId('')
      reload()
    } catch (error) {
      onToast(errorText(t, error))
    }
  }

  return (
    <div style={styles.stack}>
      <div style={styles.stack}>
        <h4 style={{ margin: 0, fontSize: 12, lineHeight: '18px', fontWeight: 600, color: colors.text }}>
          {t('channels.pending.title')}
        </h4>
        <p style={styles.hint}>{t('channels.pending.hint')}</p>
        {pendingSenders.length === 0
          ? <p style={styles.hint}>{t('channels.pending.empty')}</p>
          : (
          <div style={styles.card}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={{ ...styles.th, width: '28%' }}>{t('channels.pending.sender')}</th>
                  <th style={{ ...styles.th, width: '14%' }}>{t('channels.pending.lastSeen')}</th>
                  <th style={{ ...styles.th, width: '26%' }}>{t('channels.pending.preview')}</th>
                  <th style={{ ...styles.th, width: '20%' }}>{t('channels.col.user')}</th>
                  <th style={{ ...styles.th, width: '12%' }} />
                </tr>
              </thead>
              <tbody>
                {pendingSenders.map((row) => (
                  <tr key={row.platformId}>
                    <td style={styles.td} title={row.platformId}>
                      {row.displayName ?? row.platformId}
                      {row.displayName !== undefined && <div style={styles.tiny}>{row.platformId}</div>}
                    </td>
                    <td
                      style={{ ...styles.td, color: colors.secondary }}
                      title={new Date(row.lastSeen).toLocaleString()}
                    >
                      {relativeLabel(t, row.lastSeen)}
                    </td>
                    <td style={{ ...styles.td, color: colors.secondary }} title={row.preview}>{row.preview ?? '—'}</td>
                    <td style={styles.td}>
                      <select
                        aria-label={t('channels.col.user')}
                        style={styles.select}
                        value={rowChoice[row.platformId] ?? users[0]?.subjectId ?? ''}
                        onChange={(event) => setRowChoice((current) => ({ ...current, [row.platformId]: event.target.value }))}
                      >
                        {users.map((user) => (
                          <option key={user.subjectId} value={user.subjectId}>{user.username}</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={users.length === 0}
                        onClick={() => void bindPending(row)}
                      >
                        {t('channels.action.bind')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
      </div>

      {bindings.length === 0
        ? <p style={styles.hint}>{t('channels.hint.noBindings')}</p>
        : (
          <div style={styles.card}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={{ ...styles.th, width: '26%' }}>{t('channels.col.platformId')}</th>
                  <th style={{ ...styles.th, width: '34%' }}>{t('channels.col.user')}</th>
                  <th style={{ ...styles.th, width: '20%' }}>{t('channels.col.boundAt')}</th>
                  <th style={{ ...styles.th, width: '20%' }} />
                </tr>
              </thead>
              <tbody>
                {bindings.map((binding) => (
                  <tr key={binding.platformId}>
                    <td style={{ ...styles.td, ...styles.codeCell }} title={binding.platformId}>{binding.platformId}</td>
                    <td style={{ ...styles.td, ...styles.codeCell }} title={binding.subjectId}>
                      {binding.username ?? binding.subjectId}
                      {binding.username !== undefined && (
                        <span style={{ color: colors.tertiary }}> ({binding.subjectId})</span>
                      )}
                    </td>
                    <td style={{ ...styles.td, color: colors.secondary }} title={new Date(binding.boundAt).toLocaleString()}>
                      {relativeLabel(t, binding.boundAt)}
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        style={styles.danger}
                        onClick={() => setPendingUnbind(binding)}
                      >
                        {t('channels.action.unbind')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      <form
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: 8 }}
        onSubmit={submit}
      >
        <select
          aria-label={t('channels.col.user')}
          value={chosenUser}
          required
          onChange={(event) => setSubjectId(event.target.value)}
          style={styles.select}
        >
          <option value="">—</option>
          {users.map((user) => (
            <option key={user.subjectId} value={user.subjectId}>{user.username}</option>
          ))}
        </select>
        <Input
          aria-label={t('channels.col.platformId')}
          value={platformId}
          placeholder={t('channels.prompt.platformId')}
          required
          onChange={(event) => setPlatformId(event.target.value)}
        />
        <Button type="submit" variant="primary" disabled={users.length === 0}>
          {t('channels.action.bind')}
        </Button>
      </form>
      {users.length === 0 && <p style={styles.hint}>{t('channels.bind.noUsers')}</p>}

      <ConfirmDialog
        open={pendingUnbind !== undefined}
        title={t('channels.confirm.unbind.title')}
        description={t('channels.confirm.unbind')}
        closeLabel={t('channels.action.close')}
        cancelLabel={t('channels.action.cancel')}
        confirmLabel={t('channels.action.unbind')}
        onCancel={() => setPendingUnbind(undefined)}
        onConfirm={() => { if (pendingUnbind !== undefined) void unbind(pendingUnbind) }}
      />

    </div>
  )
}
