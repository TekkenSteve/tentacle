#!/usr/bin/env node
/**
 * Standalone fake DingTalk for the e2e: device-registration (QR flow) +
 * connections/open handshake + accessToken + a real WebSocket Stream endpoint.
 *
 * The control plane lets the e2e push an inbound message frame to the bot:
 *   POST /__control/push   { "frame": { ... } }
 *
 * Every accepted HTTP call, WS connection and WS frame is appended to --out
 * as one JSON line, so the e2e can assert on protocol facts rather than on
 * what the adapter claims.
 *
 * Usage: node fake-dingtalk-e2e.mjs --port <p> --out <file>
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { WebSocketServer } from '../../packages/plugin-channels/tests/ws-server.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const port = Number(arg('port', '0'))
const outFile = arg('out', undefined)
const log = (entry) => {
  if (outFile !== undefined) appendFileSync(outFile, JSON.stringify(entry) + '\n')
}
if (outFile !== undefined) {
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, '')
}

const sockets = []
let pollCount = 0

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = raw === '' ? {} : JSON.parse(raw)
    } catch {
      const text = JSON.stringify({ error: 'malformed json' })
      res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
      return
    }
    const url = new URL(req.url ?? '/', 'http://fake')
    const path = url.pathname
    const reply = (payload, status = 200) => {
      const text = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }

    if (req.method === 'POST' && path === '/__control/push') {
      const socket = sockets[sockets.length - 1]
      if (socket === undefined) {
        reply({ error: 'no stream connected' }, 409)
        return
      }
      socket.send(JSON.stringify(body.frame))
      log({ kind: 'control-pushed' })
      reply({ ok: true })
      return
    }

    log({ kind: 'http', method: req.method, path, body })
    if (req.method === 'POST' && path === '/app/registration/init') {
      reply({ errcode: 0, errmsg: 'ok', nonce: 'e2e-nonce', expires_in: 300 })
      return
    }
    if (req.method === 'POST' && path === '/app/registration/begin') {
      reply({
        errcode: 0,
        errmsg: 'ok',
        device_code: 'e2e-device-code',
        user_code: 'E2E-CODE',
        verification_uri_complete: 'https://open-dev.dingtalk.com/scan?code=e2e',
        expires_in: 600,
        interval: 1,
      })
      return
    }
    if (req.method === 'POST' && path === '/app/registration/poll') {
      pollCount += 1
      if (pollCount < 2) {
        reply({ errcode: 0, errmsg: 'ok', status: 'WAITING' })
        return
      }
      reply({ errcode: 0, errmsg: 'ok', status: 'SUCCESS', client_id: 'dt-e2e-client', client_secret: 'dt-e2e-secret' })
      return
    }
    if (req.method === 'POST' && path === '/v1.0/gateway/connections/open') {
      reply({ endpoint: `ws://127.0.0.1:${server.address().port}/stream`, ticket: 'e2e-ticket' })
      return
    }
    if (req.method === 'POST' && path === '/v1.0/oauth2/accessToken') {
      reply({ accessToken: 'dt-e2e-token', expireIn: 7200 })
      return
    }
    if (req.method === 'POST' && path === '/robot/sendBySession') {
      reply({ errcode: 0, errmsg: 'ok' })
      return
    }
    if (req.method === 'POST' && path === '/v1.0/robot/oToMessages/batchSend') {
      reply({ processQueryKey: 'query-e2e', requestId: 'request-e2e' })
      return
    }
    reply({ message: `unknown endpoint ${req.method} ${path}` }, 404)
  })
})

const wss = new WebSocketServer({ server, path: '/stream' })
wss.on('connection', (socket, request) => {
  sockets.push(socket)
  log({ kind: 'ws-connected', url: request.url ?? '' })
  socket.on('message', (raw) => {
    let parsed
    try {
      parsed = JSON.parse(raw.toString())
    } catch {
      parsed = { raw: raw.toString() }
    }
    log({ kind: 'ws-frame', frame: parsed })
  })
  socket.on('close', () => log({ kind: 'ws-closed' }))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`fake dingtalk listening on 127.0.0.1:${server.address().port}`)
})
