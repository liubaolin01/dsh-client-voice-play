// dsh-client-voice-play 宿主半端的端到端测试。
//
// 不是桩测试：它会真的调用 speak.ps1（Windows SAPI）把中文合成成 WAV，
// 并按 webServer 路由契约打完整个请求/响应。跑通即证明这条发声链路在本机可用。
//
// 用法：node tests/host.smoke.mjs [插件目录]

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '')
/**
 * 找到插件目录：测试放在包内（`<包>/tests/`）时就是上一级，放在工作区时是 `../<包名>`。
 * @returns 插件目录绝对路径。
 */
function locatePlugin () {
  for (const candidate of [`${HERE}/..`, `${HERE}/../dsh-client-voice-play`]) {
    try {
      if (JSON.parse(readFileSync(`${candidate}/package.json`, 'utf8')).name === 'dsh-client-voice-play') return candidate
    } catch { /* 换下一个候选 */ }
  }
  return `${HERE}/../dsh-client-voice-play`
}
const PLUGIN = (process.argv[2] ?? locatePlugin()).replace(/[\\/]+$/, '')

const checks = []
/**
 * 记录一次断言。
 * @param name - 断言名。
 * @param fn - 断言体（可为 async）。
 */
async function check (name, fn) {
  try { await fn(); checks.push(`  ok   ${name}`) } catch (error) { checks.push(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1 }
}

// #region ---------- 假 webServer 环境 ----------
/**
 * 载入宿主半端并 apply 到假 ctx，收集它注册的路由。
 *
 * `serviceAccess` 模拟 cordis 上下文的代理语义 —— 这是本项目最贵的一个坑：
 * 插件没声明 `inject: ['connection']` 时，`ctx.connection` 会**抛异常**
 * （`cannot get property "connection" without inject`），只有 `ctx.get(name)` 安全。
 * @param options - rejection: 篱笆状态码；serviceAccess: 'plain' | 'get' | 'throw'。
 * @returns { routes, effects }
 */
async function activateHost ({ rejection, serviceAccess = 'plain' } = {}) {
  const module = await import(`${new URL(`file:///${PLUGIN.replace(/\\/g, '/')}/lib/index.js`).href}?t=${Date.now()}`)
  const routes = new Map()
  let effects = 0
  const target = {
    effect: (fn) => { effects += 1; try { fn() } catch { /* 注册失败由断言暴露 */ } return () => {} },
    webServer: {
      register: (route) => { routes.set(route.path, route); return () => {} }
    }
  }
  if (serviceAccess === 'plain') {
    target.connection = { requestRejection: () => rejection }
  } else {
    target.get = (name) => {
      if (serviceAccess === 'throw') throw new Error('ctx.get blew up')
      return name === 'connection' ? { requestRejection: () => rejection } : undefined
    }
  }
  const scope = new Proxy(target, {
    get (object, property) {
      if (serviceAccess !== 'plain' && property === 'connection') {
        throw new Error(`cannot get property "${String(property)}" without inject`)
      }
      return object[property]
    }
  })
  const ctx = {
    inject: (services, callback) => {
      assert.deepEqual(services, ['webServer'], '宿主只应硬依赖 webServer')
      callback(scope)
    }
  }
  module.apply(ctx)
  return { routes, effects }
}

/**
 * 造一个 GET 请求。
 * @param headers - 额外请求头。
 * @returns 请求桩。
 */
function makeGet (headers = {}) {
  const req = {
    method: 'GET',
    headers: { host: '127.0.0.1:19387', ...headers },
    async * [Symbol.asyncIterator] () { /* 无请求体 */ }
  }
  return req
}

/**
 * 造一个 POST 请求。
 * @param payload - JSON 负载。
 * @param contentType - content-type 头。
 * @returns 请求桩。
 */
function makePost (payload, contentType = 'application/json') {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const req = {
    method: 'POST',
    headers: { host: '127.0.0.1:19387', 'content-type': contentType },
    async * [Symbol.asyncIterator] () { yield body },
    resume: () => {}
  }
  return req
}

/**
 * 造一个响应桩。
 * @returns 带 status/headers/body 的响应桩。
 */
function makeRes () {
  const res = {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    setHeader (name, value) { res.headers[String(name).toLowerCase()] = value },
    end (payload) {
      if (payload === undefined) res.body = Buffer.alloc(0)
      else if (Buffer.isBuffer(payload)) res.body = payload
      else res.body = Buffer.from(String(payload), 'utf8')
    }
  }
  return res
}

/**
 * 调用一个路由。
 * @param routes - 路由表。
 * @param path - 路由路径。
 * @param req - 请求桩。
 * @returns 响应桩。
 */
async function call (routes, path, req) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} was not registered`)
  const res = makeRes()
  await route.handler(req, res)
  return res
}

/**
 * 调用一个路由，并让 req.url 带上指定路径（prefix 路由靠它派发）。
 * @param routes - 路由表。
 * @param routePath - 路由键。
 * @param req - 请求桩。
 * @param url - 请求的真实 url。
 * @returns 响应桩。
 */
async function routeCall (routes, routePath, req, url) {
  const route = routes.get(routePath)
  assert.ok(route, `route ${routePath} was not registered`)
  const res = makeRes()
  await route.handler({ ...req, url }, res)
  return res
}

/**
 * 读 WAV 头，取出采样率与声道数。
 * @param buffer - WAV 字节。
 * @returns { sampleRate, channels, bitsPerSample, dataBytes }
 */
function parseWav (buffer) {
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF', 'not a RIFF container')
  assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WAVE', 'not a WAVE file')
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let dataBytes = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString('ascii')
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2)
      sampleRate = buffer.readUInt32LE(body + 4)
      bitsPerSample = buffer.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataBytes = size
    }
    offset = body + size + (size % 2)
  }
  return { sampleRate, channels, bitsPerSample, dataBytes }
}
// #endregion

const VOICES_PATH = '/voice-play/voices'
const SPEAK_PATH = '/voice-play/speak'
const DIAG_PATH = '/voice-play/diag'

// 1) 路由注册。
{
  const { routes } = await activateHost()
  await check('speak.ps1 必须是纯 ASCII', () => {
    // PowerShell 5.1 无 BOM 时按 GBK 读 .ps1：一旦混进中文，字符串里的符号会被
    // 拆成语法错误，整个脚本连 -List 都跑不起来（这个坑踩过两次）。
    const source = readFileSync(`${PLUGIN}/lib/speak.ps1`)
    const bad = [...source].filter((byte) => byte > 0x7f)
    assert.equal(bad.length, 0, `speak.ps1 里有 ${bad.length} 个非 ASCII 字节`)
  })
  await check('注册了主前缀三条路由', () => {
    assert.ok(routes.has(VOICES_PATH), 'voices 路由缺失')
    assert.ok(routes.has(SPEAK_PATH), 'speak 路由缺失')
    assert.ok(routes.has(DIAG_PATH), 'diag 路由缺失')
  })
  await check('主前缀路由用 exact 精确匹配', () => {
    assert.equal(routes.get(SPEAK_PATH).kind, 'exact')
  })
  await check('注册了兼容前缀（旧页面仍可用）', () => {
    for (const path of ['/api/voice-play/voices', '/api/voice-play/speak', '/api/voice-play/diag']) {
      assert.ok(routes.has(path), `缺少兼容路由 ${path}`)
    }
    assert.equal(routes.get('/api/voice-play').kind, 'prefix')
  })
  await check('兼容前缀会把子路径派发到同一个处理器', async () => {
    const res = await routeCall(routes, '/api/voice-play', makeGet(), '/api/voice-play/voices')
    assert.equal(res.statusCode, 200, `status=${res.statusCode}`)
    const payload = JSON.parse(res.body.toString('utf8'))
    assert.equal(payload.ok, true)
    assert.ok(payload.voices.length > 0)
  })
}

// 2) 鉴权篱笆：被拒时直接挡掉，不做任何合成。
{
  const { routes } = await activateHost({ rejection: 401 })
  const res = await call(routes, VOICES_PATH, makeGet())
  await check('未授权请求被 401 挡下', () => assert.equal(res.statusCode, 401))
  await check('被拒响应不带任何语音数据', () => assert.equal(res.body.length, 0))
}

// 3) 方法校验。
{
  const { routes } = await activateHost()
  const res = await call(routes, VOICES_PATH, makePost({}))
  await check('voices 路由拒绝 POST（405 + allow）', () => {
    assert.equal(res.statusCode, 405)
    assert.equal(res.headers.allow, 'GET')
  })
  const res2 = await call(routes, SPEAK_PATH, makeGet())
  await check('speak 路由拒绝 GET（405 + allow）', () => {
    assert.equal(res2.statusCode, 405)
    assert.equal(res2.headers.allow, 'POST')
  })
  const res3 = await call(routes, SPEAK_PATH, makePost({ text: 'hi' }, 'text/plain'))
  await check('speak 路由拒绝非 JSON 正文（415）', () => assert.equal(res3.statusCode, 415))
}

// 3b) cordis 代理语义回归测试 —— 本项目最贵的一个坑。
// 没声明 inject 时 `ctx.connection` 会抛，只有 `ctx.get()` 安全；抛出去就会被
// webServer 变成**裸 400 Bad Request**（无正文无日志），排查了两轮。
{
  const { routes } = await activateHost({ serviceAccess: 'get' })
  const res = await call(routes, VOICES_PATH, makeGet())
  await check('ctx.connection 抛异常时路由仍返回 200（服务走 ctx.get）', () => {
    assert.equal(res.statusCode, 200, `status=${res.statusCode}`)
    assert.equal(JSON.parse(res.body.toString('utf8')).ok, true)
  })
}
{
  const { routes } = await activateHost({ serviceAccess: 'throw' })
  const res = await call(routes, VOICES_PATH, makeGet())
  await check('连 ctx.get 都抛时路由仍返回 200（篱笆降级并记 warn）', () => {
    assert.equal(res.statusCode, 200, `status=${res.statusCode}`)
  })
}
{
  const { routes } = await activateHost()
  const broken = { ...makeGet(), get method () { throw new Error('boom') } }
  const res = await call(routes, VOICES_PATH, broken)
  await check('处理函数抛异常时返回带正文的 500（而不是 webServer 的裸 400）', () => {
    assert.equal(res.statusCode, 500, `status=${res.statusCode}`)
    assert.match(res.body.toString('utf8'), /boom/)
  })
}

// 4) 正文校验。
{
  const { routes } = await activateHost()
  const empty = await call(routes, SPEAK_PATH, makePost({ text: '   ' }))
  await check('空正文被拒（400）', () => assert.equal(empty.statusCode, 400))
  const huge = await call(routes, SPEAK_PATH, makePost({ text: 'x'.repeat(5000) }))
  await check('超长正文被拒（413）', () => assert.equal(huge.statusCode, 413))
}

// 5) 真实合成：列出系统语音。
{
  const { routes } = await activateHost()
  const res = await call(routes, VOICES_PATH, makeGet())
  const payload = JSON.parse(res.body.toString('utf8'))
  await check('voices 返回 200 与系统语音列表', () => {
    assert.equal(res.statusCode, 200, `status=${res.statusCode} body=${res.body.toString('utf8').slice(0, 300)}`)
    assert.equal(payload.ok, true)
    assert.ok(Array.isArray(payload.voices) && payload.voices.length > 0, '系统里一个语音都没有')
  })
  await check('列表里有中文语音', () => {
    const zh = payload.voices.filter((voice) => /^zh/i.test(voice.culture || ''))
    assert.ok(zh.length > 0, `没有中文语音：${JSON.stringify(payload.voices)}`)
    checks.push(`       （本机语音 ${payload.voices.length} 个：${payload.voices.map((v) => `${v.name}/${v.culture}/${v.gender}/${v.backend}`).join('、')}）`)
  })
  await check('两个本机后端都被列出且带后端标记', () => {
    const backends = new Set(payload.voices.map((voice) => voice.backend))
    assert.ok(backends.has('winrt'), `缺少 winrt 后端：${[...backends].join(',')}`)
    assert.ok(backends.has('sapi'), `缺少 sapi 后端：${[...backends].join(',')}`)
  })
  await check('在线神经语音（Edge）也在列表里（离线时跳过）', () => {
    const edge = payload.voices.filter((voice) => voice.backend === 'edge')
    if (edge.length === 0) {
      checks.push(`       （在线音色不可用：${JSON.stringify(payload.edge)}）`)
      return
    }
    const zh = edge.filter((voice) => /^zh/i.test(voice.culture || ''))
    assert.ok(zh.length > 0, `在线音色里没有中文：${edge.slice(0, 5).map((v) => v.name).join(',')}`)
    checks.push(`       （在线音色 ${edge.length} 个，中文 ${zh.length} 个，如 ${zh.slice(0, 3).map((v) => v.name).join('、')}）`)
  })
  await check('列表里有中文男声（SAPI5 给不出的那批）', () => {
    const male = payload.voices.filter((voice) => voice.gender === 'Male' && /^zh/i.test(voice.culture || ''))
    assert.ok(male.length > 0, `没有中文男声：${JSON.stringify(payload.voices)}`)
  })
}

// 6) 真实合成：中文 → WAV。
{
  const { routes } = await activateHost()
  const text = '你好，这是一段朗读测试。语音播放插件正在工作。'
  const res = await call(routes, SPEAK_PATH, makePost({ text, rate: 1, volume: 1 }))
  await check('speak 返回 audio/wav', () => {
    assert.equal(res.statusCode, 200, `status=${res.statusCode} body=${res.body.toString('utf8').slice(0, 300)}`)
    assert.equal(res.headers['content-type'], 'audio/wav')
    assert.ok(res.body.length > 1000, `WAV 太小：${res.body.length} 字节`)
  })
  await check('WAV 头合法且含真实音频数据', () => {
    const wav = parseWav(res.body)
    assert.ok(wav.sampleRate >= 8000, `采样率异常：${wav.sampleRate}`)
    assert.ok(wav.channels >= 1)
    assert.ok(wav.dataBytes > 8000, `音频数据太少：${wav.dataBytes} 字节`)
    const seconds = wav.dataBytes / (wav.sampleRate * wav.channels * (wav.bitsPerSample / 8))
    checks.push(`       （合成 ${text.length} 字 → ${res.body.length} 字节 / 约 ${seconds.toFixed(2)} 秒，${wav.sampleRate}Hz）`)
    assert.ok(seconds > 1, `时长异常：${seconds.toFixed(2)} 秒`)
  })
  await check('指定音色可用', async () => {
    const voicesRes = await call(routes, VOICES_PATH, makeGet())
    const zhVoice = JSON.parse(voicesRes.body.toString('utf8')).voices.find((v) => /^zh/i.test(v.culture || ''))
    const named = await call(routes, SPEAK_PATH, makePost({ text: '指定音色测试。', voiceName: zhVoice.name, rate: 1.2, volume: 0.8 }))
    assert.equal(named.statusCode, 200, `status=${named.statusCode}`)
    assert.ok(named.body.length > 1000)
  })
  await check('OneCore 男声（winrt 后端）能合成', async () => {
    const voicesRes = await call(routes, VOICES_PATH, makeGet())
    const male = JSON.parse(voicesRes.body.toString('utf8')).voices.find((v) => v.backend === 'winrt' && v.gender === 'Male' && /^zh/i.test(v.culture || ''))
    assert.ok(male, '本机没有 OneCore 中文男声')
    const res2 = await call(routes, SPEAK_PATH, makePost({ text: '这是男声康康的合成测试。', voiceName: male.name, rate: 1, volume: 1 }))
    assert.equal(res2.statusCode, 200, `status=${res2.statusCode} body=${res2.body.toString('utf8').slice(0, 200)}`)
    parseWav(res2.body)
    assert.ok(res2.body.length > 10000, `WAV 太小：${res2.body.length}`)
  })
  await check('音色与文字语言不匹配时报错而不是给一段静音', async () => {
    const mismatch = await call(routes, SPEAK_PATH, makePost({ text: '中文正文配英文音色。', voiceName: 'Microsoft Zira Desktop' }))
    if (mismatch.statusCode === 200) {
      assert.ok(mismatch.body.length > 200, '英文音色念中文时给出了空 WAV')
    } else {
      assert.equal(mismatch.statusCode, 500)
      assert.match(JSON.parse(mismatch.body.toString('utf8')).error, /没有产出音频|retry|fallback|｜/)
    }
  })
  await check('在线神经语音能合成出 MP3（离线时跳过）', async () => {
    const voicesRes = await call(routes, VOICES_PATH, makeGet())
    const edgeVoice = JSON.parse(voicesRes.body.toString('utf8')).voices.find((v) => v.backend === 'edge' && /^zh-CN/.test(v.culture || ''))
    if (!edgeVoice) {
      checks.push('       （在线音色不可用，跳过这条）')
      return
    }
    const res2 = await call(routes, SPEAK_PATH, makePost({ text: '这是在线神经语音的合成测试。', voiceName: edgeVoice.name, rate: 1, volume: 1 }))
    assert.equal(res2.statusCode, 200, `status=${res2.statusCode} body=${res2.body.toString('utf8').slice(0, 200)}`)
    assert.equal(res2.headers['content-type'], 'audio/mpeg')
    assert.ok(res2.body.length > 3000, `MP3 太小：${res2.body.length}`)
    checks.push(`       （${edgeVoice.name} → ${res2.body.length} 字节 MP3）`)
  })
}

// 7) 诊断接口 + 日志落盘。
{
  const { routes } = await activateHost()
  const res = await call(routes, DIAG_PATH, makeGet())
  const payload = JSON.parse(res.body.toString('utf8'))
  await check('diag 报告脚本存在与平台', () => {
    assert.equal(res.statusCode, 200)
    assert.equal(payload.scriptExists, true, `合成脚本不存在：${payload.script}`)
    assert.equal(payload.ok, true)
  })
  await check('diag 的版本号与 package.json 一致', () => {
    const pkg = JSON.parse(readFileSync(`${PLUGIN}/package.json`, 'utf8'))
    assert.equal(payload.version, pkg.version, `diag=${payload.version} package.json=${pkg.version}`)
  })
  await check('每次调用都写进了日志文件', () => {
    assert.ok(Array.isArray(payload.log) && payload.log.length > 0, `日志为空：${payload.logFile}`)
    assert.ok(payload.log.some((line) => line.includes('speak: ok')), `日志里没有成功的合成记录：\n${payload.log.join('\n')}`)
  })
}

console.log(checks.join('\n'))
console.log(process.exitCode ? '\nFAILED' : '\nALL PASS')
