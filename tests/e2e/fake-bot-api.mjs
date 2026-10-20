#!/usr/bin/env node
/**
 * Fake Telegram Bot API for the channels e2e leg.
 *
 * The e2e suite cannot reach the real Bot API and must not depend on real
 * network anyway, so the adapter's injectable `apiBaseUrl` points here. This
 * server speaks just enough of the API for the adapter to run its real code
 * path:
 *
 *   GET  /bot<token>/getMe          -> the bot identity (also the readiness probe)
 *   POST /bot<token>/getUpdates     -> batches handed over by send-update, then long-polls
 *   POST /bot<token>/sendMessage    -> appended to the outbound log for assertions
 *
 * Usage:
 *   node fake-bot-api.mjs --port <p> --updates <file> --out <file>
 *
 * The updates file is an ARRAY of updates appended atomically by
 * send-update.mjs. Delivery state lives in memory: the cursor is only ever
 * derived from the offset the adapter sends, exactly like the real service.
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const port = Number(arg('port', '0'))
const updatesFile = arg('updates')
const outFile = arg('out')
if (!updatesFile || !outFile) {
  console.error('usage: fake-bot-api.mjs --port <p> --updates <file> --out <file>')
  process.exit(2)
}

/** In-memory outbound log, mirrored to disk so the shell can read it. */
const sent = []
function persistSent() {
  mkdirSync(dirname(outFile), { recursive: true })
  const tmp = `${outFile}.tmp`
  writeFileSync(tmp, JSON.stringify(sent, null, 2) + '\n')
  renameSync(tmp, outFile)
}

function readUpdates() {
  try {
    return JSON.parse(readFileSync(updatesFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * Wait until a timestamp lands strictly inside (last, now], i.e. the batch
 * accumulated since the previous poll. A file-level mtime comparison would
 * race two updates written within the same millisecond, so send-update waits
 * for the clock to tick between writes and this side uses a closed-open check.
 */
async function waitForTimestampAfter(last, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const updates = readUpdates()
    const newest = updates.reduce((max, update) => Math.max(max, update.message?.date ?? 0), 0)
    if (newest > last) return updates
    if (Date.now() >= deadline) return []
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Highest update_id + 1, mirroring what a real server would have queued. */
function highWater(updates) {
  return updates.reduce((max, update) => Math.max(max, update.update_id + 1), 1)
}

async function send(res, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  const body = raw === '' ? {} : JSON.parse(raw)
  const method = (req.url ?? '/').split('/').pop().split('?')[0]

  switch (method) {
    case 'getMe':
      await send(res, { ok: true, result: { id: 9001, is_bot: true, username: 'tentacle_test_bot', first_name: 'Tentacle Test' } })
      return
    case 'getUpdates': {
      const offset = Number(body.offset ?? 0)
      const updates = readUpdates()
      // Deliver everything at or after the cursor. The adapter ratchets the
      // cursor itself, so this mirrors Telegram's at-least-once delivery.
      const pending = updates.filter((update) => update.update_id >= offset)
      if (pending.length > 0) {
        await send(res, { ok: true, result: pending })
        return
      }
      const last = updates.reduce((max, update) => Math.max(max, update.message?.date ?? 0), 0)
      const waited = await waitForTimestampAfter(last, Math.max(1, Number(body.timeout ?? 30)) * 1000)
      const fresh = waited.filter((update) => update.update_id >= offset)
      await send(res, { ok: true, result: fresh })
      return
    }
    case 'sendMessage': {
      sent.push({ chatId: body.chat_id, text: body.text, parseMode: body.parse_mode ?? null, at: Date.now() })
      persistSent()
      await send(res, { ok: true, result: { message_id: sent.length, chat: { id: body.chat_id }, text: body.text } })
      return
    }
    case 'sendChatAction':
      await send(res, { ok: true, result: true })
      return
    default:
      await send(res, { ok: false, error_code: 404, description: `unknown method ${method}` })
  }
})

// A stale updates file from a previous run would replay old messages.
try {
  unlinkSync(updatesFile)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
mkdirSync(dirname(outFile), { recursive: true })
persistSent()

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  // The line the shell waits for; also a useful diagnostic in the log.
  console.log(JSON.stringify({ ready: true, port: address.port, pending: highWater(readUpdates()) }))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  })
}
