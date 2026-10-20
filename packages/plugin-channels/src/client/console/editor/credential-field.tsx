/**
 * The credential control of the channel editor (design 07 §3/§5).
 *
 * A secret is write-only: the input starts empty, is never prefilled from the
 * instance, and an empty control sends no credential key at all (the host keeps
 * the stored record). A deployment-provided credential (`writable === false`)
 * is reported as read-only instead of accepting a value that would never be
 * persisted, and the status tag names only whether a secret exists.
 */
import type { ReactElement } from 'react'
import { Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CredentialSpec, CredentialStatus } from '../../api.ts'
import { localize, type Translate } from '../../locales.ts'
import { styles } from '../ui.ts'
import { credentialLabel } from './form-model.ts'

export interface CredentialFieldProps {
  t: Translate
  spec: CredentialSpec
  /** Absent on create — the instance does not exist yet. */
  status: CredentialStatus | undefined
  value: string
  onChange: (value: string) => void
  mode: 'create' | 'edit'
}

export function CredentialField({ t, spec, status, value, onChange, mode }: CredentialFieldProps): ReactElement {
  const label = credentialLabel(t, spec)
  const help = localize(t, spec.helpKey, '')
  const locked = mode === 'edit' && status?.writable === false
  const placeholder = mode === 'edit'
    ? t('channels.form.credential.keep')
    : localize(t, spec.placeholderKey, '')

  return (
    <div style={styles.field}>
      <span style={styles.fieldLabel}>{label}</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center' }}>
        <Input
          type="password"
          aria-label={label}
          value={value}
          disabled={locked}
          placeholder={placeholder}
          required={mode === 'create' && spec.required}
          autoComplete="new-password"
          onChange={(event) => onChange(event.target.value)}
        />
        {mode === 'edit' && status !== undefined && (
          <span style={styles.row}>
            <Tag tone={status.configured ? 'success' : 'warning'}>
              {t(status.configured ? 'channels.form.credential.configured' : 'channels.form.credential.missing')}
            </Tag>
            {!status.writable && <Tag tone="info">{t('channels.credential.fromEnv')}</Tag>}
          </span>
        )}
      </div>
      {help !== '' && <span style={styles.fieldHelp}>{help}</span>}
      {locked && <span style={styles.fieldHelp}>{t('channels.form.credential.readonly')}</span>}
    </div>
  )
}
