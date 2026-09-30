/**
 * 免费在线神经语音后端：微软 Edge「大声朗读」所用的公开端点。
 *
 * 为什么用它：本机 Windows 只装了 8 个老音色（SAPI5 + OneCore 各几个），而这条
 * 端点能给出 300+ 个微软神经语音（中文有晓晓 / 晓伊 / 云希 / 云扬 / 云健等 14 个），
 * 音质是 Azure Neural TTS 那一档，且**不需要任何 API key**。
 *
 * 代价与边界（必须清楚）：
 *  - 需要联网，走的是未公开文档的接口，微软随时可能改动或限流；
 *  - 因此它是「可选加成」，本机语音后端始终保留，失败就自动退回本机。
 *
 * 协议要点（对齐 edge-tts 的实现）：
 *  - 握手要带 `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`、
 *    新版 Chromium 版本号、以及 `muid` cookie；否则 403；
 *  - 还要一个按 5 分钟窗口算出来的 `Sec-MS-GEC`（SHA256(Windows 文件时间 + 固定 token)）；
 *  - 音频在二进制帧里：前 2 字节大端 = 头长度，头之后还有 2 字节 CRLF，再是 MP3。
 */

import { createHash, randomBytes } from 'node:crypto'
import { request } from 'node:https'

/** Edge 朗读接口的固定客户端 token（公开在 edge-tts 源码里）。 */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
/** 通告的 Chromium 版本；接口会校验它，太旧会被 403。 */
const CHROMIUM_VERSION = '143.0.3650.75'
const CHROMIUM_MAJOR = CHROMIUM_VERSION.split('.')[0]
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
const BASE_PATH = '/consumer/speech/synthesize/readaloud'
const VOICES_URL = `https://speech.platform.bing.com${BASE_PATH}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
/** 合成超时。 */
const SYNTH_TIMEOUT_MS = 30000
/** 音色列表缓存时长。 */
const VOICE_CACHE_MS = 6 * 60 * 60 * 1000

/** 音色清单缓存。 */
let cachedVoices = { at: 0, voices: [] }

/** 不带横线的 uuid。 */
function uuidHex () {
  return randomBytes(16).toString('hex')
}

/**
 * 生成 `Sec-MS-GEC`：以 5 分钟为窗口，把 Windows 文件时间与固定 token 一起做 SHA256。
 * @returns 大写十六进制摘要。
 */
function secMsGec () {
  const WIN_EPOCH = 11644473600
  let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH
  ticks -= ticks % 300
  ticks *= 1e7
  return createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase()
}

/**
 * 接口要求的日期串（注意它并不是 ISO，末尾那个 Z 是接口自身的怪癖）。
 * @returns 形如 `Wed Sep 30 2026 01:49:14 GMT+0000 (Coordinated Universal Time)`。
 */
function dateToString () {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${days[now.getUTCDay()]} ${months[now.getUTCMonth()]} ${pad(now.getUTCDate())} ${now.getUTCFullYear()} ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
}

/**
 * 把 0.5~2 的语速倍率换成 SSML 的相对百分比。
 * @param multiplier - 语速倍率。
 * @returns 形如 `+20%` / `-20%`。
 */
function rateToSsml (multiplier) {
  const value = Number.isFinite(Number(multiplier)) ? Math.min(2, Math.max(0.5, Number(multiplier))) : 1
  const percent = Math.round((value - 1) * 100)
  return `${percent >= 0 ? '+' : ''}${percent}%`
}

/**
 * 把 0~1 的音量换成 SSML 的相对百分比。
 * @param level - 音量。
 * @returns 形如 `-40%`。
 */
function volumeToSsml (level) {
  const value = Number.isFinite(Number(level)) ? Math.min(1, Math.max(0, Number(level))) : 1
  const percent = Math.round((value - 1) * 100)
  return `${percent >= 0 ? '+' : ''}${percent}%`
}

/**
 * 转义 SSML 正文。
 * @param text - 原文。
 * @returns XML 安全文本。
 */
function escapeXml (text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 取在线音色列表（带缓存）。
 * @param force - 忽略缓存。
 * @returns { ok, voices, error }；每条 { name, culture, gender, backend: 'edge', friendly }。
 */
export async function listEdgeVoices (force = false) {
  if (!force && cachedVoices.voices.length > 0 && Date.now() - cachedVoices.at < VOICE_CACHE_MS) {
    return { ok: true, voices: cachedVoices.voices }
  }
  try {
    const response = await fetch(VOICES_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(15000)
    })
    if (!response.ok) return { ok: false, voices: [], error: `HTTP ${response.status}` }
    const rows = await response.json()
    const voices = (Array.isArray(rows) ? rows : [])
      .filter((row) => typeof row?.ShortName === 'string')
      .map((row) => ({
        name: row.ShortName,
        culture: typeof row.Locale === 'string' ? row.Locale : '',
        gender: typeof row.Gender === 'string' ? row.Gender : '',
        backend: 'edge',
        friendly: typeof row.FriendlyName === 'string' ? row.FriendlyName : ''
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    cachedVoices = { at: Date.now(), voices }
    return { ok: true, voices }
  } catch (error) {
    return { ok: false, voices: [], error: String(error && error.message ? error.message : error) }
  }
}

/**
 * 把一个 WebSocket 文本帧编码出来（客户端帧必须带掩码）。
 * @param payload - 文本或字节。
 * @param opcode - 1=文本 0xa=pong。
 * @returns 帧字节。
 */
function encodeFrame (payload, opcode = 1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const mask = randomBytes(4)
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) masked[index] = data[index] ^ mask[index & 3]
  return Buffer.concat([header, mask, masked])
}

/**
 * 用在线神经语音合成一段文字。
 * @param text - 纯文本。
 * @param options - { voice, rateMultiplier, volumeLevel }。
 * @returns MP3 字节。
 */
export function synthesizeEdge (text, options) {
  return new Promise((resolve, reject) => {
    const voice = options.voice || 'zh-CN-XiaoxiaoNeural'
    const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
      `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rateToSsml(options.rateMultiplier)}' ` +
      `volume='${volumeToSsml(options.volumeLevel)}'>${escapeXml(text)}</prosody></voice></speak>`

    const path = `${BASE_PATH}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&ConnectionId=${uuidHex()}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}`

    const audio = []
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      try { req.destroy() } catch { /* 已结束 */ }
      finish(new Error(`edge tts timeout after ${SYNTH_TIMEOUT_MS}ms`))
    }, SYNTH_TIMEOUT_MS)

    const req = request({
      host: 'speech.platform.bing.com',
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'User-Agent': USER_AGENT,
        Origin: ORIGIN,
        Cookie: `muid=${uuidHex().toUpperCase()};`,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache'
      }
    })

    req.on('response', (res) => {
      res.resume()
      finish(new Error(`edge tts handshake rejected: HTTP ${res.statusCode}`))
    })
    req.on('error', (error) => finish(error))

    req.on('upgrade', (res, socket) => {
      if (res.statusCode !== 101) {
        socket.destroy()
        finish(new Error(`edge tts upgrade failed: HTTP ${res.statusCode}`))
        return
      }
      socket.write(encodeFrame(
        `X-Timestamp:${dateToString()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
        '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"' +
        `},"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`
      ))
      socket.write(encodeFrame(
        `X-RequestId:${uuidHex()}\r\n` +
        'Content-Type:application/ssml+xml\r\n' +
        `X-Timestamp:${dateToString()}Z\r\n` +
        'Path:ssml\r\n\r\n' + ssml
      ))

      let pending = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk])
        for (;;) {
          if (pending.length < 2) return
          const opcode = pending[0] & 0x0f
          let length = pending[1] & 0x7f
          let offset = 2
          if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4 } else if (length === 127) {
            if (pending.length < 10) return
            length = Number(pending.readBigUInt64BE(2))
            offset = 10
          }
          if ((pending[1] & 0x80) !== 0) offset += 4
          if (pending.length < offset + length) return
          const payload = pending.subarray(offset, offset + length)
          pending = pending.subarray(offset + length)

          if (opcode === 0x8) {
            const code = payload.length >= 2 ? payload.readUInt16BE(0) : 0
            socket.destroy()
            if (audio.length > 0) finish(null, Buffer.concat(audio))
            else finish(new Error(`edge tts closed early (code ${code})`))
            return
          }
          if (opcode === 0x9) { socket.write(encodeFrame(payload, 0xa)); continue }
          if (opcode === 0x1) {
            if (payload.toString('utf8').includes('Path:turn.end')) {
              const out = Buffer.concat(audio)
              socket.end()
              if (out.length > 0) finish(null, out)
              else finish(new Error('edge tts returned no audio'))
              return
            }
          }
          if (opcode === 0x2) {
            if (payload.length < 2) continue
            // 前 2 字节大端 = 头长度；头之后还有 2 字节 CRLF，再是音频。
            const start = payload.readUInt16BE(0) + 2
            if (payload.length > start) audio.push(payload.subarray(start))
          }
        }
      })
      socket.on('error', (error) => finish(error))
      socket.on('close', () => {
        if (audio.length > 0) finish(null, Buffer.concat(audio))
        else finish(new Error('edge tts connection closed without audio'))
      })
    })

    req.end()
  })
}
