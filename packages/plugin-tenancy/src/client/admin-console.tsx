/**
 * The unified Tentacle admin console, mounted as a GLOBAL main panel next to
 * 频道/专家 (admin identities only, `sidebar.panellist`) — the reference implementation's /admin
 * area, native to DSH: same shell navigation, same design tokens, no bolt-on
 * look. Five domains: Users / Roles / Invites / Policies / Sessions.
 *
 * Data flows through the same `/tentacle/api/admin/*` REST API the
 * standalone page uses, so both surfaces stay honest mirrors of one truth.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input, Modal, SegmentedControl, SegmentedTabs, Toast, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TentacleLocaleKey } from './locales.ts'

type T = (key: TentacleLocaleKey) => string

// ---- shared bits ----

const colors = {
  text: 'var(--dsw-alias-label-primary, #e7e9ee)',
  secondary: 'var(--dsw-alias-label-secondary, #9aa1ad)',
  border: 'var(--dsw-alias-border-l3, #2c313c)',
  layer1: 'var(--dsw-alias-bg-layer-1, #14161c)',
  hover: 'var(--dsw-alias-interactive-bg-hover, #1c1f27)',
  accent: 'var(--dsw-alias-state-business-primary, #4c7dff)',
  danger: 'var(--dsw-alias-state-error, #ff8489)',
  code: 'var(--ds-font-family-code, ui-monospace, monospace)',
} as const

const styles = {
  tabs: { display: 'flex', gap: 4, marginBottom: 16, borderBottom: `1px solid ${colors.border}`, paddingBottom: 8 } as const,
  tab: (active: boolean) => ({
    padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13,
    background: active ? colors.hover : 'transparent', color: active ? colors.text : colors.secondary,
    fontWeight: active ? 600 : 400,
  }),
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th: { textAlign: 'left' as const, padding: '6px 8px', color: colors.secondary, fontWeight: 500, fontSize: 12, borderBottom: `1px solid ${colors.border}` },
  td: { padding: '7px 8px', borderBottom: `1px solid ${colors.border}`, color: colors.text },
  input: { padding: '6px 9px', borderRadius: 7, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text, fontSize: 13 },
  button: { padding: '6px 12px', borderRadius: 7, border: 'none', background: colors.accent, color: '#fff', fontSize: 13, cursor: 'pointer' },
  ghostButton: { padding: '5px 10px', borderRadius: 7, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.secondary, fontSize: 12, cursor: 'pointer' },
  dangerButton: { padding: '5px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: colors.danger, fontSize: 12, cursor: 'pointer' },
  badge: (tone: 'admin' | 'user' | 'disabled') => ({
    fontSize: 11, padding: '2px 8px', borderRadius: 99,
    background: tone === 'admin' ? colors.accent + '33' : tone === 'disabled' ? colors.danger + '33' : colors.hover,
    color: tone === 'admin' ? colors.accent : tone === 'disabled' ? colors.danger : colors.secondary,
  }),
  row: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' as const, alignItems: 'center' },
  toolbar: { display: 'flex', gap: 8, flexWrap: 'wrap' as const, alignItems: 'center' },
  field: { display: 'grid', gap: 4 },
  label: { fontSize: 12, lineHeight: '18px', color: colors.secondary },
  hint: { fontSize: 12, color: colors.secondary, minHeight: 16, marginTop: 8 },
}

// ---- page shell ----

const pageStyles = {
  page: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 20,
    padding: 24,
    maxWidth: 1120,
    boxSizing: 'border-box' as const,
    width: '100%',
    color: colors.text,
    fontSize: 13,
  },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' as const },
  title: { margin: 0, fontSize: 17, lineHeight: '24px', fontWeight: 600 as const, color: colors.text },
  hint: { margin: '4px 0 0', fontSize: 12, lineHeight: '18px', color: colors.secondary, maxWidth: 640 },
  body: {
    display: 'grid',
    gap: 14,
    minWidth: 0,
    padding: 14,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    background: colors.layer1,
  },
} as const

// ---- API ----

interface Api { call(path: string, body?: unknown): Promise<any> }

function useApi(t: T): Api {
  return {
    async call(path, body) {
      const res = await fetch(`/tentacle/api/admin${path}`, body !== undefined ? {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      } : undefined)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? String(res.status))
      return res.json()
    },
  }
}

function useRefresh(fn: () => Promise<void>, deps: unknown[]): { error: string; reload: () => void } {
  const [error, setError] = useState('')
  const reload = useCallback(() => { fn().catch((e) => setError(String(e.message ?? e))) }, deps) // eslint-disable-line
  useEffect(reload, [reload])
  return { error, reload }
}

// ---- tabs ----

function UsersTab({ t, api, onToast }: { t: T; api: Api; onToast: (m: string) => void }): ReactElement {
  const [users, setUsers] = useState<any[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled' | 'locked'>('all')
  const [creating, setCreating] = useState(false)
  const [resetTarget, setResetTarget] = useState<string | undefined>(undefined)
  const [profileTarget, setProfileTarget] = useState<any | undefined>(undefined)
  /** One pending deletion: a username, or every selected user. */
  const [deleteTarget, setDeleteTarget] = useState<string | 'batch' | undefined>(undefined)
  const { error, reload } = useRefresh(async () => setUsers(await api.call('/users')), [])

  const statusOf = (u: any): 'disabled' | 'locked' | 'active' => {
    if (u.disabled) return 'disabled'
    if (u.loginLockedUntil > Date.now()) return 'locked'
    return 'active'
  }

  const needle = query.trim().toLowerCase()
  const visible = users.filter((u) => {
    const status = statusOf(u)
    if (statusFilter !== 'all' && status !== statusFilter) return false
    if (needle === '') return true
    return [u.username, u.displayName, u.email, u.role]
      .some((part) => typeof part === 'string' && part.toLowerCase().includes(needle))
  })

  const toggle = (username: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(username)) next.delete(username)
      else next.add(username)
      return next
    })
  }

  const toggleAll = (): void => {
    setSelected((prev) => prev.size === visible.length ? new Set() : new Set(visible.map((u) => u.username)))
  }

  const batch = async (action: 'enable' | 'disable' | 'delete'): Promise<void> => {
    if (selected.size === 0) return
    const { results } = await api.call('/users/batch', { usernames: [...selected], action }).catch((e) => {
      onToast(e.message)
      return { results: [] }
    })
    const failed = (results as any[]).filter((r) => !r.ok)
    onToast(failed.length > 0 ? `${t('admin.toast.batchDone')} (${failed.length} failed: ${failed.map((r) => r.username).join(', ')})` : t('admin.toast.batchDone'))
    setSelected(new Set())
    reload()
  }

  const act = async (path: string, body: unknown, toastKey: string): Promise<void> => {
    await api.call(path, body).catch((e: any) => onToast(e.message))
    onToast(t(toastKey as TentacleLocaleKey))
    reload()
  }

  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget
    setDeleteTarget(undefined)
    if (target === undefined) return
    if (target === 'batch') await batch('delete')
    else await act('/users/delete', { username: target }, 'admin.toast.deleted')
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={styles.toolbar}>
        <Input
          aria-label={t('admin.search.placeholder')}
          placeholder={t('admin.search.placeholder')}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setSelected(new Set()) }}
        />
        <SegmentedControl<'all' | 'active' | 'disabled' | 'locked'>
          id="tentacle-admin-user-status"
          value={statusFilter}
          label={t('admin.col.status')}
          options={[
            { value: 'all', label: t('admin.filter.all') },
            { value: 'active', label: t('admin.status.active') },
            { value: 'disabled', label: t('admin.status.disabled') },
            { value: 'locked', label: t('admin.status.locked') },
          ]}
          onChange={(next) => { setStatusFilter(next); setSelected(new Set()) }}
        />
        <span style={{ flex: 1 }} />
        <Button variant="primary" onClick={() => setCreating(true)}>{t('admin.action.createUser')}</Button>
      </div>

      {selected.size > 0 && (
        <div style={{ ...styles.row, marginTop: 0 }}>
          <span style={{ fontSize: 12, color: colors.secondary }}>{selected.size} {t('admin.batch.selected')}</span>
          <button style={styles.ghostButton} onClick={() => void batch('enable')}>{t('admin.batch.enable')}</button>
          <button style={styles.ghostButton} onClick={() => void batch('disable')}>{t('admin.batch.disable')}</button>
          <button style={styles.dangerButton} onClick={() => setDeleteTarget('batch')}>{t('admin.batch.delete')}</button>
        </div>
      )}

      <table style={styles.table}>
        <thead><tr>
          <th style={styles.th}><input type="checkbox" aria-label={t('admin.batch.selected')} checked={visible.length > 0 && selected.size === visible.length} onChange={toggleAll} /></th>
          <th style={styles.th}>{t('admin.col.username')}</th>
          <th style={styles.th}>{t('admin.col.role')}</th>
          <th style={styles.th}>{t('admin.col.status')}</th>
          <th style={{ ...styles.th, textAlign: 'right' }}></th>
        </tr></thead>
        <tbody>
          {visible.map((u) => {
            const status = statusOf(u)
            return (
              <tr key={u.username}>
                <td style={styles.td}><input type="checkbox" checked={selected.has(u.username)} onChange={() => toggle(u.username)} /></td>
                <td style={styles.td}>{u.username}{u.displayName ? <span style={{ color: colors.secondary }}> ({u.displayName})</span> : null}</td>
                <td style={styles.td}><span style={styles.badge(u.role)}>{u.role}</span></td>
                <td style={styles.td}><span style={styles.badge(status === 'active' ? 'user' : 'disabled')}>{t(`admin.status.${status}` as TentacleLocaleKey)}</span></td>
                <td style={{ ...styles.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {status === 'disabled' && <>
                    <button style={styles.ghostButton} onClick={() => void act('/users/enable', { username: u.username }, 'admin.toast.enabled')}>{t('admin.action.enable')}</button>{' '}
                    <button style={styles.dangerButton} onClick={() => setDeleteTarget(u.username)}>{t('admin.action.delete')}</button>{' '}
                  </>}
                  {status === 'locked' && <>
                    <button style={styles.ghostButton} onClick={() => void act('/users/unlock-login', { username: u.username }, 'admin.toast.unlocked')}>{t('admin.action.unlock')}</button>{' '}
                  </>}
                  {status !== 'disabled' && <>
                    <button style={styles.dangerButton} onClick={() => void act('/users/disable', { username: u.username }, 'admin.toast.deleted')}>{t('admin.action.disable')}</button>{' '}
                  </>}
                  <button style={styles.ghostButton} onClick={() => setResetTarget(u.username)}>{t('admin.action.resetPassword')}</button>{' '}
                  <button style={styles.ghostButton} onClick={() => setProfileTarget(u)}>{t('admin.action.editProfile')}</button>
                </td>
              </tr>
            )
          })}
          {visible.length === 0 && (
            <tr><td style={{ ...styles.td, color: colors.secondary }} colSpan={5}>{t('admin.users.empty')}</td></tr>
          )}
        </tbody>
      </table>
      <p style={styles.hint}>{error}</p>

      {creating && (
        <Modal open onClose={() => setCreating(false)} title={t('admin.modal.createUser')} closeLabel={t('admin.action.cancel')}
          footer={<div style={{ display: 'flex', gap: 8, width: '100%' }}><span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setCreating(false)}>{t('admin.action.cancel')}</Button>
            <Button type="submit" form="tentacle-admin-create-user" variant="primary">{t('admin.action.createUser')}</Button>
          </div>}>
          <form id="tentacle-admin-create-user" style={{ display: 'grid', gap: 10 }} onSubmit={async (e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            try {
              await api.call('/users', { username: f.get('username'), password: f.get('password'), role: f.get('role') })
              setCreating(false); onToast(t('admin.toast.userCreated')); reload()
            } catch (err: any) { onToast(err.message) }
          }}>
            <label style={styles.field}><span style={styles.label}>{t('admin.col.username')}</span>
              <Input name="username" aria-label={t('admin.col.username')} required autoFocus />
            </label>
            <label style={styles.field}><span style={styles.label}>{t('admin.col.password')}</span>
              <Input name="password" type="password" aria-label={t('admin.col.password')} minLength={8} required />
            </label>
            <label style={styles.field}><span style={styles.label}>{t('admin.col.role')}</span>
              <select name="role" aria-label={t('admin.col.role')} style={styles.input} defaultValue="user">
                <option value="user">user</option><option value="admin">admin</option>
              </select>
            </label>
          </form>
        </Modal>
      )}

      {resetTarget !== undefined && (
        <Modal open onClose={() => setResetTarget(undefined)} title={t('admin.modal.resetPassword')} description={resetTarget} closeLabel={t('admin.action.cancel')}
          footer={<div style={{ display: 'flex', gap: 8, width: '100%' }}><span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setResetTarget(undefined)}>{t('admin.action.cancel')}</Button>
            <Button type="submit" form="tentacle-admin-reset-password" variant="primary">{t('admin.action.resetPassword')}</Button>
          </div>}>
          <form id="tentacle-admin-reset-password" style={{ display: 'grid', gap: 10 }} onSubmit={async (e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            const password = String(f.get('password') ?? '')
            if (password.length < 8) { onToast(t('admin.col.password')); return }
            await act('/users/reset-password', { username: resetTarget, password }, 'admin.toast.passwordReset')
            setResetTarget(undefined)
          }}>
            <label style={styles.field}><span style={styles.label}>{t('admin.prompt.newPassword')}</span>
              <Input name="password" type="password" aria-label={t('admin.prompt.newPassword')} minLength={8} required autoFocus />
            </label>
          </form>
        </Modal>
      )}

      {profileTarget !== undefined && (
        <Modal open onClose={() => setProfileTarget(undefined)} title={t('admin.modal.editProfile')} description={profileTarget.username} closeLabel={t('admin.action.cancel')}
          footer={<div style={{ display: 'flex', gap: 8, width: '100%' }}><span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setProfileTarget(undefined)}>{t('admin.action.cancel')}</Button>
            <Button type="submit" form="tentacle-admin-edit-profile" variant="primary">{t('admin.action.save')}</Button>
          </div>}>
          <form id="tentacle-admin-edit-profile" style={{ display: 'grid', gap: 10 }} onSubmit={async (e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            await act('/users/update-profile', { username: profileTarget.username, displayName: f.get('displayName'), email: f.get('email') }, 'admin.toast.profileSaved')
            setProfileTarget(undefined)
          }}>
            <label style={styles.field}><span style={styles.label}>{t('admin.form.displayName')}</span>
              <Input name="displayName" aria-label={t('admin.form.displayName')} defaultValue={profileTarget.displayName ?? ''} autoFocus />
            </label>
            <label style={styles.field}><span style={styles.label}>{t('admin.form.email')}</span>
              <Input name="email" type="email" aria-label={t('admin.form.email')} defaultValue={profileTarget.email ?? ''} />
            </label>
          </form>
        </Modal>
      )}

      {deleteTarget !== undefined && (
        <Modal open onClose={() => setDeleteTarget(undefined)} title={t('admin.delete.title')} closeLabel={t('admin.action.cancel')}
          description={deleteTarget === 'batch' ? t('admin.confirm.deleteBatch') : t('admin.confirm.delete')}
          footer={<div style={{ display: 'flex', gap: 8, width: '100%' }}><span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setDeleteTarget(undefined)}>{t('admin.action.cancel')}</Button>
            <Button variant="primary" style={{ background: colors.danger }} onClick={() => void confirmDelete()}>{t('admin.action.delete')}</Button>
          </div>}>
          <p style={styles.hint}>{deleteTarget === 'batch' ? `${selected.size} ${t('admin.batch.selected')}` : deleteTarget}</p>
        </Modal>
      )}
    </div>
  )
}

function InvitesTab({ t, api, onToast }: { t: T; api: Api; onToast: (m: string) => void }): ReactElement {
  const [invites, setInvites] = useState<any[]>([])
  const { error, reload } = useRefresh(async () => setInvites(await api.call('/invites')), [])
  return (
    <div>
      <table style={styles.table}>
        <thead><tr><th style={styles.th}>{t('admin.col.code')}</th><th style={styles.th}>{t('admin.col.role')}</th><th style={styles.th}>{t('admin.col.expires')}</th><th style={styles.th}>{t('admin.col.status')}</th></tr></thead>
        <tbody>
          {invites.map((i) => (
            <tr key={i.fingerprint}>
              <td style={{ ...styles.td, fontFamily: colors.code }}>{i.fingerprint.slice(0, 12)}…</td>
              <td style={styles.td}>{i.role}</td>
              <td style={styles.td}>{new Date(i.expiresAt).toLocaleString()}</td>
              <td style={styles.td}>{i.redeemedBy ? `${t('admin.status.redeemed')} ${i.redeemedBy}` : i.expiresAt < Date.now() ? t('admin.status.expired') : t('admin.status.open')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form style={styles.row} onSubmit={async (e) => {
        e.preventDefault()
        const f = new FormData(e.currentTarget)
        try {
          const inv = await api.call('/invites', { role: f.get('role') })
          const url = `${location.origin}/?invite=${inv.code}`
          await navigator.clipboard.writeText(url).catch(() => {})
          onToast(`${t('admin.toast.inviteCopied')} ${url}`); reload()
        } catch (err: any) { onToast(err.message) }
      }}>
        <select name="role" style={styles.input}><option value="user">user</option><option value="admin">admin</option></select>
        <button type="submit" style={styles.button}>{t('admin.action.createInvite')}</button>
      </form>
      <p style={styles.hint}>{error}</p>
    </div>
  )
}

function PoliciesTab({ t, api, onToast }: { t: T; api: Api; onToast: (m: string) => void }): ReactElement {
  const [users, setUsers] = useState<any[]>([])
  const [selected, setSelected] = useState('')
  const [policies, setPolicies] = useState<any[]>([])
  useRefresh(async () => setUsers(await api.call('/users')), [])
  const loadPolicies = useCallback(async (subjectId: string) => {
    if (!subjectId) { setPolicies([]); return }
    setPolicies(await api.call(`/policies?subjectId=${encodeURIComponent(subjectId)}`).catch(() => []))
  }, [api])
  useEffect(() => { void loadPolicies(selected) }, [selected, loadPolicies])
  const POLICY_NAMES = ['workspace_root_dir', 'token_quota', 'max_agents'] as const
  return (
    <div>
      <div style={styles.row}>
        <label style={{ fontSize: 13, color: colors.secondary }}>{t('admin.col.username')}</label>
        <select value={selected} onChange={(e) => setSelected(e.target.value)} style={styles.input}>
          <option value="">—</option>
          {users.map((u) => <option key={u.subjectId} value={u.subjectId}>{u.username}</option>)}
        </select>
      </div>
      {selected && (
        <table style={{ ...styles.table, marginTop: 12 }}>
          <thead><tr><th style={styles.th}>{t('admin.col.policy')}</th><th style={styles.th}>{t('admin.col.value')}</th><th style={styles.th}></th></tr></thead>
          <tbody>
            {POLICY_NAMES.map((name) => {
              const current = policies.find((p) => p.name === name)?.value ?? ''
              return (
                <tr key={name}>
                  <td style={{ ...styles.td, fontFamily: colors.code }}>{name}</td>
                  <td style={styles.td}>{current || <span style={{ color: colors.secondary }}>{t('admin.policy.unset')}</span>}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>
                    <button style={styles.ghostButton} onClick={async () => {
                      const value = window.prompt(`${name}`, current)
                      if (value === null) return
                      await api.call('/policies', { subjectId: selected, name, value: value || undefined }).catch((e) => onToast(e.message))
                      onToast(t('admin.toast.policySaved')); void loadPolicies(selected)
                    }}>{t('admin.action.edit')}</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p style={styles.hint}>{t('admin.policy.hint')}</p>
    </div>
  )
}

function SessionsTab({ t, api }: { t: T; api: Api }): ReactElement {
  const [sessions, setSessions] = useState<any[]>([])
  const { error } = useRefresh(async () => setSessions(await api.call('/sessions')), [])
  return (
    <div>
      <table style={styles.table}>
        <thead><tr><th style={styles.th}>{t('admin.col.user')}</th><th style={styles.th}>{t('admin.col.role')}</th><th style={styles.th}>{t('admin.col.created')}</th><th style={styles.th}>{t('admin.col.expires')}</th></tr></thead>
        <tbody>
          {sessions.map((s, i) => (
            <tr key={i}>
              <td style={styles.td}>{s.handle ?? '—'}</td>
              <td style={styles.td}>{(s.roles ?? []).map((r: string) => <span key={r} style={{ ...styles.badge(r === 'admin' ? 'admin' : 'user'), marginRight: 4 }}>{r}</span>)}</td>
              <td style={styles.td}>{new Date(s.createdAt).toLocaleString()}</td>
              <td style={styles.td}>{new Date(s.expiresAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={styles.hint}>{error || t('admin.sessions.hint')}</p>
    </div>
  )
}

// ---- console root ----

const TABS = ['users', 'roles', 'invites', 'policies', 'sessions'] as const
type AdminTab = (typeof TABS)[number]

/** Official tab list: non-empty tuple shape required by `SegmentedTabs`. */
function TAB_ITEMS(t: T): readonly [SegmentedTab<AdminTab>, ...SegmentedTab<AdminTab>[]] {
  return TABS.map((key) => ({
    value: key,
    label: t(`admin.tab.${key}` as TentacleLocaleKey),
    id: `tentacle-admin-tab-${key}`,
    panelId: `tentacle-admin-panel-${key}`,
  })) as unknown as readonly [SegmentedTab<AdminTab>, ...SegmentedTab<AdminTab>[]]
}

function RolesTab({ t, api, onToast }: { t: T; api: Api; onToast: (m: string) => void }): ReactElement {
  const [roles, setRoles] = useState<any[]>([])
  const [catalog, setCatalog] = useState<any[]>([])
  const [users, setUsers] = useState<any[]>([])
  const { error, reload } = useRefresh(async () => {
    const [r, c] = await Promise.all([api.call('/roles'), api.call('/permissions')])
    setRoles(r)
    setCatalog(c)
    setUsers(await api.call('/users').catch(() => []))
  }, [])

  const emptyDraft = { id: '', zh: '', en: '', permissionKeys: [] as string[] }
  const [draft, setDraft] = useState(emptyDraft)
  const [editing, setEditing] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const body = {
      id: draft.id,
      name: { zh: draft.zh, en: draft.en },
      permissionKeys: draft.permissionKeys,
    }
    const path = editing ? '/roles/update' : '/roles'
    await api.call(path, editing ? { ...body, id: editing } : body)
      .catch((e) => onToast(e.message))
    onToast(t('admin.toast.roleSaved'))
    setDraft(emptyDraft)
    setEditing(null)
    reload()
  }

  const toggleKey = (key: string): void => {
    setDraft((d) => ({
      ...d,
      permissionKeys: d.permissionKeys.includes(key)
        ? d.permissionKeys.filter((k) => k !== key)
        : [...d.permissionKeys, key],
    }))
  }

  return (
    <div>
      <table style={styles.table}>
        <thead><tr><th style={styles.th}>{t('admin.col.role')}</th><th style={styles.th}>{t('admin.col.permissions')}</th><th style={{ ...styles.th, textAlign: 'right' }}></th></tr></thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id}>
              <td style={styles.td}>
                <span style={styles.badge(r.builtin ? 'admin' : 'user')}>{r.name?.zh} / {r.name?.en}</span>
                <span style={{ color: colors.secondary, marginLeft: 6, fontFamily: colors.code }}>{r.id}</span>
              </td>
              <td style={styles.td}>
                {r.id === 'admin'
                  ? <em style={{ color: colors.secondary }}>{t('admin.role.bypass')}</em>
                  : (r.permissionKeys.length > 0
                    ? r.permissionKeys.map((k: string) => <span key={k} style={{ ...styles.badge('user'), marginRight: 4 }}>{k}</span>)
                    : <span style={{ color: colors.secondary }}>{t('admin.role.none')}</span>)}
              </td>
              <td style={{ ...styles.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                {!r.builtin && <>
                  <button style={styles.ghostButton} onClick={() => {
                    setEditing(r.id)
                    setDraft({ id: r.id, zh: r.name?.zh ?? '', en: r.name?.en ?? '', permissionKeys: [...(r.permissionKeys ?? [])] })
                  }}>{t('admin.action.edit')}</button>{' '}
                  <button style={styles.dangerButton} onClick={async () => {
                    await api.call('/roles/delete', { id: r.id }).catch((e) => onToast(e.message))
                    onToast(t('admin.toast.roleSaved')); reload()
                  }}>{t('admin.action.delete')}</button>
                </>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 style={{ margin: '18px 0 6px', fontSize: 13, color: colors.secondary }}>{editing ? t('admin.role.edit') : t('admin.role.create')}</h4>
      <div style={styles.row}>
        <input value={draft.zh} onChange={(e) => setDraft({ ...draft, zh: e.target.value })} placeholder={t('admin.role.nameZh')} style={styles.input} />
        <input value={draft.en} onChange={(e) => setDraft({ ...draft, en: e.target.value })} placeholder={t('admin.role.nameEn')} style={styles.input} />
        {!editing && <input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} placeholder={t('admin.role.id')} style={styles.input} />}
        <button style={styles.button} onClick={() => void submit()} disabled={!draft.zh || !draft.en || (!editing && !draft.id)}>{t('admin.action.save')}</button>
        {editing && <button style={styles.ghostButton} onClick={() => { setEditing(null); setDraft(emptyDraft) }}>{t('admin.action.cancel')}</button>}
      </div>
      <div style={{ ...styles.row, gap: 12 }}>
        {catalog.map((p) => (
          <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: colors.secondary }}>
            <input type="checkbox" checked={draft.permissionKeys.includes(p.key)} onChange={() => toggleKey(p.key)} />
            {p.key} <span style={{ opacity: 0.7 }}>({p.category === 'admin' ? p.labelZh : p.labelZh})</span>
          </label>
        ))}
      </div>

      <h4 style={{ margin: '18px 0 6px', fontSize: 13, color: colors.secondary }}>{t('admin.role.assign')}</h4>
      <div style={styles.row}>
        <select id="assign-user" style={styles.input}>
          {users.map((u) => <option key={u.username} value={u.username}>{u.username}</option>)}
        </select>
        <select id="assign-role" style={styles.input}>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name?.zh} / {r.name?.en}</option>)}
        </select>
        <button style={styles.ghostButton} onClick={async () => {
          const username = (document.getElementById('assign-user') as HTMLSelectElement)?.value
          const roleId = (document.getElementById('assign-role') as HTMLSelectElement)?.value
          if (!username || !roleId) return
          await api.call('/roles/assign', { username, roleId }).catch((e) => onToast(e.message))
          onToast(t('admin.toast.roleSaved')); reload()
        }}>{t('admin.action.assign')}</button>
      </div>
      <p style={styles.hint}>{error}</p>
    </div>
  )
}

export function AdminConsoleView({ t }: { t: T }): ReactElement {
  const api = useApi(t)
  const [tab, setTab] = useState<AdminTab>('users')
  const [toast, setToast] = useState<{ text: string; seq: number } | undefined>(undefined)
  const onToast = useCallback((text: string) => {
    setToast((current) => ({ text, seq: (current?.seq ?? 0) + 1 }))
  }, [])
  return (
    <div style={pageStyles.page}>
      <header style={pageStyles.header}>
        <div style={{ minWidth: 0 }}>
          <h2 style={pageStyles.title}>{t('admin.console')}</h2>
          <p style={pageStyles.hint}>{t('admin.panel.hint')}</p>
        </div>
      </header>
      <SegmentedTabs<AdminTab>
        label={t('admin.console')}
        value={tab}
        onChange={setTab}
        items={TAB_ITEMS(t)}
      />
      <div style={pageStyles.body}>
        {tab === 'users' && <UsersTab t={t} api={api} onToast={onToast} />}
        {tab === 'roles' && <RolesTab t={t} api={api} onToast={onToast} />}
        {tab === 'invites' && <InvitesTab t={t} api={api} onToast={onToast} />}
        {tab === 'policies' && <PoliciesTab t={t} api={api} onToast={onToast} />}
        {tab === 'sessions' && <SessionsTab t={t} api={api} />}
      </div>
      {toast !== undefined && (
        <Toast key={toast.seq} text={toast.text} onDone={() => setToast(undefined)} />
      )}
    </div>
  )
}
