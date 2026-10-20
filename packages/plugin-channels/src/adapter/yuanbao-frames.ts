/**
 * Tencent Yuanbao ConnMsg / TIM wire codec.
 *
 * This is a deliberately small protobuf codec, not a guessed JSON-over-WS
 * protocol.  The field numbers and omission rules are transcribed from
 * reference implementation: yuanbao/protocol.py:
 * ConnMsg (114-143, 394-431), AuthBindReq (146-181), TIM payloads (250-387),
 * and the varint reader/writer (434-534).  Constants are from constants.py:7-47.
 */
import { Buffer } from 'node:buffer'

export const DEFAULT_API_DOMAIN = 'https://bot.yuanbao.tencent.com'
export const DEFAULT_WS_URL = 'wss://bot-wss.yuanbao.tencent.com/wss/connection'
export const SIGN_TOKEN_PATH = '/api/v5/robotLogic/sign-token'

export const MODULE_CONN_ACCESS = 'conn_access'
export const MODULE_BIZ = 'yuanbao_openclaw_proxy'
export const CMD_AUTH_BIND = 'auth-bind'
export const CMD_PING = 'ping'
export const CMD_KICKOUT = 'kickout'
export const CMD_UPDATE_META = 'update-meta'
export const CMD_INBOUND_MESSAGE = 'inbound_message'
export const CMD_SEND_C2C_MESSAGE = 'send_c2c_message'
export const CMD_SEND_GROUP_MESSAGE = 'send_group_message'
export const CMD_SEND_PRIVATE_HEARTBEAT = 'send_private_heartbeat'
export const CMD_SEND_GROUP_HEARTBEAT = 'send_group_heartbeat'

export const CALLBACK_C2C_SEND_MSG = 'C2C.CallbackAfterSendMsg'
export const CALLBACK_GROUP_SEND_MSG = 'Group.CallbackAfterSendMsg'

export const MSG_TYPE_TEXT = 'TIMTextElem'
export const MSG_TYPE_IMAGE = 'TIMImageElem'
export const MSG_TYPE_FILE = 'TIMFileElem'
export const MSG_TYPE_SOUND = 'TIMSoundElem'
export const MSG_TYPE_VIDEO = 'TIMVideoFileElem'

export const CMD_TYPE_REQUEST = 0
export const CMD_TYPE_RESPONSE = 1
export const CMD_TYPE_PUSH = 2
export const CMD_TYPE_PUSH_ACK = 3

export const RET_SUCCESS = 0
export const RET_ALREADY_AUTH = 41101
export const TOKEN_EXPIRED_CODES = new Set([41103, 41104, 41108])
export const HEARTBEAT_RUNNING = 1
export const HEARTBEAT_FINISH = 2
export const HERMES_INSTANCE_ID = '17'

export const WT_VARINT = 0
export const WT_LEN = 2

export interface YuanbaoConnHead {
  readonly cmdType: number
  readonly cmd: string
  readonly seqNo: number
  readonly msgId: string
  readonly module: string
  readonly needAck: boolean
  readonly status: number
}

export interface YuanbaoConnMsg {
  readonly head: YuanbaoConnHead
  readonly data: Buffer
}

export interface YuanbaoMessageElement {
  readonly msg_type: string
  readonly msg_content: Readonly<Record<string, unknown>>
}
export type YuanbaoMessageBody = readonly YuanbaoMessageElement[]

interface ProtoField {
  readonly fieldNumber: number
  readonly wireType: number
  readonly value: number | Buffer
}

type ProtoFieldMap = Map<number, ProtoField[]>

/** Encode the unsigned varint representation used by the reference codec. */
export function encodeVarint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('yuanbao varint must be a non-negative safe integer')
  const out: number[] = []
  let rest = value
  do {
    const byte = rest % 128
    rest = Math.floor(rest / 128)
    out.push(rest > 0 ? byte | 0x80 : byte)
  } while (rest > 0)
  return Buffer.from(out)
}

function field(fieldNumber: number, wireType: number, value: Buffer): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | wireType), value])
}

function bytes(value: Uint8Array): Buffer {
  const valueBuffer = Buffer.from(value)
  return Buffer.concat([encodeVarint(valueBuffer.length), valueBuffer])
}

function string(value: string): Buffer {
  return bytes(Buffer.from(value, 'utf8'))
}

function message(value: Uint8Array): Buffer {
  // `lengthField` owns the outer length prefix; nested messages stay raw here.
  return Buffer.from(value)
}

function lengthField(fieldNumber: number, value: string | Uint8Array): Buffer {
  return field(fieldNumber, WT_LEN, typeof value === 'string' ? string(value) : bytes(value))
}

function varintField(fieldNumber: number, value: number): Buffer {
  return field(fieldNumber, WT_VARINT, encodeVarint(value))
}

function readVarint(data: Uint8Array, start: number): { value: number; next: number } {
  let result = 0
  let multiplier = 1
  let pos = start
  for (let count = 0; count < 10; count += 1) {
    if (pos >= data.length) throw new Error('truncated yuanbao protobuf varint')
    const byte = data[pos]!
    pos += 1
    result += (byte & 0x7f) * multiplier
    if (!Number.isSafeInteger(result)) throw new Error('yuanbao protobuf varint exceeds safe integer range')
    if ((byte & 0x80) === 0) return { value: result, next: pos }
    multiplier *= 128
  }
  throw new Error('yuanbao protobuf varint too long')
}

function parseFields(data: Uint8Array): ProtoFieldMap {
  const fields: ProtoFieldMap = new Map()
  let pos = 0
  while (pos < data.length) {
    const tag = readVarint(data, pos)
    pos = tag.next
    const fieldNumber = Math.floor(tag.value / 8)
    const wireType = tag.value & 0x07
    if (fieldNumber <= 0) throw new Error('invalid yuanbao protobuf field number')
    let value: number | Buffer
    if (wireType === WT_VARINT) {
      const decoded = readVarint(data, pos)
      value = decoded.value
      pos = decoded.next
    } else if (wireType === WT_LEN) {
      const length = readVarint(data, pos)
      pos = length.next
      const end = pos + length.value
      if (end > data.length) throw new Error('truncated yuanbao protobuf bytes field')
      value = Buffer.from(data.subarray(pos, end))
      pos = end
    } else {
      throw new Error(`unsupported yuanbao protobuf wire type ${wireType}`)
    }
    const entry: ProtoField = { fieldNumber, wireType, value }
    const existing = fields.get(fieldNumber)
    if (existing === undefined) fields.set(fieldNumber, [entry])
    else existing.push(entry)
  }
  return fields
}

function first(fields: ProtoFieldMap, fieldNumber: number): ProtoField | undefined {
  return fields.get(fieldNumber)?.[0]
}

function getBytes(fields: ProtoFieldMap, fieldNumber: number): Buffer {
  const entry = first(fields, fieldNumber)
  return entry?.wireType === WT_LEN && Buffer.isBuffer(entry.value) ? entry.value : Buffer.alloc(0)
}

function getString(fields: ProtoFieldMap, fieldNumber: number): string {
  return getBytes(fields, fieldNumber).toString('utf8')
}

function getVarint(fields: ProtoFieldMap, fieldNumber: number): number {
  const entry = first(fields, fieldNumber)
  return entry?.wireType === WT_VARINT && typeof entry.value === 'number' ? entry.value : 0
}

/** Encode one ConnMsg. A zero cmd_type/seq_no is omitted exactly as in Python. */
export function encodeConnMsg(options: {
  readonly cmdType: number
  readonly cmd: string
  readonly seqNo: number
  readonly msgId: string
  readonly module: string
  readonly payload?: Uint8Array
  readonly needAck?: boolean
}): Buffer {
  const headParts: Buffer[] = []
  // protocol.py:404-413 — request cmd_type=0 is therefore absent on the wire.
  if (options.cmdType) headParts.push(varintField(1, options.cmdType))
  if (options.cmd) headParts.push(lengthField(2, options.cmd))
  if (options.seqNo) headParts.push(varintField(3, options.seqNo))
  if (options.msgId) headParts.push(lengthField(4, options.msgId))
  if (options.module) headParts.push(lengthField(5, options.module))
  if (options.needAck) headParts.push(varintField(6, 1))
  const connParts = [lengthField(1, message(Buffer.concat(headParts)))]
  if (options.payload !== undefined && options.payload.byteLength > 0) {
    connParts.push(lengthField(2, options.payload))
  }
  return Buffer.concat(connParts)
}

export function encodeRequest(cmd: string, module: string, msgId: string, seqNo: number, payload: Uint8Array = new Uint8Array()): Buffer {
  return encodeConnMsg({ cmdType: CMD_TYPE_REQUEST, cmd, module, msgId, seqNo, payload })
}

export function encodePushAck(head: YuanbaoConnHead, seqNo: number): Buffer {
  // protocol.py:126-134 — ACK keeps cmd/msg_id/module, allocates a new seq_no.
  return encodeConnMsg({ cmdType: CMD_TYPE_PUSH_ACK, cmd: head.cmd, module: head.module, msgId: head.msgId, seqNo })
}

export function decodeConnMsg(frame: Uint8Array): YuanbaoConnMsg {
  const fields = parseFields(frame)
  const headBytes = getBytes(fields, 1)
  const headFields = parseFields(headBytes)
  return {
    head: {
      cmdType: getVarint(headFields, 1),
      cmd: getString(headFields, 2),
      seqNo: getVarint(headFields, 3),
      msgId: getString(headFields, 4),
      module: getString(headFields, 5),
      needAck: getVarint(headFields, 6) !== 0,
      status: getVarint(headFields, 10),
    },
    data: getBytes(fields, 2),
  }
}

export function encodeAuthBindPayload(options: {
  readonly botId: string
  readonly source: string
  readonly token: string
  readonly routeEnv?: string
  readonly appVersion?: string
  readonly appOperationSystem?: string
  readonly operationSystem?: string
  readonly botVersion?: string
  readonly instanceId?: string
}): Buffer {
  const appVersion = options.appVersion ?? '1.0.0'
  const selectedOperationSystem = options.appOperationSystem || options.operationSystem || 'linux'
  const botVersion = options.botVersion ?? '1.0.0'
  const instanceId = options.instanceId ?? HERMES_INSTANCE_ID
  // protocol.py:160-177 — AuthInfo fields 1/2/3; DeviceInfo 1/2/10/24.
  const authInfo = Buffer.concat([
    lengthField(1, options.botId),
    lengthField(2, options.source),
    lengthField(3, options.token),
  ])
  const deviceParts: Buffer[] = []
  if (appVersion) deviceParts.push(lengthField(1, appVersion))
  if (selectedOperationSystem) deviceParts.push(lengthField(2, selectedOperationSystem))
  if (instanceId) deviceParts.push(lengthField(10, instanceId))
  if (botVersion) deviceParts.push(lengthField(24, botVersion))
  const payload = [
    lengthField(1, 'ybBot'),
    lengthField(2, message(authInfo)),
    lengthField(3, message(Buffer.concat(deviceParts))),
  ]
  if (options.routeEnv) payload.push(lengthField(5, options.routeEnv))
  return Buffer.concat(payload)
}

export function decodeStatusResponse(payload: Uint8Array): { code: number; message: string } {
  if (payload.byteLength === 0) return { code: RET_SUCCESS, message: '' }
  const fields = parseFields(payload)
  return { code: getVarint(fields, 1), message: getString(fields, 2) }
}

/** Small response encoder used by protocol fakes and integration tests. */
export function encodeStatusResponse(code: number, messageText = ''): Buffer {
  const parts = [varintField(1, code)]
  if (messageText) parts.push(lengthField(2, messageText))
  return Buffer.concat(parts)
}

export function encodeTextBody(text: string): YuanbaoMessageBody {
  return [{ msg_type: MSG_TYPE_TEXT, msg_content: { text } }]
}

export function buildImageMsgBody(options: {
  readonly url: string
  readonly uuid?: string
  readonly filename?: string
  readonly size?: number
  readonly width?: number
  readonly height?: number
  readonly mimeType?: string
}): YuanbaoMessageBody {
  const formats: Record<string, number> = { 'image/jpeg': 1, 'image/jpg': 1, 'image/gif': 2, 'image/png': 3, 'image/bmp': 4 }
  const imageFormat = options.mimeType === undefined ? 255 : (formats[options.mimeType.toLowerCase()] ?? 255)
  return [{
    msg_type: MSG_TYPE_IMAGE,
    msg_content: {
      uuid: options.uuid || options.filename || 'image',
      image_format: imageFormat,
      image_info_array: [{
        type: 1,
        size: options.size ?? 0,
        width: options.width ?? 0,
        height: options.height ?? 0,
        url: options.url,
      }],
    },
  }]
}

export function buildFileMsgBody(options: {
  readonly url: string
  readonly filename: string
  readonly uuid?: string
  readonly size?: number
}): YuanbaoMessageBody {
  return [{
    msg_type: MSG_TYPE_FILE,
    msg_content: {
      uuid: options.uuid || options.filename,
      file_name: options.filename,
      file_size: options.size ?? 0,
      url: options.url,
    },
  }]
}

function encodeMsgBodyElement(element: YuanbaoMessageElement): Buffer {
  const parts: Buffer[] = []
  if (element.msg_type) parts.push(lengthField(1, element.msg_type))
  parts.push(lengthField(2, message(encodeMsgContent(element.msg_content))))
  return Buffer.concat(parts)
}

function encodeMsgContent(content: Readonly<Record<string, unknown>>): Buffer {
  const parts: Buffer[] = []
  // protocol.py:350-367 — the numeric zero values are omitted by design.
  for (const [fieldNumber, key] of [[1, 'text'], [2, 'uuid'], [4, 'data'], [5, 'desc'], [6, 'ext'], [7, 'sound'], [10, 'url'], [12, 'file_name']] as const) {
    const value = content[key]
    if (value) parts.push(lengthField(fieldNumber, String(value)))
  }
  for (const [fieldNumber, key] of [[3, 'image_format'], [9, 'index'], [11, 'file_size']] as const) {
    const value = content[key]
    if (value) parts.push(varintField(fieldNumber, Number(value)))
  }
  const imageInfoArray = content['image_info_array']
  if (Array.isArray(imageInfoArray)) {
    for (const item of imageInfoArray) {
      if (typeof item !== 'object' || item === null) continue
      const info = item as Record<string, unknown>
      const imageParts: Buffer[] = []
      for (const [fieldNumber, key] of [[1, 'type'], [2, 'size'], [3, 'width'], [4, 'height']] as const) {
        const value = info[key]
        if (value) imageParts.push(varintField(fieldNumber, Number(value)))
      }
      if (info['url']) imageParts.push(lengthField(5, String(info['url'])))
      if (imageParts.length > 0) parts.push(lengthField(8, message(Buffer.concat(imageParts))))
    }
  }
  const extMap = content['ext_map']
  if (typeof extMap === 'object' && extMap !== null && !Array.isArray(extMap)) {
    for (const [key, value] of Object.entries(extMap)) {
      const entry = Buffer.concat([lengthField(1, key), lengthField(2, String(value))])
      parts.push(lengthField(999, message(entry)))
    }
  }
  return Buffer.concat(parts)
}

function encodeLogExt(traceId: string): Buffer {
  return traceId ? lengthField(1, traceId) : Buffer.alloc(0)
}

export function encodeC2CMessagePayload(options: {
  readonly toAccount: string
  readonly fromAccount: string
  readonly msgBody: YuanbaoMessageBody
  readonly msgId?: string
  readonly msgRandom?: number
  readonly msgSeq?: number
  readonly groupCode?: string
  readonly traceId?: string
}): Buffer {
  const parts: Buffer[] = []
  if (options.msgId) parts.push(lengthField(1, options.msgId))
  parts.push(lengthField(2, options.toAccount))
  if (options.fromAccount) parts.push(lengthField(3, options.fromAccount))
  if (options.msgRandom) parts.push(varintField(4, options.msgRandom))
  for (const element of options.msgBody) parts.push(lengthField(5, message(encodeMsgBodyElement(element))))
  if (options.groupCode) parts.push(lengthField(6, options.groupCode))
  if (options.msgSeq !== undefined) parts.push(varintField(7, options.msgSeq))
  if (options.traceId) parts.push(lengthField(8, message(encodeLogExt(options.traceId))))
  return Buffer.concat(parts)
}

export function encodeGroupMessagePayload(options: {
  readonly groupCode: string
  readonly fromAccount: string
  readonly msgBody: YuanbaoMessageBody
  readonly msgId?: string
  readonly toAccount?: string
  readonly random?: string
  readonly msgSeq?: number
  readonly refMsgId?: string
  readonly traceId?: string
}): Buffer {
  const parts: Buffer[] = []
  if (options.msgId) parts.push(lengthField(1, options.msgId))
  parts.push(lengthField(2, options.groupCode))
  if (options.fromAccount) parts.push(lengthField(3, options.fromAccount))
  if (options.toAccount) parts.push(lengthField(4, options.toAccount))
  if (options.random) parts.push(lengthField(5, options.random))
  for (const element of options.msgBody) parts.push(lengthField(6, message(encodeMsgBodyElement(element))))
  if (options.refMsgId) parts.push(lengthField(7, options.refMsgId))
  if (options.msgSeq !== undefined) parts.push(varintField(8, options.msgSeq))
  if (options.traceId) parts.push(lengthField(9, message(encodeLogExt(options.traceId))))
  return Buffer.concat(parts)
}

export function encodePrivateHeartbeatPayload(fromAccount: string, toAccount: string, heartbeat = HEARTBEAT_RUNNING): Buffer {
  return Buffer.concat([
    lengthField(1, fromAccount),
    lengthField(2, toAccount),
    varintField(3, heartbeat),
  ])
}

export function encodeGroupHeartbeatPayload(options: {
  readonly fromAccount: string
  readonly groupCode: string
  readonly sendTime: number
  readonly heartbeat?: number
}): Buffer {
  return Buffer.concat([
    lengthField(1, options.fromAccount),
    lengthField(2, ''),
    lengthField(3, options.groupCode),
    varintField(4, options.sendTime),
    varintField(5, options.heartbeat ?? HEARTBEAT_RUNNING),
  ])
}
