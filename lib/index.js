/**
 * dsh-client-voice-play —— 宿主半端。
 *
 * 存在的理由：桌面版 dsh 跑在 Electron 里，渲染进程的 `speechSynthesis` 在本机
 * 拿不到可用的合成后端（接口在、点下去就是没声音）。宿主半端在宿主进程里调 Windows
 * 自带语音引擎合成 WAV 交给页面播放 —— 与渲染进程的语音能力无关。
 *
 * 两个后端，一起列出：
 *   winrt  Windows.Media.SpeechSynthesis（OneCore）—— 能看到 SAPI5 选不到的音色
 *          （如 Microsoft Kangkang 男声、zh-TW 音色）
 *   sapi   System.Speech（SAPI5）—— 老音色集，如 Microsoft Zira Desktop
 *
 * 三条路由。主前缀 `/voice-play`；**不能**用 `/api`：RPC 网关把 `/api` 注册成
 * webServer 的 prefix 路由，会把 `/api/**` 先接走（官方宿主插件也都用自有前缀，
 * 如 `/open-in-app/*`）。为了兼容还没换包的旧客户端，额外把同样的路由挂到
 * `/api/voice-play/*`（exact + prefix 两种形式，谁赢都行）。
 *   GET  /voice-play/voices  列出两个后端的全部系统语音
 *   POST /voice-play/speak   合成一段文字，返回 audio/wav
 *   GET  /voice-play/diag    诊断信息（日志尾部、脚本路径、音色数）
 *
 * 每次请求（含被鉴权挡下的）都追加一行到 `$DSH_HOME/logs/voice-play.log`。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listEdgeVoices, synthesizeEdge } from './edge-tts.js'

/** 本半端版本（排障时对照页面显示的版本号）。 */
const VERSION = '0.2.5'
/** 主路由前缀（避开 RPC 网关占用的 /api）。 */
const API_BASE = '/voice-play'
/** 兼容前缀：让还没热更到新包的页面也能用。 */
const COMPAT_BASES = ['/api/voice-play']
/** 随包发布的合成脚本。 */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'speak.ps1')
/** 单次请求的正文上限（客户端会分段，正常远低于此）。 */
const MAX_TEXT_CHARS = 4000
/** 请求体上限。 */
const MAX_BODY_BYTES = 256 * 1024
/** 本机后端失败时退到哪个在线中文音色。 */
const EDGE_FALLBACK_VOICE = 'zh-CN-XiaoxiaoNeural'
/** 单次合成的超时。 */
const SYNTH_TIMEOUT_MS = 120000
/** 音色列表的缓存时长：列一次要起一个 PowerShell（约 0.5s）。 */
const VOICE_CACHE_MS = 5 * 60 * 1000
/** 诊断接口回吐的日志行数。 */
const DIAG_TAIL_LINES = 40
/** 小于这个字节数的 WAV 视为「引擎没产出音频」。 */
const MIN_WAV_BYTES = 200
/** Windows 用自带的 PowerShell 5.1（System.Speech / WinRT 在其中都可用）。 */
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'

/** 音色清单缓存 { at, voices }。 */
let voiceCache = { at: 0, voices: [] }
/** 进行中的枚举：并发的 /voices 与合成各调一次，合流成一次 PowerShell。 */
let voiceInFlight = null
/** 只提示一次的「篱笆缺失」标记。 */
let fenceMissingLogged = false

/**
 * 日志文件路径（与全局技能里宿主插件的落盘约定一致）。
 * @returns 绝对路径。
 */
function logFilePath () {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'logs', 'voice-play.log')
}

/**
 * 追加一行诊断日志；失败绝不影响主流程。
 * @param line - 日志正文。
 */
function log (line) {
  try {
    const file = logFilePath()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 日志不可写时静默降级 */
  }
}

/**
 * 读取日志尾部（诊断接口用）。
 * @returns 最后若干行。
 */
function logTail () {
  try {
    return readFileSync(logFilePath(), 'utf8').split('\n').filter(Boolean).slice(-DIAG_TAIL_LINES)
  } catch {
    return []
  }
}

/**
 * 跑一次 PowerShell 脚本。
 * @param args - 传给 speak.ps1 的参数数组。
 * @param timeoutMs - 超时毫秒数。
 * @returns { ok, code, out, err }。
 */
function runPowerShell (args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT, ...args
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, code: -1, out: '', err: String(error && error.message ? error.message : error) })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish({ ok: false, code: -1, out, err: `${err}\ntimeout after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('error', (error) => finish({ ok: false, code: -1, out, err: String(error && error.message ? error.message : error) }))
    child.on('close', (code) => finish({ ok: code === 0, code, out, err }))
  })
}

/**
 * 列出两个后端的系统语音（带缓存）。
 * @param force - 为 true 时忽略缓存重新枚举。
 * @returns { ok, voices, error }；每条音色形如 { name, culture, gender, backend }。
 */
async function listVoices (force) {
  const local = await localVoices(force)
  const edge = await listEdgeVoices(force)
  const voices = [...local.voices]
  if (edge.ok) voices.push(...edge.voices)
  // 排序：中文优先 → 在线神经语音优先（最好听）→ 本机 winrt → 本机 sapi。
  // 330 个音色若按字母排，中文会沉到最后，等于不可用。
  const backendRank = { edge: 0, winrt: 1, sapi: 2 }
  voices.sort((left, right) => {
    const zhDiff = (/^zh/i.test(left.culture) ? 0 : 1) - (/^zh/i.test(right.culture) ? 0 : 1)
    if (zhDiff !== 0) return zhDiff
    const rankDiff = (backendRank[left.backend] ?? 9) - (backendRank[right.backend] ?? 9)
    if (rankDiff !== 0) return rankDiff
    return String(left.name).localeCompare(String(right.name))
  })
  return {
    ok: local.ok || edge.ok,
    voices,
    error: local.ok || edge.ok ? '' : local.error,
    edge: { ok: edge.ok, count: edge.voices.length, error: edge.error ?? '' },
    localCount: local.voices.length
  }
}

/**
 * 枚举本机音色（winrt + sapi，带缓存）。
 * @param force - 忽略缓存。
 * @returns { ok, voices, error }。
 */
async function localVoices (force) {
  if (!force && voiceCache.voices.length > 0 && Date.now() - voiceCache.at < VOICE_CACHE_MS) {
    return { ok: true, voices: voiceCache.voices }
  }
  if (voiceInFlight !== null) return voiceInFlight
  voiceInFlight = enumerateVoices().finally(() => { voiceInFlight = null })
  return voiceInFlight
}

/**
 * 真正枚举一次音色（起一个 PowerShell 跑 -List）。
 * @returns { ok, voices, error }。
 */
async function enumerateVoices () {
  const result = await runPowerShell(['-List'], 30000)
  if (!result.ok) {
    return { ok: false, voices: [], error: (result.err || result.out).trim() || `exit ${result.code}` }
  }
  let parsed
  try {
    parsed = JSON.parse(result.out.trim() || '{}')
  } catch (error) {
    return { ok: false, voices: [], error: `voices JSON unreadable: ${String(error && error.message ? error.message : error)}` }
  }
  const voices = []
  const seen = new Set()
  for (const [backend, rows] of [['winrt', parsed.winrt], ['sapi', parsed.sapi]]) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.name !== 'string' || seen.has(row.name)) continue
      seen.add(row.name)
      voices.push({ name: row.name, culture: row.culture ?? '', gender: row.gender ?? '', backend })
    }
  }
  voiceCache = { at: Date.now(), voices }
  return { ok: true, voices }
}

/**
 * 决定用哪个后端合成指定音色。
 * @param voiceName - 用户选的音色名（可为空）。
 * @param voices - 当前音色清单。
 * @returns 'edge' | 'winrt' | 'sapi'。
 */
function backendFor (voiceName, voices) {
  if (typeof voiceName === 'string' && voiceName.length > 0) {
    const hit = voices.find((voice) => voice.name === voiceName)
    if (hit) return hit.backend
  }
  return 'winrt'
}

/**
 * 单次合成尝试：在线神经语音走 WebSocket，本机音色走 PowerShell。
 * @param text - 待合成的纯文本。
 * @param options - { voiceName, backend, rateMultiplier, volumeLevel }。
 * @returns { bytes, contentType }。
 */
async function synthOnce (text, options) {
  if (options.backend === 'edge') {
    const mp3 = await synthesizeEdge(text, {
      voice: options.voiceName,
      rateMultiplier: options.rateMultiplier,
      volumeLevel: options.volumeLevel
    })
    if (mp3.length < MIN_WAV_BYTES) throw new Error('edge tts returned too little audio')
    return { bytes: mp3, contentType: 'audio/mpeg' }
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-play-'))
  const textFile = join(dir, 'text.txt')
  const outFile = join(dir, 'out.wav')
  try {
    await writeFile(textFile, text, 'utf8')
    const args = [
      '-Backend', options.backend,
      '-TextFile', textFile,
      '-OutFile', outFile,
      '-RateMultiplier', String(options.rateMultiplier),
      '-VolumeLevel', String(options.volumeLevel)
    ]
    if (options.voiceName) args.push('-VoiceName', options.voiceName)
    const result = await runPowerShell(args, SYNTH_TIMEOUT_MS)
    if (!result.ok) throw new Error((result.err || result.out).trim() || `powershell exited with ${result.code}`)
    const wav = await readFile(outFile)
    if (wav.length < MIN_WAV_BYTES) {
      throw new Error(`语音引擎没有产出音频（音色「${options.voiceName || '默认'}」可能不支持这段文字的语言）`)
    }
    return { bytes: wav, contentType: 'audio/wav' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* 临时目录清理失败不影响响应 */ })
  }
}

/**
 * 把一段文字合成为音频。
 *
 * 失败链：同一后端重试一次 → 本机 winrt 中文音色 → 本机 sapi 中文音色。
 * 在线后端（edge）还可能因为断网/接口变动失败，这条链保证它一失败就退回本机，
 * 而不是让用户点了没声。
 * @param text - 待合成的纯文本。
 * @param options - { voiceName, backend, rateMultiplier, volumeLevel }。
 * @returns { bytes, contentType, used, fallback, failures }。
 */
async function synthesize (text, options) {
  const timing = { rateMultiplier: options.rateMultiplier, volumeLevel: options.volumeLevel }
  const plan = [
    { ...options, label: `${options.backend}:${options.voiceName || 'auto'}` },
    { ...options, label: `${options.backend}:${options.voiceName || 'auto'}#retry` }
  ]
  if (process.platform === 'win32') {
    if (options.backend !== 'winrt') plan.push({ voiceName: '', backend: 'winrt', ...timing, label: 'winrt:auto#fallback' })
    if (options.backend !== 'sapi') plan.push({ voiceName: '', backend: 'sapi', ...timing, label: 'sapi:auto#fallback' })
  }
  // winrt / sapi 是 Windows 专有；任何平台上在线后端都是最后一道保险（断网时它也会失败，那就只能报错）。
  if (options.backend !== 'edge') plan.push({ voiceName: EDGE_FALLBACK_VOICE, backend: 'edge', ...timing, label: 'edge:auto#fallback' })
  const failures = []
  for (const attempt of plan) {
    try {
      const audio = await synthOnce(text, attempt)
      return { ...audio, used: attempt.label, fallback: attempt.label !== plan[0].label, failures }
    } catch (error) {
      failures.push(`${attempt.label} → ${String(error && error.message ? error.message : error).replace(/\s+/g, ' ').slice(0, 160)}`)
    }
  }
  throw new Error(failures.join(' ｜ '))
}

/**
 * 把 0.5~2 的语速倍率收进区间。
 * @param value - 语速倍率。
 * @returns 收敛后的倍率。
 */
function toRateMultiplier (value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(2, Math.max(0.5, number)) : 1
}

/**
 * 把 0~1 的音量收进区间。
 * @param value - 音量。
 * @returns 收敛后的音量。
 */
function toVolumeLevel (value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1
}

/**
 * 发送 JSON 响应。
 * @param res - 响应对象。
 * @param status - HTTP 状态码。
 * @param payload - 可序列化负载。
 */
function sendJson (res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * 收集有上限的请求体。
 * @param req - 请求对象。
 * @returns UTF-8 文本；超过上限返回 null。
 */
async function readBoundedBody (req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * 读一个服务 —— **必须**走 `ctx.get()`，绝不能用 `ctx.xxx` 或 `Reflect.get(ctx, 'xxx')`。
 *
 * cordis 的上下文是代理：访问**没声明 inject** 的服务会直接抛
 * `cannot get property "xxx" without inject`。而 webServer 的派发层把任何 handler 异常
 * 统一变成**裸 400 Bad Request**（无正文、无日志线索）—— 这个坑排查了两轮才定位。
 * `ctx.get(name)` 是官方安全访问器：没被提供就返回 undefined。
 * @param ctx - 宿主上下文。
 * @param name - 服务名。
 * @returns 服务值，或 undefined。
 */
function readService (ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    return Reflect.get(ctx, name)
  } catch {
    return undefined
  }
}

/**
 * 组合的鉴权/信任篱笆：未授权的请求在这里就被挡掉。
 *
 * `connection` 只作可选依赖（取不到就跳过）：本插件的存在意义是能出声，
 * 不该因为一个服务名对不上就整条链路静默失效；取得到时一律执行官方篱笆。
 * @param ctx - 宿主上下文。
 * @param req - 请求对象。
 * @param res - 响应对象。
 * @returns 已拒绝时返回 true。
 */
function rejected (ctx, req, res) {
  const connection = readService(ctx, 'connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    if (!fenceMissingLogged) {
      fenceMissingLogged = true
      log('warn: connection service unavailable -- routes are served without the trust fence')
    }
    return false
  }
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch (error) {
    log(`warn: connection.requestRejection threw: ${String(error && error.message ? error.message : error).replace(/\s+/g, ' ').slice(0, 200)}`)
    return false
  }
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/**
 * 给路由处理函数套一层：任何异常都变成**带正文的 500 + 一行日志**。
 *
 * 直接把异常抛给 webServer 会得到裸 400 Bad Request —— 没有正文、没有线索，
 * 排查代价极高（这次的教训）。
 * @param name - 路由名（日志用）。
 * @param handler - 真正的处理函数。
 * @returns 包装后的处理函数。
 */
function guard (name, handler) {
  return async (req, res, via) => {
    try {
      await handler(req, res, via)
    } catch (error) {
      const message = String(error && error.message ? error.message : error).replace(/\s+/g, ' ').slice(0, 300)
      log(`error ${name}: ${message}`)
      if (res.headersSent) {
        try { res.end() } catch { /* 连接已断 */ }
        return
      }
      try {
        sendJson(res, 500, { ok: false, error: `${name}: ${message}` })
      } catch {
        /* 连接已断，无处可写 */
      }
    }
  }
}

/**
 * 读请求路径（诊断日志用）。
 * @param req - 请求对象。
 * @returns pathname。
 */
function pathnameOf (req) {
  try {
    return new URL(String(req.url), 'http://localhost').pathname
  } catch {
    return String(req.url)
  }
}

/**
 * 宿主插件主体：把路由挂到 webServer 上（主前缀 + 兼容前缀）。
 *
 * 用 `ctx.inject` 而不是顶层 `inject` 声明：本插件同时是客户端插件，宿主要求
 * 不满足时也要保持条目活跃，浏览器半端才照常提供。
 * @param ctx - 宿主 cordis 上下文。
 */
export function apply (ctx) {
  log(`apply v${VERSION}: platform=${process.platform} script=${SCRIPT} scriptExists=${existsSync(SCRIPT)} powershell=${POWERSHELL} base=${API_BASE} compat=${COMPAT_BASES.join(',')}`)

  ctx.inject(['webServer'], (scope) => {
    /**
     * 注册一条路由并记一行日志。
     * @param kind - 'exact' | 'prefix'。
     * @param path - 路由路径。
     * @param label - effect 标签。
     * @param handler - 请求处理器。
     */
    const route = (kind, path, label, handler) => {
      scope.effect(() => {
        const dispose = scope.webServer.register({ kind, path, handler })
        log(`route registered: ${kind} ${path}`)
        return dispose
      }, label)
    }

    /** GET /voices 处理器。 */
    const voicesHandler = async (req, res, via) => {
      log(`hit ${via} ${req.method} ${pathnameOf(req)}`)
      if (rejected(scope, req, res)) { log(`rejected ${via} -> ${res.statusCode}`); return }
      if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('allow', 'GET'); res.end(); return }
      const result = await listVoices(false)
      log(`voices: ok=${result.ok} count=${result.voices.length} local=${result.localCount} edge=${result.edge.ok ? result.edge.count : `failed(${result.edge.error})`}`)
      if (!result.ok) { sendJson(res, 500, { ok: false, error: result.error }); return }
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        platform: process.platform,
        voices: result.voices,
        edge: result.edge
      })
    }

    /** POST /speak 处理器。 */
    const speakHandler = async (req, res, via) => {
      log(`hit ${via} ${req.method} ${pathnameOf(req)}`)
      if (rejected(scope, req, res)) { log(`rejected ${via} -> ${res.statusCode}`); return }
      if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('allow', 'POST'); res.end(); return }
      if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      let body
      try {
        const text = await readBoundedBody(req)
        body = text === null ? null : JSON.parse(text)
      } catch {
        sendJson(res, 400, { ok: false, error: 'malformed JSON body' })
        return
      }
      const spoken = typeof body?.text === 'string' ? body.text.trim() : ''
      if (spoken.length === 0) { sendJson(res, 400, { ok: false, error: 'text is required' }); return }
      if (spoken.length > MAX_TEXT_CHARS) {
        sendJson(res, 413, { ok: false, error: `text exceeds ${MAX_TEXT_CHARS} characters` })
        return
      }
      const inventory = await listVoices(false)
      const voiceName = typeof body?.voiceName === 'string' ? body.voiceName : ''
      const options = {
        voiceName,
        backend: backendFor(voiceName, inventory.voices),
        rateMultiplier: toRateMultiplier(body?.rate),
        volumeLevel: toVolumeLevel(body?.volume)
      }
      const startedAt = Date.now()
      try {
        const result = await synthesize(spoken, options)
        const bytes = result.bytes
        log(`speak: ok chars=${spoken.length} voice=${options.voiceName || 'default'} backend=${options.backend} used=${result.used}${result.fallback ? ` fallbackAfter=${result.failures.length}` : ''} rate=${options.rateMultiplier} volume=${options.volumeLevel} type=${result.contentType} bytes=${bytes.length} ms=${Date.now() - startedAt}`)
        if (result.failures.length) log(`speak: retries ${result.failures.join(' ｜ ').slice(0, 400)}`)
        res.statusCode = 200
        res.setHeader('content-type', result.contentType)
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-length', String(bytes.length))
        res.end(bytes)
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        log(`speak: failed chars=${spoken.length} backend=${options.backend} ms=${Date.now() - startedAt} error=${message.replace(/\s+/g, ' ').slice(0, 400)}`)
        sendJson(res, 500, { ok: false, error: message })
      }
    }

    /** GET /diag 处理器。 */
    const diagHandler = async (req, res, via) => {
      log(`hit ${via} ${req.method} ${pathnameOf(req)}`)
      if (rejected(scope, req, res)) { log(`rejected ${via} -> ${res.statusCode}`); return }
      if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('allow', 'GET'); res.end(); return }
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        platform: process.platform,
        powershell: POWERSHELL,
        script: SCRIPT,
        scriptExists: existsSync(SCRIPT),
        base: API_BASE,
        compatBases: COMPAT_BASES,
        localVoiceCount: voiceCache.voices.length,
        logFile: logFilePath(),
        log: logTail()
      })
    }

    const handlers = {
      voices: guard('voices', voicesHandler),
      speak: guard('speak', speakHandler),
      diag: guard('diag', diagHandler)
    }

    for (const base of [API_BASE, ...COMPAT_BASES]) {
      const compat = base !== API_BASE
      for (const name of ['voices', 'speak', 'diag']) {
        const path = `${base}/${name}`
        route('exact', path, `dsh-client-voice-play: ${path}`, (req, res) => handlers[name](req, res, compat ? `compat-exact ${path}` : `exact ${path}`))
      }
      if (compat) {
        // 前缀形式：万一 /api/voice-play/* 的 exact 抢不过 /api 那条 prefix，用更长的前缀去盖。
        route('prefix', base, `dsh-client-voice-play: prefix ${base}`, async (req, res) => {
          const pathname = pathnameOf(req)
          log(`hit compat-prefix ${req.method} ${pathname}`)
          const name = pathname.slice(base.length + 1).split('/')[0]
          if (name === 'voices' || name === 'speak' || name === 'diag') {
            await handlers[name](req, res, `compat-prefix ${pathname}`)
            return
          }
          res.statusCode = 404
          res.end('voice-play: not found')
        })
      }
    }
  })
}
