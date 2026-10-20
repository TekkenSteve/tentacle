/**
 * One host-schema-driven field of the channel editor.
 *
 * The host declares the control kind; this module maps it onto the official
 * primitives and falls back to a native `select` for `select`, which the
 * primitives do not ship (the native control is colored with the same tokens
 * as `Input`). Every label resolves through the dictionary with the raw field
 * name as the fallback, so a host schema that lands before its copy stays
 * readable.
 */
import type { ReactElement } from 'react'
import { Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FieldSpec } from '../../api.ts'
import { localize, type Translate } from '../../locales.ts'
import { styles } from '../ui.ts'
import { fieldLabel, type FormValue } from './form-model.ts'

export interface FieldControlProps {
  t: Translate
  field: FieldSpec
  value: FormValue | undefined
  onChange: (value: FormValue) => void
}

export function FieldControl({ t, field, value, onChange }: FieldControlProps): ReactElement {
  const label = fieldLabel(t, field)
  const help = localize(t, field.helpKey, '')
  const text = typeof value === 'string' ? value : ''

  return (
    <label style={styles.field}>
      <span style={styles.fieldLabel}>{label}</span>
      {field.kind === 'switch'
        ? <Switch checked={value === true} onChange={onChange} label={label} />
        : field.kind === 'select'
          ? (
            <select
              aria-label={label}
              value={text}
              required={field.required === true}
              onChange={(event) => onChange(event.target.value)}
              style={styles.select}
            >
              <option value="">—</option>
              {(field.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {localize(t, option.labelKey, option.value)}
                </option>
              ))}
            </select>
          )
          : (
            <Input
              type={field.kind === 'number' ? 'number' : field.kind === 'password' ? 'password' : 'text'}
              aria-label={label}
              value={text}
              placeholder={localize(t, field.placeholderKey, '')}
              required={field.required === true}
              // A `password`-kind config field is a secret like the credential:
              // never offer a saved value for it.
              autoComplete={field.kind === 'password' ? 'new-password' : undefined}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
      {help !== '' && <span style={styles.fieldHelp}>{help}</span>}
    </label>
  )
}
