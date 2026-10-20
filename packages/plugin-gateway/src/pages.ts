/**
 * Built-in auth pages (design 02 §7 note): in `required` mode a browser
 * hitting any page unauthenticated gets this login view instead of a JSON
 * error; API clients (no text/html Accept) still get the JSON 403.
 *
 * Deliberately dependency-free, inline-CSS, no client framework — this page
 * is the front door and must render even when everything else is broken.
 * The form posts via fetch (same-origin, so the CSRF fence passes), the
 * session cookie is HttpOnly and set server-side.
 */
import { escapeHtml } from './html.js'

export function loginPage(opts: { error?: string; inviteCode?: string } = {}): string {
  const { error, inviteCode } = opts
  return page('Tentacle — Sign in', `
    <h1>Tentacle</h1>
    <p class="sub" id="subtitle">Sign in to continue</p>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
    <form id="login">
      <label>Username <input name="username" autocomplete="username" required autofocus></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>
    <form id="setup" hidden>
      <label>Admin username <input name="username" autocomplete="username" required></label>
      <label>Admin password <input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
      <label>Confirm password <input name="confirm" type="password" autocomplete="new-password" required></label>
      <button type="submit">Create admin account</button>
    </form>
    ${inviteCode !== undefined ? `
    <details>
      <summary>Have an invite code?</summary>
      <form id="signup">
        <input type="hidden" name="code" value="${escapeHtml(inviteCode)}">
        <label>Username <input name="username" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
        <button type="submit">Create account</button>
      </form>
    </details>` : ''}
    <p class="hint" id="hint"></p>
  `, `
    const hint = document.getElementById('hint')
    const loginForm = document.getElementById('login')
    const setupForm = document.getElementById('setup')

    // First-run wizard: when no account exists yet, this page becomes the
    // setup form (reference-style greenfield wizard — no config file editing).
    fetch('${SETUP_STATUS_API}').then(r => r.ok ? r.json() : null).then((s) => {
      if (s && s.required) {
        document.getElementById('subtitle').textContent = 'Welcome — create the admin account to begin'
        loginForm.hidden = true
        setupForm.hidden = false
        setupForm.querySelector('input').focus()
      }
    }).catch(() => { /* no tenancy mounted — plain login */ })

    async function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const f = new FormData(e.target)
      const res = await postJson('${LOGIN_API}', { username: f.get('username'), password: f.get('password') })
      if (res.ok) { location.href = '/'; return }
      hint.textContent = res.status === 401 ? 'Invalid username or password.' : 'Sign-in failed (' + res.status + ').'
    })
    setupForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const f = new FormData(e.target)
      if (f.get('password') !== f.get('confirm')) { hint.textContent = 'Passwords do not match.'; return }
      const res = await postJson('${SETUP_API}', { username: f.get('username'), password: f.get('password') })
      if (res.status === 201) {
        const login = await postJson('${LOGIN_API}', { username: f.get('username'), password: f.get('password') })
        if (login.ok) { location.href = '/'; return }
        hint.textContent = 'Account created — sign in.'
        return
      }
      hint.textContent = 'Setup failed (' + res.status + ').'
    })
    const signup = document.getElementById('signup')
    if (signup) signup.addEventListener('submit', async (e) => {
      e.preventDefault()
      const f = new FormData(e.target)
      const res = await postJson('${SIGNUP_API}', { code: f.get('code'), username: f.get('username'), password: f.get('password') })
      if (res.status === 201) { hint.textContent = 'Account created — sign in above.'; return }
      hint.textContent = 'Signup failed (' + res.status + ').'
    })
  `)
}

export function signupLandingHtml(code: string): string {
  return loginPage({ inviteCode: code })
}

const LOGIN_API = '/tentacle/api/login'
const SIGNUP_API = '/tentacle/api/signup'
const SETUP_STATUS_API = '/tentacle/api/setup-status'
const SETUP_API = '/tentacle/api/setup'

function page(title: string, body: string, script?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: system-ui, sans-serif; background: #0f1115; color: #e7e9ee; }
  main { width: min(360px, 90vw); padding: 32px; border-radius: 12px;
         background: #181b22; box-shadow: 0 8px 40px rgba(0,0,0,.4); }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .sub { margin: 0 0 20px; color: #9aa1ad; font-size: 14px; }
  label { display: block; font-size: 13px; color: #9aa1ad; margin-bottom: 14px; }
  input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px;
          padding: 9px 10px; border-radius: 8px; border: 1px solid #2c313c;
          background: #0f1115; color: inherit; font-size: 14px; }
  button { width: 100%; padding: 10px; border: 0; border-radius: 8px;
           background: #4c7dff; color: white; font-size: 14px; cursor: pointer; }
  button:hover { background: #5d88ff; }
  .error { color: #ff8489; font-size: 13px; }
  .hint { min-height: 18px; font-size: 13px; color: #9aa1ad; }
  details { margin-top: 18px; font-size: 13px; color: #9aa1ad; }
  summary { cursor: pointer; }
</style>
</head>
<body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body>
</html>
`
}
