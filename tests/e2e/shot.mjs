#!/usr/bin/env node
/**
 * Visual check for a running Tentacle deployment.
 *
 * The e2e suite proves a client bundle is SERVED; only a browser proves it runs
 * and looks right. This drives a headless Chrome over raw CDP (no Playwright in
 * this repo) and writes a screenshot plus the rendered text, so a UI change can
 * be reviewed instead of guessed at.
 *
 * Usage:
 *   node tests/e2e/shot.mjs --url http://127.0.0.1:18180 --user admin --password secret \
 *     [--click 频道] [--out tests/.tmp/shot/panel.png] [--width 1440] [--height 900]
 *
 * The target must already be running (see tests/e2e/README.md for the recipe);
 * the tool logs in itself and injects the session cookie into the browser.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

/** Every occurrence of a repeatable flag, in order. */
function args(name) {
  const values = []
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1] !== undefined) values.push(process.argv[index + 1])
  }
  return values
}

const url = arg('url', 'http://127.0.0.1:18180')
const user = arg('user', 'admin')
const password = arg('password')
const clickButtons = args('click')
const clickTexts = args('click-text')
const out = arg('out', 'tests/.tmp/shot/panel.png')
const textOut = arg('text-out')
const width = Number(arg('width', '1440'))
const height = Number(arg('height', '900'))
const debugPort = Number(arg('debug-port', '9333'))

if (password === undefined) {
  console.error('error: --password is required (the admin account created by the setup wizard)')
  process.exit(2)
}

/** Log in over the gateway and keep the session cookie it issues. */
async function login() {
  const response = await fetch(new URL('/tentacle/api/login', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password }),
  })
  if (!response.ok) throw new Error(`login failed: HTTP ${response.status}`)
  const header = response.headers.getSetCookie?.() ?? []
  const raw = header.find((value) => value !== undefined)
  if (raw === undefined) throw new Error('login succeeded but issued no cookie')
  return raw.split(';')[0]
}

const cookie = await login()

const profileDir = mkdtempSync(join(tmpdir(), 'tentacle-shot-'))
const chrome = spawn(arg('chrome', 'google-chrome'), [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-features=Translate',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  `--window-size=${width},${height}`,
  'about:blank',
], { stdio: 'ignore' })

async function browserSocket() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      const page = list.find((entry) => entry.type === 'page')
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('chrome never exposed a page target')
}

/** Minimal CDP client: send(method, params) for one page session. */
async function connect(socketUrl) {
  const ws = new WebSocket(socketUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let nextId = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }
  return {
    send: (method, params = {}) => {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => ws.close(),
  }
}

const client = await connect(await browserSocket())
const evaluate = async (expression) => (await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value

/** Click the first button whose accessible label matches, if any. */
const clickButton = async (want) => await evaluate(`(() => {
  const want = ${JSON.stringify(want)}
  const button = [...document.querySelectorAll('button')].find((b) => {
    const label = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim()
    return label === want || label.includes(want)
  })
  if (!button) return false
  button.click()
  return true
})()`)

/** Click the smallest element whose own text matches exactly (a row, a tab). */
const clickText = async (want) => await evaluate(`(() => {
  const want = ${JSON.stringify(want)}
  const nodes = [...document.querySelectorAll('div,span,td,tr,li,a,label,h2,h3,button')]
    .filter((node) => (node.textContent || '').trim() === want)
  const target = nodes[nodes.length - 1]
  if (!target) return false
  target.click()
  return true
})()`)

await client.send('Page.enable')
await client.send('Runtime.enable')
await client.send('Network.enable')
const [name, value] = cookie.split('=')
await client.send('Network.setCookie', { name, value, url: new URL(url).origin, path: '/', httpOnly: true })
await client.send('Page.navigate', { url })

let booted = false
for (let attempt = 0; attempt < 120; attempt++) {
  if (await evaluate(`document.querySelectorAll('button').length > 3`) === true) {
    booted = true
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!booted) throw new Error(`the app never booted: ${await evaluate('document.body.innerText.slice(0, 300)')}`)

/** Dismiss stock first-run overlays that would cover the panel. */
const dismissOverlays = async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    let dismissed = false
    for (const label of ['稍后配置', 'Skip for now', 'Later']) {
      if (await clickButton(label) === true) dismissed = true
    }
    if (!dismissed) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

await dismissOverlays()
for (const label of clickButtons) {
  if (await clickButton(label) !== true) {
    const labels = await evaluate(`JSON.stringify([...document.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim()).filter(Boolean))`)
    throw new Error(`no button matched ${JSON.stringify(label)}; buttons: ${labels}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
for (const text of clickTexts) {
  if (await clickText(text) !== true) throw new Error(`no element matched the text ${JSON.stringify(text)}`)
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
// Free-form escape hatch (e.g. driving a native <select>): evaluated after all
// clicks, before the screenshot.
for (const expression of args('eval')) {
  const result = await evaluate(expression)
  if (result === false) throw new Error(`--eval returned false: ${expression}`)
  await new Promise((resolve) => setTimeout(resolve, 400))
}
await dismissOverlays()
await new Promise((resolve) => setTimeout(resolve, 400))

const text = await evaluate('document.body.innerText') ?? ''
if (textOut !== undefined) writeFileSync(textOut, text)
const shot = await client.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log(`screenshot: ${out}`)
if (textOut !== undefined) console.log(`page text: ${textOut}`)
console.log(text.slice(0, 800))

client.close()
chrome.kill('SIGTERM')

// Optional smoke assertions: `--expect <substring>` may repeat, and a miss
// fails the process so a broken panel cannot pass unnoticed.
const expected = args('expect')
const missing = expected.filter((needle) => !text.includes(needle))
if (missing.length > 0) {
  console.error(`error: page text is missing: ${missing.map((value) => JSON.stringify(value)).join(', ')}`)
  process.exit(1)
}
if (expected.length > 0) console.log(`page text contains all ${expected.length} expected string(s)`)
