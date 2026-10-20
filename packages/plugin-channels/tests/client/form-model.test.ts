/**
 * The editor's pure schema ↔ form model. These are the conversions the dialog
 * depends on, so they are pinned directly instead of only through the rendered
 * console: in particular the draft projection is the invariant that keeps a
 * secret out of `sessionStorage`.
 */
import { describe, expect, it } from 'vitest'
import type { ChannelInstanceView, ChannelTypeSchema } from '../../src/client/api.ts'
import {
  baselineFor,
  configPayload,
  configToForm,
  credentialsPayload,
  defaultsFor,
  draftValues,
  isBlank,
  mergeDraft,
  pickSchemaValues,
  scopeOf,
} from '../../src/client/console/editor/form-model.ts'

const schema: ChannelTypeSchema = {
  channelType: 'telegram',
  config: [
    { name: 'apiBaseUrl', kind: 'text', labelKey: 'channels.field.apiBaseUrl' },
    { name: 'pollTimeoutSec', kind: 'number', labelKey: 'channels.field.pollTimeoutSec', default: 30 },
    { name: 'typing', kind: 'switch', labelKey: 'channels.field.typing', default: false },
    { name: 'webhookSecret', kind: 'password', labelKey: 'channels.field.webhookSecret' },
  ],
  credentials: [{ name: 'token', required: true, labelKey: 'channels.field.token' }],
}

describe('channel form model', () => {  it('scopes a draft per instance or per new channel type', () => {
    expect(scopeOf({ mode: 'create' }, 'telegram')).toEqual({ kind: 'new', channelType: 'telegram' })
    const instance = baselineInstance()
    expect(scopeOf({ mode: 'edit', instance }, 'telegram')).toEqual({ kind: 'instance', id: 'ch-1' })
  })

  it('builds the credentials payload from non-empty fields only, or nothing at all', () => {
    expect(credentialsPayload({})).toBeUndefined()
    expect(credentialsPayload({ token: '', appSecret: '  ' })).toBeUndefined()
    expect(credentialsPayload({ token: 't', appSecret: 's', encryptKey: '' })).toEqual({ token: 't', appSecret: 's' })
  })

  it('projects schema defaults and stored config onto the controls', () => {
    expect(defaultsFor(schema)).toEqual({ apiBaseUrl: '', pollTimeoutSec: '30', typing: false, webhookSecret: '' })
    expect(configToForm(schema, { apiBaseUrl: 'https://tg.example', typing: true, pollTimeoutSec: 20 }))
      .toEqual({ apiBaseUrl: 'https://tg.example', pollTimeoutSec: '20', typing: true, webhookSecret: '' })
    expect(baselineFor(schema, undefined)).toEqual(defaultsFor(schema))
    expect(baselineFor(schema, baselineInstance())).toEqual(
      configToForm(schema, { apiBaseUrl: 'https://tg.example', typing: true }),
    )
  })

  it('overlays a draft value only when its type fits the declared control', () => {
    const base = defaultsFor(schema)
    const merged = mergeDraft(schema, base, {
      name: 'x',
      config: { typing: 'yes', pollTimeoutSec: 45, apiBaseUrl: 7, unknown: 'dropped' },
    })
    expect(merged).toEqual({ apiBaseUrl: '7', pollTimeoutSec: '45', typing: false, webhookSecret: '' })
  })

  it('excludes password-kind fields from every draft', () => {
    const values = { apiBaseUrl: 'https://tg.example', pollTimeoutSec: '45', typing: true, webhookSecret: 'hook-secret' }
    const draft = draftValues(schema, values)
    expect(draft).toEqual({ apiBaseUrl: 'https://tg.example', pollTimeoutSec: '45', typing: true })
    expect(JSON.stringify(draft)).not.toContain('hook-secret')
  })

  it('omits empty controls from the payload but always sends switches', () => {
    expect(configPayload(schema, { apiBaseUrl: '', pollTimeoutSec: '', typing: false, webhookSecret: '' }))
      .toEqual({ typing: false })
    expect(configPayload(schema, { apiBaseUrl: 'u', pollTimeoutSec: '12', typing: true, webhookSecret: '' }))
      .toEqual({ apiBaseUrl: 'u', pollTimeoutSec: 12, typing: true })
  })

  it('normalizes the comparable shape and treats empty values as blank', () => {
    expect(pickSchemaValues(schema, { pollTimeoutSec: '12', typing: true }))
      .toEqual({ apiBaseUrl: '', pollTimeoutSec: '12', typing: true, webhookSecret: '' })
    // an untouched form still compares field-by-field, never by key presence
    expect(pickSchemaValues(schema, {})).toEqual({ apiBaseUrl: '', pollTimeoutSec: '', typing: false, webhookSecret: '' })
    expect(isBlank('')).toBe(true)
    expect(isBlank(undefined)).toBe(true)
    expect(isBlank(false)).toBe(false)
  })
})

function baselineInstance(): ChannelInstanceView {
  return {
    id: 'ch-1',
    tenant: 'local',
    channelType: 'telegram',
    name: 'main-bot',
    enabled: true,
    config: { apiBaseUrl: 'https://tg.example', typing: true },
    target: { kind: 'expert', id: 'general-assistant' },
    createdAt: 0,
    updatedAt: 0,
    runtime: { state: 'pending' },
    credential: { configured: true, writable: true },
  }
}
