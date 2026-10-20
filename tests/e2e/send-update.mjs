#!/usr/bin/env node
/**
 * Append one fake Telegram update to the fake Bot API's update log.
 *
 * Usage:
 *   node send-update.mjs --updates <file> --update-id <n> --user-id <n> \
 *     [--chat-id <n>] [--kind dm|group] --text <text>
 *
 * A separate process is deliberate: the fake server is already running inside
 * the e2e shell, and the update must appear exactly as if Telegram had
 * delivered it — through the server's own file, not through a control socket
 * the adapter could ever see.
 *
 * The write happens only after the wall clock has moved past the second
 * boundary the server compares against, so back-to-back invocations from the
 * shell cannot collapse into one "already delivered" batch.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {
    if (fallback === undefined) {
      console.error(`missing --${name}`)
      process.exit(2)
    }
    return fallback
  }
  return process.argv[index + 1]
}

const updatesFile = arg('updates')
const updateId = Number(arg('update-id'))
const userId = Number(arg('user-id'))
const kind = arg('kind', 'dm')
const chatId = kind === 'group' ? Number(arg('chat-id', '-1001234567890')) : userId
const text = arg('text')

/** The server only delivers updates strictly newer than the last poll time. */
const previous = (() => {
  try {
    const updates = JSON.parse(readFileSync(updatesFile, 'utf8'))
    return updates.reduce((max, update) => Math.max(max, update.message?.date ?? 0), 0)
  } catch {
    return 0
  }
})()
let date = Date.now()
if (date <= previous) {
  // Wait for the next millisecond boundary the server compares against.
  date = previous + 1
  const waitMs = Math.max(0, date - Date.now())
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  date = Math.max(date, Date.now())
}

const update = {
  update_id: updateId,
  message: {
    message_id: updateId,
    date,
    chat: { id: chatId, type: kind === 'group' ? 'supergroup' : 'private', ...(kind === 'group' ? { title: 'e2e group' } : {}) },
    from: { id: userId, is_bot: false, first_name: 'E2E', username: `e2e_${userId}` },
    text,
  },
}

const updates = (() => {
  try {
    return JSON.parse(readFileSync(updatesFile, 'utf8'))
  } catch {
    return []
  }
})()
updates.push(update)
mkdirSync(dirname(updatesFile), { recursive: true })
const tmp = `${updatesFile}.tmp`
writeFileSync(tmp, JSON.stringify(updates, null, 2) + '\n')
renameSync(tmp, updatesFile)
console.log(JSON.stringify({ ok: true, updateId, date }))
