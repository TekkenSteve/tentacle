// @vitest-environment jsdom
/**
 * The channels console: list states, enable switch, create/edit dialog
 * (schema-driven, write-only credentials), optimistic delete, connection
 * probes, draft persistence, bindings and error-code toasts.
 *
 * Network access is stubbed at the global `fetch` face the console uses; the
 * stub keys responses by `METHOD path?query` so a wrong request is a visible
 * 404 rather than a silent pass.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is replaced by a real-DOM double —
 * the published package cannot be imported under jsdom (`clsx` is a
 * dev-dependency of it and its CSS modules need a bundler). See
 * `primitives-stub.tsx`.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./primitives-stub.tsx'))


import { ChannelsApiError, errorText, type ChannelInstanceView, type ChannelTypeSchema } from '../../src/client/api.ts'
import { ChannelsConsoleView } from '../../src/client/console/channels-console.tsx'
import { fmt, zh, type ChannelsLocaleKey } from '../../src/client/locales.ts'

const t = (key: ChannelsLocaleKey): string => zh[key]

// ---- fetch stub ----

interface StubCall { method: 'GET' | 'POST'; path: string; body?: unknown }
interface StubResponse { status: number; body: unknown }

let calls: StubCall[]
let responses: Map<string, StubResponse>

function stubFetch(): void {
  calls = []
  responses = new Map()
  responses.set('GET /experts', { status: 200, body: EXPERT_ROSTER })
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    const url = new URL(input, 'http://localhost')
    const path = (url.pathname.replace('/tentacle/api/admin/channels', '') || '/') + url.search
    const method = init?.method === 'POST' ? 'POST' : 'GET'
    calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const stub = responses.get(`${method} ${path}`)
    if (stub === undefined) return { ok: false, status: 404, json: async () => ({ error: 'not-stubbed' }) }
    return { ok: stub.status < 400, status: stub.status, json: async () => stub.body }
  }))
}

function okGet(path: string, body: unknown): void { responses.set(`GET ${path}`, { status: 200, body }) }
function okPost(path: string, body: unknown): void { responses.set(`POST ${path}`, { status: 200, body }) }
function failPost(path: string, status: number, code: string): void {
  responses.set(`POST ${path}`, { status, body: { error: code } })
}

function callOf(path: string): StubCall | undefined {
  return calls.find((call) => call.path === path)
}

const EXPERT_ROSTER = [{ id: 'general-assistant', name: 'General Assistant', agentPresetId: 'expert-general-assistant' }]

beforeEach(() => {
  stubFetch()
  // The console loads the expert roster next to the overview; every channel
  // routes to one, so the create dialog pre-selects the first.
  okGet('/experts', EXPERT_ROSTER)
  sessionStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  cleanup()
})

// ---- fixtures ----

type InstanceOverrides = Partial<Omit<ChannelInstanceView, 'id' | 'name'>> & { id: string; name: string }

function view(overrides: InstanceOverrides): ChannelInstanceView {
  return {
    tenant: 'local',
    channelType: 'telegram',
    enabled: true,
    config: {},
    target: { kind: 'expert', id: 'general-assistant' },
    createdAt: 0,
    updatedAt: 0,
    credential: { configured: true, writable: true },
    runtime: { state: 'pending' },
    ...overrides,
  }
}

/**
 * Mirrors the host's Telegram schema, plus one field whose `labelKey` the
 * dictionary does not know — the fallback-to-field-name path.
 */
const TELEGRAM_SCHEMA: ChannelTypeSchema = {
  channelType: 'telegram',
  config: [
    {
      name: 'apiBaseUrl',
      kind: 'text',
      labelKey: 'channels.field.apiBaseUrl',
      placeholderKey: 'channels.field.apiBaseUrl.placeholder',
      helpKey: 'channels.field.apiBaseUrl.help',
    },
    {
      name: 'pollTimeoutSec',
      kind: 'number',
      labelKey: 'channels.field.pollTimeoutSec',
      helpKey: 'channels.field.pollTimeoutSec.help',
      default: 30,
    },
    {
      name: 'typing',
      kind: 'switch',
      labelKey: 'channels.field.typing',
      helpKey: 'channels.field.typing.help',
      default: false,
    },
    {
      name: 'mode',
      kind: 'select',
      labelKey: 'channels.field.mode',
      required: true,
      options: [
        { value: 'poll', labelKey: 'channels.field.mode.poll' },
        { value: 'webhook', labelKey: 'channels.field.mode.webhook' },
      ],
    },
  ],
  credentials: [
    {
      name: 'token',
      required: true,
      labelKey: 'channels.field.token',
      placeholderKey: 'channels.field.token.placeholder',
      helpKey: 'channels.field.token.help',
    },
  ],
}

function mount(): void {
  render(<ChannelsConsoleView t={t} />)
}

const EMPTY_OVERVIEW = { instances: [], bindings: [], conversations: [], pendingSenders: [] }

/** The panel header's "new channel" action (the empty state carries a second one). */
async function openCreate(): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: zh['channels.action.new'] })
  fireEvent.click(buttons[0] as HTMLElement)
  // Creating from the "all" view pre-selects the roster's first target once
  // the roster resolves; wait for that instead of racing the fetch.
  await waitFor(() => {
    expect((screen.getByLabelText(zh['channels.form.target']) as HTMLSelectElement).value).not.toBe('')
  })
}

// ---- dialog helpers (the primitives render into a body portal) ----

function dialog(name: string): HTMLElement {
  return screen.getByRole('dialog', { name })
}

const CREATE_TITLE = zh['channels.form.create']
const editTitle = (name: string): string => fmt(zh['channels.form.editNamed'], { name })

function editorForm(name: string): HTMLFormElement {
  const form = dialog(name).querySelector('form')
  if (form === null) throw new Error(`no form in the "${name}" dialog`)
  return form
}

/** The footer's Save button: a submit button associated with the body form. */
function save(name: string): void {
  fireEvent.click(within(dialog(name)).getByRole('button', { name: zh['channels.action.save'] }))
}

function cancel(name: string): void {
  fireEvent.click(within(dialog(name)).getByRole('button', { name: zh['channels.action.cancel'] }))
}

function actionLabel(action: ChannelsLocaleKey, name: string): string {
  return fmt(zh['channels.action.aria'], { action: zh[action], name })
}

/** Select an instance row the way a user does: the row's own bind/select action. */
async function selectRow(name: string): Promise<void> {
  fireEvent.click(await screen.findByLabelText(actionLabel('channels.action.bind', name)))
}

describe('channels console', () => {
  it('renders the stats tags, all four runtime states and the bot identity', async () => {
    okGet('/', {
      instances: [
        view({ id: 'ch-1', name: 'main-bot', runtime: { state: 'connected', identity: { id: 42, username: 'tentacle_bot' } } }),
        view({ id: 'ch-2', name: 'backup-bot', runtime: { state: 'pending' } }),
        view({ id: 'ch-3', name: 'broken-bot', runtime: { state: 'failed', error: 'getUpdates: 401 Unauthorized' } }),
        view({ id: 'ch-4', name: 'idle-bot', enabled: false, runtime: { state: 'disabled' } }),
        view({ id: 'ch-5', name: 'quiet-bot', runtime: { state: 'connected' } }),
      ],
      bindings: [
        { channelId: 'ch-1', channelType: 'telegram', platformId: '111', subjectId: 'did:key:alice', boundAt: Date.now() - 30_000, username: 'alice' },
      ],
      conversations: [{ channelId: 'ch-1', conversation: 'telegram:111', sessionId: 'sess-1' }],
      pendingSenders: [],
      lastFailure: 'dispatched session never appeared',
    })
    okGet('/schema', [TELEGRAM_SCHEMA])
    mount()

    expect(await screen.findByText('main-bot')).toBeTruthy()
    expect(screen.getByText(fmt(zh['channels.stats.instances'], { n: 5 }))).toBeTruthy()
    expect(screen.getByText(fmt(zh['channels.stats.running'], { n: 2 }))).toBeTruthy()
    expect(screen.getByText(fmt(zh['channels.stats.bindings'], { n: 1 }))).toBeTruthy()
    expect(screen.getByText('@tentacle_bot')).toBeTruthy()
    // a connected adapter that has not reported an identity still says so
    expect(screen.getByText(zh['channels.badge.connected'])).toBeTruthy()
    expect(screen.getByText(zh['channels.badge.pending'])).toBeTruthy()
    expect(screen.getByText(zh['channels.badge.failed'])).toBeTruthy()
    expect(screen.getByText('getUpdates: 401 Unauthorized')).toBeTruthy()
    expect(screen.getByText(zh['channels.badge.disabled'])).toBeTruthy()
    // credential and deployment-reference facts ride the row
    expect(screen.getAllByText(zh['channels.credential.configured']).length).toBe(5)
    expect(screen.queryByText(zh['channels.credential.missing'])).toBeNull()
    expect(screen.getByText(fmt(zh['channels.hint.routingFailure'], { reason: 'dispatched session never appeared' }))).toBeTruthy()

    // the binding block stays empty until an instance is selected; conversation
    // links are an overview, so they are already visible without a selection
    expect(screen.getByText(zh['channels.hint.selectInstance'])).toBeTruthy()
    expect(screen.getByText('telegram:111')).toBeTruthy()

    await selectRow('main-bot')
    expect(await screen.findByText('111')).toBeTruthy()
    // conversations are read-only and carry the channel and session ids
    expect(screen.getByText('telegram:111')).toBeTruthy()
    expect(screen.getByText('sess-1')).toBeTruthy()

    // selecting an instance without links filters the overview down to it
    await selectRow('quiet-bot')
    expect(await screen.findByText(zh['channels.hint.noConversations'])).toBeTruthy()
  })

  it('shows the empty state with the one-shot seed guidance and a primary action', async () => {
    okGet('/', EMPTY_OVERVIEW)
    okGet('/schema', [TELEGRAM_SCHEMA])
    mount()

    expect(await screen.findByText(zh['channels.empty.title'])).toBeTruthy()
    expect(screen.getByText(zh['channels.empty.hint'])).toBeTruthy()
    const newChannel = screen.getAllByRole('button', { name: zh['channels.action.new'] })
    expect(newChannel.length).toBe(2)
    fireEvent.click(newChannel[1] as HTMLElement)
    expect(await screen.findByRole('dialog', { name: CREATE_TITLE })).toBeTruthy()
  })

  it('toggles enable/disable directly and rolls the switch back on failure', async () => {
    okGet('/', {
      instances: [
        view({ id: 'ch-1', name: 'main-bot', enabled: false, runtime: { state: 'disabled' } }),
        view({ id: 'ch-2', name: 'live-bot', runtime: { state: 'connected' } }),
      ],
      bindings: [],
      conversations: [],
      pendingSenders: [],
    })
    okGet('/schema', [TELEGRAM_SCHEMA])
    okPost('/enable', view({ id: 'ch-1', name: 'main-bot', runtime: { state: 'pending' } }))
    failPost('/disable', 409, 'credentials-unavailable')
    mount()

    const switchName = (name: string): string => fmt(zh['channels.switch.aria'], { name })
    const mainSwitch = await screen.findByRole('switch', { name: switchName('main-bot') })
    expect(mainSwitch.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(mainSwitch)
    await waitFor(() => expect(callOf('/enable')?.body).toEqual({ id: 'ch-1' }))
    expect(screen.getByText(zh['channels.toast.enabled'])).toBeTruthy()

    const liveSwitch = screen.getByRole('switch', { name: switchName('live-bot') })
    expect(liveSwitch.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(liveSwitch)
    await waitFor(() => expect(callOf('/disable')?.body).toEqual({ id: 'ch-2' }))
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: switchName('live-bot') }).getAttribute('aria-checked')).toBe('true')
    })
    expect(screen.getByText(zh['channels.error.credentialsUnavailable'])).toBeTruthy()
  })

  it('creates an instance from the host schema and posts the token body', async () => {
    okGet('/', EMPTY_OVERVIEW)
    okGet('/schema', [TELEGRAM_SCHEMA])
    okPost('/create', view({ id: 'ch-new', name: 'main-bot' }))
    mount()

    await screen.findByText(zh['channels.empty.title'])
    await openCreate()

    // defaults from the schema land in the controls
    expect((screen.getByLabelText(zh['channels.field.pollTimeoutSec']) as HTMLInputElement).value).toBe('30')
    expect(screen.getByLabelText(zh['channels.field.typing']).getAttribute('aria-checked')).toBe('false')
    // an unknown labelKey falls back to the raw field name
    const mode = screen.getByLabelText('mode') as HTMLSelectElement

    fireEvent.change(screen.getByLabelText(zh['channels.form.name']), { target: { value: 'main-bot' } })
    fireEvent.change(screen.getByLabelText(zh['channels.field.apiBaseUrl']), { target: { value: 'https://tg.example' } })
    fireEvent.change(screen.getByLabelText(zh['channels.field.pollTimeoutSec']), { target: { value: '45' } })
    fireEvent.click(screen.getByLabelText(zh['channels.field.typing']))
    fireEvent.change(mode, { target: { value: 'webhook' } })
    fireEvent.change(screen.getByLabelText(zh['channels.field.token']), { target: { value: 'secret-token' } })
    save(CREATE_TITLE)

    await waitFor(() => {
      expect(callOf('/create')?.body).toEqual({
        channelType: 'telegram',
        target: { kind: 'expert', id: 'general-assistant' },
        name: 'main-bot',
        config: { apiBaseUrl: 'https://tg.example', pollTimeoutSec: 45, typing: true, mode: 'webhook' },
        credentials: { token: 'secret-token' },
      })
    })
    expect(await screen.findByText(zh['channels.toast.created'])).toBeTruthy()
  })

  it('rejects a required schema field before calling the API', async () => {
    okGet('/', EMPTY_OVERVIEW)
    okGet('/schema', [TELEGRAM_SCHEMA])
    mount()

    await screen.findByText(zh['channels.empty.title'])
    await openCreate()
    fireEvent.change(screen.getByLabelText(zh['channels.form.name']), { target: { value: 'main-bot' } })
    fireEvent.change(screen.getByLabelText(zh['channels.field.token']), { target: { value: 'tok' } })
    fireEvent.submit(editorForm(CREATE_TITLE))

    expect(await screen.findByText(fmt(zh['channels.form.error.required'], { field: 'mode' }))).toBeTruthy()
    expect(callOf('/create')).toBeUndefined()
  })

  it('probes a draft on create and shows the identity or the failure in the dialog', async () => {
    okGet('/', EMPTY_OVERVIEW)
    okGet('/schema', [TELEGRAM_SCHEMA])
    okPost('/probe', { ok: true, identity: { id: 7, username: 'draft_bot' } })
    mount()

    await screen.findByText(zh['channels.empty.title'])
    await openCreate()
    fireEvent.change(screen.getByLabelText(zh['channels.field.token']), { target: { value: 'draft-token' } })
    fireEvent.click(within(dialog(CREATE_TITLE)).getByRole('button', { name: zh['channels.action.test'] }))

    const identity = fmt(zh['channels.form.probe.identity'], { username: 'draft_bot' })
    expect(await screen.findByText(`${zh['channels.form.probe.ok']} · ${identity}`)).toBeTruthy()
    expect(callOf('/probe')?.body).toEqual({
      channelType: 'telegram',
      config: { pollTimeoutSec: 30, typing: false },
      credentials: { token: 'draft-token' },
    })

    okPost('/probe', { ok: false, error: 'getMe: 401 Unauthorized' })
    fireEvent.click(within(dialog(CREATE_TITLE)).getByRole('button', { name: zh['channels.action.test'] }))
    expect(await screen.findByText('getMe: 401 Unauthorized')).toBeTruthy()
  })

  it('edits an instance without ever echoing the secret and omits an empty credential', async () => {
    okGet('/', {
      instances: [
        view({
          id: 'ch-9',
          name: 'main-bot',
          tokenRef: 'TELEGRAM_BOT_TOKEN',
          config: { apiBaseUrl: 'https://tg.example', pollTimeoutSec: 20, typing: true, mode: 'poll' },
          credential: { configured: true, writable: false },
          runtime: { state: 'connected', identity: { id: 5, username: 'saved_bot' } },
        }),
      ],
      bindings: [],
      conversations: [],
      pendingSenders: [],
    })
    okGet('/schema', [TELEGRAM_SCHEMA])
    okPost('/update', view({ id: 'ch-9', name: 'main-bot' }))
    okPost('/test', { ok: true, identity: { id: 5, username: 'saved_bot' } })
    mount()

    fireEvent.click(await screen.findByLabelText(actionLabel('channels.action.edit', 'main-bot')))
    const title = editTitle('main-bot')

    // A deployment-provided credential is reported, never edited.
    const credential = screen.getByLabelText(zh['channels.field.token']) as HTMLInputElement
    expect(credential.value).toBe('')
    expect(credential.disabled).toBe(true)
    expect(credential.placeholder).toBe(zh['channels.form.credential.keep'])
    expect(screen.getByText(zh['channels.form.credential.configured'])).toBeTruthy()
    // the editor reports the deployment-provided secret; the row carries its own tag
    expect(within(dialog(editTitle('main-bot'))).getByText(zh['channels.credential.fromEnv'])).toBeTruthy()
    expect(screen.getAllByText(zh['channels.credential.fromEnv']).length).toBe(2)
    expect(screen.getByText(zh['channels.form.credential.readonly'])).toBeTruthy()
    // the locked facts are read-only text, not controls
    expect(screen.getByText('TELEGRAM_BOT_TOKEN')).toBeTruthy()
    expect(screen.getByText('ch-9')).toBeTruthy()
    expect(within(dialog(editTitle('main-bot'))).getByText('local')).toBeTruthy()
    expect(screen.queryByLabelText(zh['channels.form.type'])).toBeNull()

    // non-secret config is prefilled from the instance
    expect((screen.getByLabelText(zh['channels.field.apiBaseUrl']) as HTMLInputElement).value).toBe('https://tg.example')
    expect((screen.getByLabelText(zh['channels.field.pollTimeoutSec']) as HTMLInputElement).value).toBe('20')
    expect(screen.getByLabelText(zh['channels.field.typing']).getAttribute('aria-checked')).toBe('true')

    // saved-config probe
    fireEvent.click(within(dialog(title)).getByRole('button', { name: zh['channels.action.test'] }))
    await waitFor(() => expect(callOf('/test')?.body).toEqual({ id: 'ch-9' }))
    expect(await screen.findByText(`${zh['channels.form.probe.ok']} · ${fmt(zh['channels.form.probe.identity'], { username: 'saved_bot' })}`)).toBeTruthy()

    // a blank credential control sends no token key at all
    fireEvent.change(screen.getByLabelText(zh['channels.form.name']), { target: { value: 'renamed-bot' } })
    fireEvent.submit(editorForm(title))
    await waitFor(() => {
      expect(callOf('/update')?.body).toEqual({
        id: 'ch-9',
        name: 'renamed-bot',
        config: { apiBaseUrl: 'https://tg.example', pollTimeoutSec: 20, typing: true, mode: 'poll' },
      })
    })
    expect(await screen.findByText(zh['channels.toast.saved'])).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: title })).toBeNull()
  })

  it('enables a writable, unconfigured credential and reports its missing state', async () => {
    okGet('/', {
      instances: [view({ id: 'ch-2', name: 'fresh-bot', config: { mode: 'poll' }, credential: { configured: false, writable: true } })],
      bindings: [],
      conversations: [],
      pendingSenders: [],
    })
    okGet('/schema', [TELEGRAM_SCHEMA])
    okPost('/update', view({ id: 'ch-2', name: 'fresh-bot' }))
    mount()

    fireEvent.click(await screen.findByLabelText(actionLabel('channels.action.edit', 'fresh-bot')))
    const credential = screen.getByLabelText(zh['channels.field.token']) as HTMLInputElement
    expect(credential.disabled).toBe(false)
    expect(screen.getByText(zh['channels.form.credential.missing'])).toBeTruthy()
    // writable: no deployment-provided tag, no read-only explanation
    expect(screen.queryByText(zh['channels.credential.fromEnv'])).toBeNull()
    expect(screen.queryByText(zh['channels.form.credential.readonly'])).toBeNull()

    fireEvent.change(credential, { target: { value: 'fresh-token' } })
    save(editTitle('fresh-bot'))
    await waitFor(() => {
      expect((callOf('/update')?.body as Record<string, unknown>)['credentials']).toEqual({ token: 'fresh-token' })
    })
  })

  it('confirms a delete in a modal, removes the row optimistically and restores it on failure', async () => {
    okGet('/', {
      instances: [view({ id: 'ch-1', name: 'main-bot' })],
      bindings: [],
      conversations: [],
      pendingSenders: [],
    })
    okGet('/schema', [TELEGRAM_SCHEMA])
    failPost('/remove', 500, 'internal-error')
    mount()

    expect(await screen.findByText('main-bot')).toBeTruthy()
    const remove = (): HTMLElement => screen.getByLabelText(actionLabel('channels.action.delete', 'main-bot'))

    // declining the confirmation changes nothing
    fireEvent.click(remove())
    const declined = await screen.findByRole('dialog', { name: zh['channels.confirm.delete.title'] })
    expect(within(declined).getByText(fmt(zh['channels.confirm.delete'], { name: 'main-bot' }))).toBeTruthy()
    fireEvent.click(within(declined).getByRole('button', { name: zh['channels.action.cancel'] }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: zh['channels.confirm.delete.title'] })).toBeNull())
    expect(callOf('/remove')).toBeUndefined()
    expect(screen.getByText('main-bot')).toBeTruthy()

    fireEvent.click(remove())
    const confirmed = await screen.findByRole('dialog', { name: zh['channels.confirm.delete.title'] })
    fireEvent.click(within(confirmed).getByRole('button', { name: zh['channels.action.delete'] }))
    // optimistic: the row is gone before the request settles
    expect(screen.queryByText('main-bot')).toBeNull()
    await waitFor(() => expect(callOf('/remove')?.body).toEqual({ id: 'ch-1' }))
    // rolled back on rejection
    expect(await screen.findByText('main-bot')).toBeTruthy()
    expect(screen.getByText(zh['channels.error.internalError'])).toBeTruthy()
  })

  it('deletes from inside the editor only after its own confirmation', async () => {
    okGet('/', {
      instances: [view({ id: 'ch-1', name: 'main-bot' })],
      bindings: [],
      conversations: [],
      pendingSenders: [],
    })
    okGet('/schema', [TELEGRAM_SCHEMA])
    okPost('/remove', { ok: true })
    mount()

    fireEvent.click(await screen.findByLabelText(actionLabel('channels.action.edit', 'main-bot')))
    const title = editTitle('main-bot')
    fireEvent.click(within(dialog(title)).getByRole('button', { name: zh['channels.action.delete'] }))

    const confirm = await screen.findByRole('dialog', { name: zh['channels.confirm.delete.title'] })
    fireEvent.click(within(confirm).getByRole('button', { name: zh['channels.action.delete'] }))

    await waitFor(() => expect(callOf('/remove')?.body).toEqual({ id: 'ch-1' }))
    expect(await screen.findByText(zh['channels.toast.deleted'])).toBeTruthy()
    // the editor closes and the draft scope it owned is gone
    await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).toBeNull())
    expect(sessionStorage.getItem('tentacle:channel-draft:instance:ch-1')).toBeNull()
  })

  it('persists, restores and clears the draft without ever storing the secret', async () => {
    okGet('/', EMPTY_OVERVIEW)
    okGet('/schema', [TELEGRAM_SCHEMA])
    okPost('/create', view({ id: 'ch-new', name: 'draft-bot' }))
    mount()

    const key = 'tentacle:channel-draft:new:telegram'
    await screen.findByText(zh['channels.empty.title'])
    await openCreate()
    fireEvent.change(screen.getByLabelText(zh['channels.form.name']), { target: { value: 'draft-bot' } })
    fireEvent.change(screen.getByLabelText(zh['channels.field.token']), { target: { value: 'super-secret' } })

    await waitFor(() => expect(sessionStorage.getItem(key)).not.toBeNull())
    const stored = sessionStorage.getItem(key) as string
    expect(stored).toContain('draft-bot')
    expect(stored).not.toContain('super-secret')

    // remount: the draft comes back, including the restored hint
    cleanup()
    mount()
    await screen.findByText(zh['channels.empty.title'])
    await openCreate()
    expect((screen.getByLabelText(zh['channels.form.name']) as HTMLInputElement).value).toBe('draft-bot')
    expect(screen.getByText(zh['channels.form.hint.draft'])).toBeTruthy()

    // a successful save clears it (and the token control is fully separate)
    fireEvent.change(screen.getByLabelText('mode'), { target: { value: 'poll' } })
    fireEvent.change(screen.getByLabelText(zh['channels.field.token']), { target: { value: 'tok' } })
    fireEvent.submit(editorForm(CREATE_TITLE))
    expect(await screen.findByText(zh['channels.toast.created'])).toBeTruthy()
    await waitFor(() => expect(sessionStorage.getItem(key)).toBeNull())
  })

  it('never drafts a password-kind config field nor the credential', async () => {
    const schema: ChannelTypeSchema = {
      channelType: 'telegram',
      config: [{ name: 'webhookSecret', kind: 'password', labelKey: 'channels.field.webhookSecret' }],
      credentials: [{ name: 'token', required: true, labelKey: 'channels.field.token' }],
    }
    okGet('/', EMPTY_OVERVIEW)
    okGet('/schema', [schema])
    mount()

    await screen.findByText(zh['channels.empty.title'])
    await openCreate()
    const secretField = screen.getByLabelText('webhookSecret') as HTMLInputElement
    expect(secretField.type).toBe('password')

    fireEvent.change(screen.getByLabelText(zh['channels.form.name']), { target: { value: 'secret-bot' } })
    fireEvent.change(secretField, { target: { value: 'hook-secret' } })
    fireEvent.change(screen.getByLabelText(zh['channels.field.token']), { target: { value: 'bot-secret' } })

    const key = 'tentacle:channel-draft:new:telegram'
    await waitFor(() => expect(sessionStorage.getItem(key)).not.toBeNull())
    const stored = sessionStorage.getItem(key) as string
    expect(stored).toContain('secret-bot')
    expect(stored).not.toContain('hook-secret')
    expect(stored).not.toContain('bot-secret')
  })

  it('keeps a draft on cancel and treats malformed drafts as absent', async () => {
    okGet('/', EMPTY_OVERVIEW)
    okGet('/schema', [TELEGRAM_SCHEMA])
    mount()

    const key = 'tentacle:channel-draft:new:telegram'
    await screen.findByText(zh['channels.empty.title'])
    await openCreate()
    fireEvent.change(screen.getByLabelText(zh['channels.form.name']), { target: { value: 'kept-bot' } })
    await waitFor(() => expect(sessionStorage.getItem(key)).not.toBeNull())

    // cancelling a dirty editor asks first, then keeps the draft
    cancel(CREATE_TITLE)
    const discard = await screen.findByRole('dialog', { name: zh['channels.confirm.discard.title'] })
    fireEvent.click(within(discard).getByRole('button', { name: zh['channels.action.discard'] }))
    await waitFor(() => expect(screen.queryByLabelText(zh['channels.form.name'])).toBeNull())
    expect(sessionStorage.getItem(key)).not.toBeNull()

    sessionStorage.setItem(key, '{not json')
    await openCreate()
    expect((screen.getByLabelText(zh['channels.form.name']) as HTMLInputElement).value).toBe('')
    expect(screen.queryByText(zh['channels.form.hint.draft'])).toBeNull()

    cleanup()
    stubFetch()
    okGet('/', EMPTY_OVERVIEW)
    okGet('/schema', [TELEGRAM_SCHEMA])
    sessionStorage.setItem(key, '"a bare string"')
    mount()
    await screen.findByText(zh['channels.empty.title'])
    await openCreate()
    expect((screen.getByLabelText(zh['channels.form.name']) as HTMLInputElement).value).toBe('')
  })

  it('asks before discarding unsaved changes on cancel or when switching target', async () => {
    okGet('/', {
      instances: [view({ id: 'ch-1', name: 'main-bot' }), view({ id: 'ch-2', name: 'other-bot' })],
      bindings: [],
      conversations: [],
      pendingSenders: [],
    })
    okGet('/schema', [TELEGRAM_SCHEMA])
    mount()

    await screen.findByText('main-bot')
    await openCreate()
    fireEvent.change(screen.getByLabelText(zh['channels.form.name']), { target: { value: 'unsaved-bot' } })

    cancel(CREATE_TITLE)
    const kept = await screen.findByRole('dialog', { name: zh['channels.confirm.discard.title'] })
    fireEvent.click(within(kept).getByRole('button', { name: zh['channels.action.keepEditing'] }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: zh['channels.confirm.discard.title'] })).toBeNull())
    expect(screen.getByLabelText(zh['channels.form.name'])).toBeTruthy()
    expect(screen.getByRole('dialog', { name: CREATE_TITLE })).toBeTruthy()

    fireEvent.click(screen.getByLabelText(actionLabel('channels.action.edit', 'main-bot')))
    const discarded = await screen.findByRole('dialog', { name: zh['channels.confirm.discard.title'] })
    fireEvent.click(within(discarded).getByRole('button', { name: zh['channels.action.discard'] }))

    expect(await screen.findByRole('dialog', { name: editTitle('main-bot') })).toBeTruthy()
    expect((screen.getByLabelText(zh['channels.form.name']) as HTMLInputElement).value).toBe('main-bot')
  })

  it('loads bindable users for the selected instance and binds/unbinds', async () => {
    const now = Date.now()
    okGet('/', {
      instances: [view({ id: 'ch-1', name: 'main-bot' })],
      bindings: [
        { channelId: 'ch-1', channelType: 'telegram', platformId: '111', subjectId: 'did:key:alice', boundAt: now - 30_000, username: 'alice' },
      ],
      conversations: [],
      pendingSenders: [],
    })
    okGet('/schema', [TELEGRAM_SCHEMA])
    okGet('/users?channelId=ch-1', [
      { subjectId: 'did:key:alice', username: 'alice' },
      { subjectId: 'did:key:bob', username: 'bob' },
    ])
    okPost('/bind', { ok: true })
    okPost('/unbind', { ok: true })
    mount()

    expect(await screen.findByText(zh['channels.hint.selectInstance'])).toBeTruthy()
    await selectRow('main-bot')
    await waitFor(() => expect(callOf('/users?channelId=ch-1')).toBeTruthy())

    expect(await screen.findByText('111')).toBeTruthy()
    expect(screen.getByText(fmt(zh['channels.bindings.for'], { name: 'main-bot' }))).toBeTruthy()
    // the binding time is the official relative bucket, not a raw timestamp
    expect(screen.getByText(zh['channels.time.now'])).toBeTruthy()

    const select = screen.getByLabelText(zh['channels.col.user']) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'did:key:bob' } })
    fireEvent.change(screen.getByLabelText(zh['channels.col.platformId']), { target: { value: '222' } })
    fireEvent.submit(select.closest('form') as HTMLFormElement)
    await waitFor(() => {
      expect(callOf('/bind')?.body).toEqual({ channelId: 'ch-1', platformId: '222', subjectId: 'did:key:bob' })
    })
    expect(await screen.findByText(zh['channels.toast.bound'])).toBeTruthy()

    // unbinding confirms in a modal first
    fireEvent.click(screen.getByRole('button', { name: zh['channels.action.unbind'] }))
    const confirm = await screen.findByRole('dialog', { name: zh['channels.confirm.unbind.title'] })
    expect(within(confirm).getByText(zh['channels.confirm.unbind'])).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: zh['channels.action.unbind'] }))
    await waitFor(() => {
      expect(callOf('/unbind')?.body).toEqual({ channelId: 'ch-1', platformId: '111' })
    })
    expect(await screen.findByText(zh['channels.toast.unbound'])).toBeTruthy()
  })


  it('disables the bind submit when the tenant has no bindable user', async () => {
    okGet('/', { instances: [view({ id: 'ch-1', name: 'main-bot' })], bindings: [], conversations: [], pendingSenders: [] })
    okGet('/schema', [TELEGRAM_SCHEMA])
    okGet('/users?channelId=ch-1', [])
    mount()

    await selectRow('main-bot')
    expect(await screen.findByText(zh['channels.bind.noUsers'])).toBeTruthy()
    expect((screen.getByRole('button', { name: zh['channels.action.bind'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('localizes API error codes and shows unknown codes verbatim', async () => {
    okGet('/', EMPTY_OVERVIEW)
    okGet('/schema', [TELEGRAM_SCHEMA])
    failPost('/create', 409, 'name-taken')
    mount()

    await screen.findByText(zh['channels.empty.title'])
    await openCreate()
    fireEvent.change(screen.getByLabelText(zh['channels.form.name']), { target: { value: 'main-bot' } })
    fireEvent.change(screen.getByLabelText('mode'), { target: { value: 'poll' } })
    fireEvent.change(screen.getByLabelText(zh['channels.field.token']), { target: { value: 'tok' } })
    fireEvent.submit(editorForm(CREATE_TITLE))
    expect(await screen.findByText(zh['channels.error.nameTaken'])).toBeTruthy()

    responses.set('POST /create', { status: 409, body: { error: 'weird-code' } })
    fireEvent.submit(editorForm(CREATE_TITLE))
    expect(await screen.findByText('weird-code')).toBeTruthy()
  })

  it('renders readable copy for every error code in the host vocabulary', () => {
    const codes = [
      'name-taken', 'no-such-channel', 'invalid-config', 'invalid-name', 'invalid-tenant',
      'invalid-credential-ref', 'credentials-unavailable', 'forbidden-tenant', 'already-bound',
      'unknown-user', 'channel-tenant-mismatch', 'no-such-binding', 'invalid-channel-type',
      'invalid-binding', 'internal-error',
    ]
    for (const code of codes) {
      const text = errorText(t, new ChannelsApiError(code, 400))
      expect(text).not.toBe(code)
      expect(text.length).toBeGreaterThan(0)
    }
    expect(errorText(t, new ChannelsApiError('mystery', 500))).toBe('mystery')
  })
})
