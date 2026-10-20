#!/usr/bin/env node
/**
 * Fake Feishu/Lark OAuth device-registration endpoint (RFC 8628) for the QR
 * quick-setup e2e leg: the REAL `@larksuiteoapi/node-sdk` `registerApp` talks
 * to this server over HTTPS, so the whole start → QR → poll → credentials
 * chain is exercised without touching the public platform.
 *
 * Protocol (from the vendor SDK): form-encoded POSTs to
 * /oauth/v1/app/registration; `begin` answers device_code +
 * verification_uri_complete + expires_in + interval; `poll` answers RFC 8628
 * errors with HTTP 400 (authorization_pending / slow_down) and finally
 * HTTP 200 with client_id + client_secret + user_info.
 *
 * Usage: node fake-feishu-registration.mjs --port <p> --cert <pem> --key <pem> --out <file>
 */
import { createServer } from 'node:https'
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const port = Number(arg('port', '0'))
const outFile = arg('out', undefined)
const options = {
  cert: readFileSync(arg('cert', ''), 'utf8'),
  key: readFileSync(arg('key', ''), 'utf8'),
}
if (outFile !== undefined) {
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, '')
}

let pollCount = 0

const server = createServer(options, (req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const params = new URLSearchParams(raw)
    const action = params.get('action')
    if (outFile !== undefined) {
      appendFileSync(outFile, JSON.stringify({ action, device_code: params.get('device_code') ?? null }) + '\n')
    }
    const reply = (payload, status = 200) => {
      const text = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }

    if (req.method !== 'POST' || req.url !== '/oauth/v1/app/registration') {
      reply({ error: 'not_found' }, 404)
      return
    }
    if (action === 'begin') {
      reply({
        device_code: 'e2e-device-code',
        user_code: 'E2E-CODE',
        verification_uri_complete: 'https://accounts.feishu.cn/device/verify?code=e2e',
        expires_in: 600,
        interval: 1,
      })
      return
    }
    if (action === 'poll') {
      pollCount += 1
      if (params.get('device_code') !== 'e2e-device-code') {
        reply({ error: 'invalid_request', error_description: 'unknown device' }, 400)
        return
      }
      if (pollCount < 2) {
        reply({ error: 'authorization_pending' }, 400)
        return
      }
      reply({ client_id: 'cli_qr_e2e', client_secret: 'qr-e2e-secret', user_info: { open_id: 'ou_qr', tenant_brand: 'feishu' } })
      return
    }
    reply({ error: 'invalid_request' }, 400)
  })
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  console.log(`fake feishu registration (https) listening on 127.0.0.1:${address.port}`)
})
