#!/usr/bin/env node
/**
 * Standalone fake feishu (Lark) open-platform server for the channels e2e leg
 * (mirrors packages/plugin-channels/tests/fake-feishu-api.ts, but standalone so
 * the e2e can run it as its own process):
 *
 *   POST /open-apis/auth/v3/tenant_access_token/internal -> tenant token
 *   GET  /open-apis/bot/v3/info                          -> bot identity (readiness probe too)
 *   POST /open-apis/im/v1/messages                       -> recorded send
 *   POST /open-apis/im/v1/messages/:id/reply             -> recorded reply
 *
 * Usage: node fake-feishu-api.mjs --port <p> --out <file>
 * Every accepted call is appended to <out> as one JSON line.
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const port = Number(arg('port', '0'))
const outFile = arg('out', undefined)
if (outFile !== undefined) {
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, '')
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw === '' ? {} : JSON.parse(raw)
    const url = new URL(req.url ?? '/', 'http://fake')
    const reply = (payload, status = 200) => {
      const text = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }
    const record = (route) => {
      if (outFile !== undefined) {
        appendFileSync(outFile, JSON.stringify({ route, path: url.pathname + url.search, body, authorization: req.headers['authorization'] ?? null }) + '\n')
      }
    }

    if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal' && req.method === 'POST') {
      record('token')
      reply({ code: 0, msg: 'ok', tenant_access_token: 'e2e-tenant-token', expire: 3600 })
      return
    }
    if (url.pathname === '/open-apis/bot/v3/info' && req.method === 'GET') {
      record('botInfo')
      reply({ code: 0, msg: 'ok', bot: { open_id: 'ou_e2e_bot', app_name: 'tentacle_e2e_feishu' } })
      return
    }
    if (url.pathname === '/open-apis/im/v1/messages' && req.method === 'POST') {
      record('send')
      reply({ code: 0, msg: 'ok', data: { message_id: 'om_e2e_1' } })
      return
    }
    if (url.pathname.startsWith('/open-apis/im/v1/messages/') && url.pathname.endsWith('/reply') && req.method === 'POST') {
      record('reply')
      reply({ code: 0, msg: 'ok', data: { message_id: 'om_e2e_2' } })
      return
    }
    reply({ code: 404, msg: 'unknown route' }, 404)
  })
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  console.log(`fake feishu API listening on 127.0.0.1:${address.port}`)
})
