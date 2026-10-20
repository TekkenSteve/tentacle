/**
 * Admin console page (`/tentacle/admin`) — the standalone, no-client-runtime
 * surface (headless environments, API-only workflows). Same data
 * (`/tentacle/api/admin/*`), same tab structure and DSH design tokens as the
 * Settings-embedded console (src/client/admin-console.tsx), so the two
 * surfaces read as one product.
 */
import type { GatewayRoute } from '@tentacle/gateway'

export const ADMIN_PAGE_PREFIX = '/tentacle/admin'

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Tentacle — Admin</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif;
         background: var(--dsw-alias-bg-base, #0f1115); color: var(--dsw-alias-label-primary, #e7e9ee); font-size: 14px; }
  header { padding: 14px 24px; border-bottom: 1px solid var(--dsw-alias-border-l3, #2c313c); display: flex; align-items: baseline; gap: 12px; }
  header h1 { font-size: 17px; margin: 0; font-weight: 600; }
  header a { color: var(--dsw-alias-label-secondary, #9aa1ad); font-size: 13px; text-decoration: none; }
  main { max-width: 880px; margin: 0 auto; padding: 24px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--dsw-alias-border-l3, #2c313c); padding-bottom: 8px; }
  .tabs button { padding: 6px 12px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px;
                 background: transparent; color: var(--dsw-alias-label-secondary, #9aa1ad); }
  .tabs button[aria-selected="true"] { background: var(--dsw-alias-interactive-bg-hover, #1c1f27);
                                       color: var(--dsw-alias-label-primary, #e7e9ee); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--dsw-alias-border-l3, #2c313c); }
  th { color: var(--dsw-alias-label-secondary, #9aa1ad); font-weight: 500; font-size: 12px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: var(--dsw-alias-interactive-bg-hover, #1c1f27); color: var(--dsw-alias-label-secondary, #9aa1ad); }
  .badge.admin { background: #4c7dff33; color: #8cabff; }
  .badge.disabled { background: #ff848933; color: #ff8489; }
  button.primary { padding: 6px 12px; border: 0; border-radius: 7px; background: var(--dsw-alias-state-business-primary, #4c7dff); color: #fff; font-size: 13px; cursor: pointer; }
  button.ghost { padding: 5px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l3, #2c313c); background: transparent; color: var(--dsw-alias-label-secondary, #9aa1ad); font-size: 12px; cursor: pointer; }
  button.danger { padding: 5px 10px; border-radius: 7px; border: none; background: transparent; color: #ff8489; font-size: 12px; cursor: pointer; }
  input, select { padding: 6px 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l3, #2c313c); background: transparent; color: inherit; font-size: 13px; }
  form.inline { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
  .hint { color: var(--dsw-alias-label-secondary, #9aa1ad); font-size: 12px; min-height: 16px; margin-top: 8px; }
  .code { font-family: var(--ds-font-family-code, ui-monospace, monospace); }
  #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
           background: var(--dsw-alias-interactive-bg-hover, #1c1f27); border: 1px solid var(--dsw-alias-border-l3, #2c313c);
           padding: 10px 16px; border-radius: 8px; font-size: 13px; display: none; }
</style>
</head>
<body>
<header><h1>Tentacle Admin</h1><a href="/">← back to app</a><span style="flex:1"></span><span id="who" class="hint"></span><button class="ghost" id="logout">Sign out</button></header>
<main>
  <div class="tabs" role="tablist">
    <button data-tab="users" role="tab">Users</button>
    <button data-tab="invites" role="tab">Invites</button>
    <button data-tab="roles" role="tab">Roles</button>
    <button data-tab="policies" role="tab">Policies</button>
    <button data-tab="sessions" role="tab">Sessions</button>
  </div>
  <section id="tab-users">
    <div id="users-batch" class="inline" hidden>
      <span class="hint" id="users-batch-count"></span>
      <button class="ghost" id="batch-enable">Enable all</button>
      <button class="ghost" id="batch-disable">Disable all</button>
      <button class="danger" id="batch-delete">Delete all</button>
    </div>
    <table id="users"><thead><tr><th></th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody></tbody></table>
    <form class="inline" id="create-user">
      <input name="username" placeholder="username" required>
      <input name="password" type="password" placeholder="password (min 8)" minlength="8" required>
      <select name="role"><option value="user">user</option><option value="admin">admin</option></select>
      <button type="submit" class="primary">Create user</button>
    </form>
  </section>
  <section id="tab-invites" hidden>
    <table id="invites"><thead><tr><th>Code</th><th>Role</th><th>Expires</th><th>Status</th></tr></thead><tbody></tbody></table>
    <form class="inline" id="create-invite">
      <select name="role"><option value="user">user</option><option value="admin">admin</option></select>
      <button type="submit" class="primary">New invite</button>
    </form>
  </section>
  <section id="tab-roles" hidden>
    <table id="roles"><thead><tr><th>Role</th><th>Permissions</th><th></th></tr></thead><tbody></tbody></table>
    <form class="inline" id="role-form">
      <input name="zh" placeholder="中文名" required>
      <input name="en" placeholder="English name" required>
      <input name="id" placeholder="role-id" pattern="[a-z0-9][a-z0-9-]*" required>
      <button type="submit" class="primary">Create role</button>
    </form>
    <div class="inline" id="role-perms"></div>
    <form class="inline">
      <label class="hint">Assign</label>
      <select id="assign-user"></select>
      <select id="assign-role"></select>
      <button type="button" class="ghost" id="assign-btn">Assign role</button>
    </form>
    <p class="hint">Builtin roles cannot be edited or deleted; the admin role bypasses every permission check.</p>
  </section>
  <section id="tab-policies" hidden>
    <form class="inline"><label class="hint">User</label><select id="policy-user"></select></form>
    <table id="policies" style="margin-top:12px"><thead><tr><th>Policy</th><th>Value</th><th></th></tr></thead><tbody></tbody></table>
    <p class="hint">workspace_root_dir fences the user's session cwd; token_quota (lifetime tokens) and max_agents (live agents) are enforced at the gateway.</p>
    <p class="hint" id="policies-usage"></p>
  </section>
  <section id="tab-sessions" hidden>
    <table id="sessions"><thead><tr><th>User</th><th>Roles</th><th>Created</th><th>Expires</th></tr></thead><tbody></tbody></table>
    <p class="hint">Live sessions currently authenticated through the Tentacle gateway.</p>
  </section>
  <p class="hint" id="hint"></p>
</main>
<div id="toast"></div>
<script>
const api = '/tentacle/api/admin'
const hint = document.getElementById('hint')
const toast = (m) => { const t = document.getElementById('toast'); t.textContent = m; t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 2600) }
async function call(path, body) {
  const res = await fetch(api + path, body !== undefined ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status)
  return res.json()
}
const tabs = document.querySelectorAll('.tabs button')
tabs.forEach((b) => b.addEventListener('click', () => {
  tabs.forEach((x) => x.setAttribute('aria-selected', String(x === b)))
  document.querySelectorAll('main section').forEach((s) => { s.hidden = s.id !== 'tab-' + b.dataset.tab })
  if (b.dataset.tab === 'sessions') loadSessions()
  if (b.dataset.tab === 'policies') loadPolicyUsers()
  if (b.dataset.tab === 'roles') loadRoles()
}))
tabs[0].setAttribute('aria-selected', 'true')
const selectedUsers = new Set()
function syncBatchBar() {
  const bar = document.getElementById('users-batch')
  bar.hidden = selectedUsers.size === 0
  document.getElementById('users-batch-count').textContent = selectedUsers.size + ' selected'
}
async function batchAction(action) {
  if (selectedUsers.size === 0) return
  if (action === 'delete' && !confirm('Delete the selected users? Sessions are revoked immediately.')) return
  const out = await call('/users/batch', { usernames: [...selectedUsers], action }).catch((e) => { toast(e.message); return { results: [] } })
  const failed = (out.results || []).filter((r) => !r.ok)
  toast(failed.length ? 'batch done (' + failed.length + ' failed: ' + failed.map((r) => r.username).join(', ') + ')' : 'batch done')
  selectedUsers.clear(); syncBatchBar(); loadUsers()
}
document.getElementById('batch-enable').onclick = () => batchAction('enable')
document.getElementById('batch-disable').onclick = () => batchAction('disable')
document.getElementById('batch-delete').onclick = () => batchAction('delete')

async function loadUsers() {
  const users = await call('/users')
  const tbody = document.querySelector('#users tbody')
  tbody.innerHTML = ''
  for (const u of users) {
    const locked = u.loginLockedUntil > Date.now() && !u.disabled
    const status = u.disabled ? 'disabled' : locked ? 'locked' : 'active'
    const tr = document.createElement('tr')
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td style="text-align:right;white-space:nowrap"></td>'
    const cb = document.createElement('input')
    cb.type = 'checkbox'; cb.checked = selectedUsers.has(u.username)
    cb.onchange = () => { cb.checked ? selectedUsers.add(u.username) : selectedUsers.delete(u.username); syncBatchBar() }
    tr.cells[0].appendChild(cb)
    tr.cells[1].textContent = u.username + (u.displayName ? ' (' + u.displayName + ')' : '')
    tr.cells[2].innerHTML = '<span class="badge ' + u.role + '">' + u.role + '</span>'
    tr.cells[3].innerHTML = '<span class="badge' + (status === 'active' ? '' : ' disabled') + '">' + status + '</span>'
    const actions = tr.cells[4]
    const add = (label, cls, fn) => {
      const b = document.createElement('button')
      b.className = cls; b.textContent = label; b.onclick = fn
      actions.appendChild(b); actions.appendChild(document.createTextNode(' '))
    }
    if (status === 'disabled') {
      add('Enable', 'ghost', async () => { await call('/users/enable', { username: u.username }).catch((e) => toast(e.message)); toast('enabled'); loadUsers() })
      add('Delete', 'danger', async () => {
        if (!confirm('Delete ' + u.username + '? Sessions are revoked immediately.')) return
        await call('/users/delete', { username: u.username }).catch((e) => toast(e.message)); toast('deleted'); loadUsers()
      })
    } else {
      if (status === 'locked') {
        add('Unlock login', 'ghost', async () => { await call('/users/unlock-login', { username: u.username }).catch((e) => toast(e.message)); toast('unlocked'); loadUsers() })
      }
      add('Disable', 'danger', async () => { await call('/users/disable', { username: u.username }).catch((e) => toast(e.message)); toast('disabled'); loadUsers() })
    }
    add('Reset password', 'ghost', async () => {
      const password = prompt('New password (min 8 chars)')
      if (!password) return
      await call('/users/reset-password', { username: u.username, password }).catch((e) => toast(e.message))
      toast('password reset')
    })
    add('Edit profile', 'ghost', async () => {
      const displayName = prompt('Display name (empty to clear)', u.displayName || '')
      if (displayName === null) return
      const email = prompt('Email (empty to clear)', u.email || '')
      if (email === null) return
      await call('/users/update-profile', { username: u.username, displayName, email }).catch((e) => toast(e.message))
      toast('profile saved'); loadUsers()
    })
    tbody.appendChild(tr)
  }
  return users
}
document.getElementById('create-user').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = new FormData(e.target)
  try {
    await call('/users', { username: f.get('username'), password: f.get('password'), role: f.get('role') })
    e.target.reset(); toast('user created'); loadUsers()
  } catch (err) { hint.textContent = err.message }
})
async function loadInvites() {
  const invites = await call('/invites')
  const tbody = document.querySelector('#invites tbody')
  tbody.innerHTML = ''
  for (const i of invites) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td class="code"></td><td></td><td></td><td></td>'
    tr.cells[0].textContent = i.fingerprint.slice(0, 12) + '…'
    tr.cells[1].textContent = i.role
    tr.cells[2].textContent = new Date(i.expiresAt).toLocaleString()
    tr.cells[3].textContent = i.redeemedBy ? 'redeemed by ' + i.redeemedBy : (i.expiresAt < Date.now() ? 'expired' : 'open')
    tbody.appendChild(tr)
  }
}
document.getElementById('create-invite').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = new FormData(e.target)
  try {
    const inv = await call('/invites', { role: f.get('role') })
    const url = location.origin + '/?invite=' + inv.code
    await navigator.clipboard.writeText(url).catch(() => {})
    toast('invite link copied: ' + url); loadInvites()
  } catch (err) { hint.textContent = err.message }
})
const POLICY_NAMES = ['workspace_root_dir', 'token_quota', 'max_agents']
async function loadPolicyUsers() {
  const users = await call('/users')
  const sel = document.getElementById('policy-user')
  sel.innerHTML = '<option value="">—</option>' + users.map((u) => '<option value="' + u.subjectId + '">' + u.username + '</option>').join('')
  sel.onchange = () => loadPolicies(sel.value)
  if (sel.value) loadPolicies(sel.value)
}
async function loadPolicies(subjectId) {
  const policies = subjectId ? await call('/policies?subjectId=' + encodeURIComponent(subjectId)).catch(() => []) : []
  const usage = subjectId ? await call('/quota?subjectId=' + encodeURIComponent(subjectId)).catch(() => undefined) : undefined
  const usageLine = document.getElementById('policies-usage')
  if (usageLine) {
    usageLine.textContent = usage === undefined
      ? ''
      : 'tokens used: ' + usage.total + (usage.quota === undefined ? ' (no quota)' : ' / ' + usage.quota)
        + ' · live agents: ' + usage.active + (usage.maxAgents === undefined ? ' (no limit)' : ' / ' + usage.maxAgents)
  }
  const tbody = document.querySelector('#policies tbody')
  tbody.innerHTML = ''
  for (const name of POLICY_NAMES) {
    const current = (policies.find((p) => p.name === name) || {}).value || ''
    const tr = document.createElement('tr')
    tr.innerHTML = '<td class="code"></td><td></td><td style="text-align:right"></td>'
    tr.cells[0].textContent = name
    tr.cells[1].textContent = current || 'unset'
    const b = document.createElement('button')
    b.className = 'ghost'; b.textContent = 'Edit'
    b.onclick = async () => {
      const value = prompt(name, current)
      if (value === null) return
      await call('/policies', { subjectId, name, value: value || undefined }).catch((e) => toast(e.message))
      toast('policy saved'); loadPolicies(subjectId)
    }
    tr.cells[2].appendChild(b)
    tbody.appendChild(tr)
  }
}
let permissionCatalog = []
async function loadRoles() {
  const [roles, catalog, users] = await Promise.all([
    call('/roles'), call('/permissions'), call('/users').catch(() => []),
  ])
  permissionCatalog = catalog
  const tbody = document.querySelector('#roles tbody')
  tbody.innerHTML = ''
  for (const r of roles) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td></td><td></td><td style="text-align:right"></td>'
    tr.cells[0].innerHTML = '<span class="badge ' + (r.builtin ? 'admin' : '') + '">' + r.name.zh + ' / ' + r.name.en + '</span> <span class="code">' + r.id + '</span>'
    tr.cells[1].innerHTML = r.id === 'admin'
      ? '<em>everything (bypass)</em>'
      : (r.permissionKeys.length ? r.permissionKeys.map((k) => '<span class="badge">' + k + '</span>').join(' ') : '<em>no management permission</em>')
    if (!r.builtin) {
      const b = document.createElement('button')
      b.className = 'danger'; b.textContent = 'Delete'
      b.onclick = async () => {
        await call('/roles/delete', { id: r.id }).catch((e) => toast(e.message))
        toast('role deleted'); loadRoles()
      }
      tr.cells[2].appendChild(b)
    }
    tbody.appendChild(tr)
  }
  const permBox = document.getElementById('role-perms')
  permBox.innerHTML = ''
  for (const p of catalog) {
    const label = document.createElement('label')
    label.className = 'hint'
    label.innerHTML = '<input type="checkbox" value="' + p.key + '"> ' + p.key + ' — ' + p.labelEn
    permBox.appendChild(label)
  }
  const userSel = document.getElementById('assign-user')
  userSel.innerHTML = users.map((u) => '<option value="' + u.username + '">' + u.username + '</option>').join('')
  const roleSel = document.getElementById('assign-role')
  roleSel.innerHTML = roles.map((r) => '<option value="' + r.id + '">' + r.name.en + '</option>').join('')
}
document.getElementById('role-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = new FormData(e.target)
  const permissionKeys = [...document.querySelectorAll('#role-perms input:checked')].map((c) => c.value)
  try {
    await call('/roles', {
      id: f.get('id'), name: { zh: f.get('zh'), en: f.get('en') }, permissionKeys,
    })
    e.target.reset(); toast('role created'); loadRoles()
  } catch (err) { hint.textContent = err.message }
})
document.getElementById('assign-btn').onclick = async () => {
  const username = document.getElementById('assign-user').value
  const roleId = document.getElementById('assign-role').value
  if (!username || !roleId) return
  await call('/roles/assign', { username, roleId }).catch((e) => toast(e.message))
  toast('role assigned ' + username + ' → ' + roleId)
}
async function loadSessions() {
  const sessions = await call('/sessions')
  const tbody = document.querySelector('#sessions tbody')
  tbody.innerHTML = ''
  for (const s of sessions) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td></td><td></td><td></td><td></td>'
    tr.cells[0].textContent = s.handle || '—'
    tr.cells[1].innerHTML = (s.roles || []).map((r) => '<span class="badge ' + r + '">' + r + '</span>').join(' ')
    tr.cells[2].textContent = new Date(s.createdAt).toLocaleString()
    tr.cells[3].textContent = new Date(s.expiresAt).toLocaleString()
    tbody.appendChild(tr)
  }
}
document.getElementById('logout').onclick = async () => {
  await fetch('/tentacle/api/logout', { method: 'POST' })
  location.href = '/'
}
fetch('/tentacle/api/me').then(r => r.json()).then((me) => {
  document.getElementById('who').textContent = (me.identity && me.identity.handle) || ''
})
loadUsers().then(loadInvites).catch((e) => toast(e.message))
</script>
</body>
</html>
`

export function createAdminPageRoute(): GatewayRoute {
  return {
    prefix: ADMIN_PAGE_PREFIX,
    handler: async (req, res, context) => {
      if (!context.identity?.roles?.includes('admin')) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('admin role required\n')
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // The page drives fetch() calls to same-origin APIs only.
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
      })
      res.end(PAGE)
    },
  }
}
