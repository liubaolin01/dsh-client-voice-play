// dsh-client-voice-play 客户端半端的离线冒烟测试。
//
// 不依赖浏览器：
//   A. 桩 React —— 跑通「注册 → 渲染 → 点击 → 引擎收到什么」，断言正文提取、宿主引擎
//      取音频/播放/排队/停止、宿主失败时退浏览器引擎。
//   B. 真 React + react-dom/server —— 确认在真 React 下也能渲染出标记（hook 用法合法）。
//
// 用法：node tests/client.smoke.mjs [插件目录]

import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
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
const SOURCE = readFileSync(`${PLUGIN}/lib/client.js`, 'utf8')

// 真 React 的候选位置：react 与 react-dom 必须来自同一个 pnpm 虚拟目录，
// 否则是两份 React 实例、hook dispatcher 为 null。找不到就跳过这一项（不硬编码本机路径）。
const PNPM_REACT_PAIRS = [
  process.env.DSH_REACT_DIR,
  ...['..', '../..', '.'].flatMap((base) => [
    `${base}/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules`,
    `${base}/node_modules`
  ]),
  `${fileURLToPath(new URL('..', import.meta.url))}node_modules`
].filter(Boolean).map((entry) => resolve(entry).replace(/\\/g, '/').replace(/\/+$/, ''))

const checks = []
/**
 * 记录一次断言。
 * @param name - 断言名。
 * @param fn - 断言体（可为 async）。
 */
async function check (name, fn) {
  try { await fn(); checks.push(`  ok   ${name}`) } catch (error) { checks.push(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1 }
}

/** 让已排队的微任务跑完。 */
async function flush (times = 4) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 真等一段时间（浏览器引擎刻意延后 120ms 才 speak）。
 * @param ms - 毫秒。
 */
function wait (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// #region ---------- 浏览器桩 ----------
const HEAD = { injected: new Map() }

/**
 * 建立浏览器全局桩。
 * @param options - withSynth: 是否提供 speechSynthesis；hostMode: 'ok' | 'fail' | 'off'。
 * @returns 可观测句柄。
 */
function installBrowser ({ withSynth = true, hostMode = 'ok', hostPlatform = 'win32' } = {}) {
  const spoken = []
  const cancelled = { count: 0 }
  const synth = withSynth
    ? {
        getVoices: () => [
          { name: 'Microsoft Huihui Desktop', lang: 'zh-CN', localService: true },
          { name: 'Microsoft Zira Desktop', lang: 'en-US', localService: true }
        ],
        addEventListener: () => {},
        removeEventListener: () => {},
        speak: (utterance) => { spoken.push(utterance) },
        cancel: () => { cancelled.count += 1 }
      }
    : undefined

  const audioInstances = []
  const blobs = []
  const requests = []

  HEAD.injected.clear()
  globalThis.window = withSynth ? { speechSynthesis: synth } : {}
  globalThis.document = {
    documentElement: { lang: 'zh-CN' },
    head: { appendChild: (node) => { HEAD.injected.set(node.dataset.pluginCss, node.textContent) } },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: () => null
  }
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true })
  } catch (error) {
    /* 只读 navigator：保持原样 */
  }
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) }
  }
  globalThis.SpeechSynthesisUtterance = function SpeechSynthesisUtterance (text) {
    this.text = text
    this.voice = null
    this.lang = ''
    this.rate = 1
    this.pitch = 1
    this.volume = 1
    this.onstart = null
    this.onend = null
    this.onerror = null
  }

  /** 音频元素桩：记录 play/pause，便于测试驱动 onended。 */
  globalThis.Audio = function Audio (src) {
    this.src = src
    this.paused = true
    this.playCount = 0
    this.onended = null
    this.onerror = null
    audioInstances.push(this)
  }
  globalThis.Audio.prototype.play = function () { this.paused = false; this.playCount += 1; return Promise.resolve() }
  globalThis.Audio.prototype.pause = function () { this.paused = true }

  globalThis.URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:test-${blobs.length}` }
  globalThis.URL.revokeObjectURL = () => {}

  globalThis.fetch = (url, init) => {
    requests.push({ url: String(url), init })
    const target = String(url)
    if (target.endsWith('/voices')) {
      if (hostMode === 'off') return Promise.reject(new Error('connect ECONNREFUSED'))
      if (hostMode === 'all-fail' || (hostMode === 'compat-only' && !target.startsWith('/api/'))) {
        return Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden', text: () => Promise.resolve('forbidden') })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, platform: hostPlatform, voices: [
        { name: 'Microsoft Kangkang', culture: 'zh-CN', gender: 'Male', backend: 'winrt' },
        { name: 'zh-CN-XiaoxiaoNeural', culture: 'zh-CN', gender: 'Female', backend: 'edge' },
        { name: 'Microsoft Zira Desktop', culture: 'en-US', gender: 'Female', backend: 'sapi' }
      ] }) })
    }
    if (target.endsWith('/diag')) {
      if (hostMode === 'off') return Promise.reject(new Error('connect ECONNREFUSED'))
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, log: ['2026-09-30T01:00:00Z speak: ok chars=10'] }) })
    }
    if (target.endsWith('/speak')) {
      if (hostMode === 'fail') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false, error: 'powershell exited with 1' }) })
      }
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ size: 4096, kind: 'audio' }) })
    }
    return Promise.reject(new Error(`unexpected request: ${target}`))
  }

  return { synth, spoken, cancelled, settings: store, audioInstances, blobs, requests }
}

/**
 * 载入 bundle，返回 __ModuleLoader__ 捕获到的注册描述。
 * @returns 注册描述。
 */
function loadBundle () {
  let captured = null
  globalThis.window.__ModuleLoader__ = { load: (spec) => { captured = spec } }
  new Function('window', SOURCE)(globalThis.window)
  assert.ok(captured, '__ModuleLoader__.load was not called')
  return captured
}

/**
 * 载入插件并 apply 到假 ctx。
 * @param requireImpl - 传给 factory 的 require 实现。
 * @returns 注册项、effect 与模块元信息。
 */
function activate (requireImpl) {
  const spec = loadBundle()
  const mod = spec.factory(requireImpl)
  assert.equal(typeof mod.apply, 'function', 'module has no apply')
  const registrations = []
  const effects = []
  const ctx = {
    slots: {
      inject: (name, callback) => { registrations.push({ name, callback }) },
      register: (options, component) => ({ options, component })
    },
    effect: (fn, label) => { effects.push({ fn, label }) }
  }
  mod.apply(ctx)
  return { registrations, effects, pluginId: spec.id, inject: mod.inject }
}
// #endregion

// #region ---------- 桩 React ----------
/**
 * 造一个够用的 React 桩：支持本插件用到的 hook 与 createElement。
 * @returns 桩 React 与渲染句柄。
 */
function makeReactShim () {
  const slots = []
  let cursor = 0
  const pendingEffects = []

  const shim = {
    Fragment: Symbol('fragment'),
    createElement (type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState (init) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof init === 'function' ? init() : init
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useEffect (fn) { cursor += 1; pendingEffects.push(fn) },
    useRef (init) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: init }
      return slots[index]
    },
    useCallback (fn) { cursor += 1; return fn }
  }

  return {
    shim,
    /** 复位 hook 游标（开始新一次渲染）。 */
    beginRender () { cursor = 0; pendingEffects.length = 0 },
    /** 跑这一轮登记的 effect（模拟 commit 后的副作用）。 */
    runEffects () { const list = pendingEffects.slice(); list.forEach((fn) => fn()) },
    /** 收集整棵元素树里的指定标签。 */
    collect (element, tag, out = []) {
      if (element === null || element === undefined || typeof element !== 'object') return out
      if (Array.isArray(element)) { element.forEach((child) => this.collect(child, tag, out)); return out }
      if (element.type === tag) out.push(element)
      this.collect(element.props?.children, tag, out)
      return out
    }
  }
}
// #endregion

// #region ---------- 夹具 ----------
const REPLY_MARKDOWN = [
  '# 标题不该被念出来',
  '',
  '**重点**：这条回复会被朗读。[链接](https://example.com) 也不该念 URL。',
  '',
  '```js',
  'const secret = 42',
  '```',
  '',
  '最后一句。'
].join('\n')

/**
 * 造一份聊天快照：一个回合，turn-tail 带 messageId 与正文块。
 * @param messageId - 目标消息 id。
 * @returns 快照对象。
 */
function makeSnapshot (messageId = 'm1') {
  const closing = {
    blocks: [
      { kind: 'reasoning', text: '内部推理不该朗读' },
      { kind: 'text', text: REPLY_MARKDOWN }
    ],
    finalNode: { messageId, seq: 7 }
  }
  return { timeline: { turns: new Map([[3, { data: new Map([['turn-tail', { closing }]]) }]]) } }
}

/**
 * 从激活结果里取出某个槽位的注册项。
 * @param registrations - activate 的注册列表。
 * @param name - 槽位名。
 * @returns 注册项 { options, component }。
 */
function entryOf (registrations, name) {
  const found = registrations.find((r) => r.name === name)
  assert.ok(found, `slot ${name} was not registered`)
  return found.callback()
}

/**
 * 渲染一个消息按钮（含 effect）并返回按钮元素。
 * @param runtime - 桩 React 句柄。
 * @param component - 组件。
 * @param props - 组件 props。
 * @returns 按钮元素。
 */
function renderButton (runtime, component, props) {
  runtime.beginRender()
  const tree = component(props)
  runtime.runEffects()
  return runtime.collect(tree, 'button')[0]
}
// #endregion

// #region ---------- A. 桩 React ----------
// A1) 注册面。
{
  installBrowser()
  const runtime = makeReactShim()
  const { registrations, effects, pluginId, inject } = activate(() => runtime.shim)
  await check('bundle id 等于包名', () => assert.equal(pluginId, 'dsh-client-voice-play'))
  await check('inject 只依赖 slots', () => assert.deepEqual(inject, ['slots']))
  await check('注册了回复操作栏入口', () => {
    assert.equal(registrations.filter((r) => r.name === 'conversation.chat.assistant-actions').length, 1)
  })
  await check('注册了设置页入口', () => {
    assert.equal(registrations.filter((r) => r.name === 'settings.plugins.tab').length, 1)
  })
  await check('注册了自动播报监听入口（作曲区，每会话一份）', () => {
    assert.equal(registrations.filter((r) => r.name === 'conversation.input.overlay').length, 1)
  })
  await check('操作栏条目的 id/order 合法', () => {
    const options = entryOf(registrations, 'conversation.chat.assistant-actions').options
    assert.equal(options.id, 'voice-play')
    assert.equal(typeof options.order, 'number')
  })
  await check('注册了卸载收尾 effect', () => assert.equal(effects.length, 1))
  await check('样式已注入', () => {
    assert.equal(HEAD.injected.size, 1)
    assert.match([...HEAD.injected.values()][0], /\.vp_action\{/)
  })
}

// A2) 正文提取 + 宿主引擎播放（默认路径）。
{
  const env = installBrowser()
  const runtime = makeReactShim()
  const { registrations } = activate(() => runtime.shim)
  const entry = entryOf(registrations, 'conversation.chat.assistant-actions').component
  const snapshot = makeSnapshot('m1')
  let seenText = null
  const props = {
    messageId: 'm1',
    sessionId: 's1',
    useChat: (selector) => { seenText = selector(snapshot); return seenText }
  }

  const button = renderButton(runtime, entry, props)
  await flush()

  await check('渲染出一个朗读按钮', () => assert.ok(button))
  await check('按钮初始文案是「朗读」', () => assert.equal(button.props['aria-label'], '朗读这条回复'))
  await check('正文已剥掉 Markdown 记号', () => {
    assert.ok(seenText.includes('重点：这条回复会被朗读。'), `实际正文：${seenText}`)
    assert.ok(!seenText.includes('```'), '代码围栏没有被去掉')
    assert.ok(!seenText.includes('#'), '标题记号没有被去掉')
    assert.ok(!seenText.includes('https://example.com'), 'URL 没有被去掉')
    assert.ok(!seenText.includes('内部推理'), 'reasoning 块被误读')
  })
  await check('启动时探测了宿主引擎', () => {
    assert.ok(env.requests.some((r) => r.url.endsWith('/voice-play/voices')), `请求：${env.requests.map((r) => r.url).join(', ')}`)
  })

  button.props.onClick()
  await flush()

  await check('点击后向宿主合成接口发出了请求', () => {
    const speak = env.requests.filter((r) => r.url.endsWith('/voice-play/speak'))
    assert.equal(speak.length, 1, `speak 请求数：${speak.length}`)
    const body = JSON.parse(speak[0].init.body)
    assert.ok(body.text.includes('重点：这条回复会被朗读。'), `请求正文：${body.text}`)
    assert.equal(speak[0].init.method, 'POST')
  })
  await check('拿到音频后播放', () => {
    assert.equal(env.audioInstances.length, 1, `音频实例：${env.audioInstances.length}`)
    assert.equal(env.audioInstances[0].playCount, 1)
    assert.match(env.audioInstances[0].src, /^blob:/)
  })

  const firstButton = renderButton(runtime, entry, props)
  await check('播放中按钮变为「停止朗读」', () => assert.equal(firstButton.props['aria-label'], '停止朗读'))

  await check('停止：中止请求并暂停音频', async () => {
    firstButton.props.onClick()
    await flush()
    assert.equal(env.audioInstances[0].paused, true, '音频没有被暂停')
    const after = renderButton(runtime, entry, props)
    assert.equal(after.props['aria-label'], '朗读这条回复')
  })
}

// A3) 长正文按段排队：播完一段才取下一段。
{
  const env = installBrowser()
  const runtime = makeReactShim()
  const { registrations } = activate(() => runtime.shim)
  const entry = entryOf(registrations, 'conversation.chat.assistant-actions').component
  const long = Array.from({ length: 40 }, (_, i) => `第${i}句话，这里有一些文字。`).join('')
  const snapshot = { timeline: { turns: new Map([[1, { data: new Map([['turn-tail', { closing: { blocks: [{ kind: 'text', text: long }], finalNode: { messageId: 'm9' } } }]]) }]]) } }
  const props = { messageId: 'm9', useChat: (selector) => selector(snapshot) }

  const button = renderButton(runtime, entry, props)
  await flush()
  button.props.onClick()
  await flush()

  await check('一次只取一段（不整队请求）', () => {
    assert.equal(env.requests.filter((r) => r.url.endsWith('/speak')).length, 1)
  })
  await check('每段不超过单段字数上限 200', () => {
    const body = JSON.parse(env.requests.find((r) => r.url.endsWith('/speak')).init.body)
    assert.ok(body.text.length <= 200, `单段 ${body.text.length} 字`)
  })

  // 逐段驱动：播完一段触发下一段请求，直到念完。
  let guard = 0
  while (guard < 100) {
    guard += 1
    const audio = env.audioInstances[env.audioInstances.length - 1]
    if (!audio || typeof audio.onended !== 'function') break
    const before = env.requests.filter((r) => r.url.endsWith('/speak')).length
    audio.onended()
    await flush()
    if (env.requests.filter((r) => r.url.endsWith('/speak')).length === before) break
  }
  await check('长正文被切成多段念完', () => {
    const count = env.requests.filter((r) => r.url.endsWith('/speak')).length
    assert.ok(count > 1, `只请求了 ${count} 段`)
  })
  await check('念完后按钮回到「朗读」', () => {
    const after = renderButton(runtime, entry, props)
    assert.equal(after.props['aria-label'], '朗读这条回复')
  })
}

// A4) 宿主引擎失败时（auto）自动退到浏览器引擎。
{
  const env = installBrowser({ hostMode: 'fail' })
  const runtime = makeReactShim()
  const { registrations } = activate(() => runtime.shim)
  const entry = entryOf(registrations, 'conversation.chat.assistant-actions').component
  const snapshot = makeSnapshot('m5')
  const props = { messageId: 'm5', useChat: (selector) => selector(snapshot) }

  const button = renderButton(runtime, entry, props)
  await flush()
  button.props.onClick()
  await flush(8)
  await wait(250)

  await check('宿主失败后改用浏览器引擎发声', () => {
    assert.ok(env.spoken.length >= 1, `speechSynthesis.speak 调用数：${env.spoken.length}`)
    assert.ok(env.spoken[0].text.includes('重点：这条回复会被朗读。'))
  })
}

// A5) 显式选择浏览器引擎时不访问宿主合成接口。
{
  const env = installBrowser()
  globalThis.localStorage.setItem('dsh.voicePlay.settings', JSON.stringify({ engine: 'browser' }))
  const runtime = makeReactShim()
  const { registrations } = activate(() => runtime.shim)
  const entry = entryOf(registrations, 'conversation.chat.assistant-actions').component
  const snapshot = makeSnapshot('m6')
  const props = { messageId: 'm6', useChat: (selector) => selector(snapshot) }

  const button = renderButton(runtime, entry, props)
  button.props.onClick()
  await flush(6)
  await wait(250)
  await check('浏览器引擎路径发声', () => assert.ok(env.spoken.length >= 1))
  await check('浏览器引擎路径不请求宿主合成接口', () => {
    assert.equal(env.requests.filter((r) => r.url.endsWith('/speak')).length, 0)
  })
}

// A6) 没有 speechSynthesis 也不崩（宿主引擎仍可用）。
{
  const env = installBrowser({ withSynth: false })
  const runtime = makeReactShim()
  const { registrations } = activate(() => runtime.shim)
  const entry = entryOf(registrations, 'conversation.chat.assistant-actions').component
  const snapshot = makeSnapshot('m7')
  const props = { messageId: 'm7', useChat: (selector) => selector(snapshot) }
  const button = renderButton(runtime, entry, props)
  await flush()
  await check('无 speechSynthesis 时点击不抛错', () => assert.doesNotThrow(() => button.props.onClick()))
  await flush()
  await check('无 speechSynthesis 时仍走宿主引擎', () => assert.equal(env.audioInstances.length, 1))
}

// A7) 设置页：引擎选择、音色、诊断。
{
  const env = installBrowser()
  const runtime = makeReactShim()
  const { registrations } = activate(() => runtime.shim)
  const tab = entryOf(registrations, 'settings.plugins.tab')
  await check('设置页标签名为「语音播放」', () => assert.equal(tab.options.label, '语音播放'))
  await check('设置页有 id', () => assert.equal(tab.options.id, 'voice-play'))

  runtime.beginRender()
  tab.component({})
  runtime.runEffects()
  await flush()
  runtime.beginRender()
  const tree = tab.component({})
  const texts = JSON.stringify(tree)
  await check('设置页含引擎 / 音色 / 语速 / 音量 / 试听 / 自动播报', () => {
    for (const word of ['引擎', '音色', '语速', '音量', '试听', '完成后自动播报']) assert.ok(texts.includes(word), `缺少 ${word}`)
  })
  await check('设置页展示宿主引擎读数', () => assert.ok(texts.includes('宿主引擎可用'), texts.slice(0, 400)))
  await check('设置页列出系统音色并标注后端', () => {
    assert.ok(texts.includes('Microsoft Kangkang'), texts.slice(0, 600))
    assert.ok(texts.includes('Edge在线'), '在线神经语音没有被标注')
    assert.ok(texts.includes('本机'), '本机音色没有被标注')
  })
  await check('设置页拉取了宿主诊断日志', () => {
    assert.ok(env.requests.some((r) => r.url.endsWith('/diag')))
    assert.ok(texts.includes('speak: ok'))
  })
  // 版本号必须与 package.json 一致：排障时靠它判断页面跑的是不是缓存旧包。
  const pkgVersion = JSON.parse(readFileSync(`${PLUGIN}/package.json`, 'utf8')).version
  await check('设置页展示了插件版本号（且与 package.json 一致）', () => {
    assert.ok(texts.includes(`v${pkgVersion}`), `标题里没有 v${pkgVersion}：${texts.slice(0, 200)}`)
  })
  void env
}

// A8) 多前缀探测：主前缀被挡时退到兼容前缀；都失败时把每次尝试的原因都留下来。
{
  // 主前缀 403、兼容前缀可用 → 探测应当成功，并记住兼容前缀。
  const env = installBrowser({ hostMode: 'compat-only' })
  const runtime = makeReactShim()
  const { registrations } = activate(() => runtime.shim)
  const tab = entryOf(registrations, 'settings.plugins.tab')
  runtime.beginRender()
  tab.component({})
  runtime.runEffects()
  await flush()
  await wait(50)
  runtime.beginRender()
  const texts = JSON.stringify(tab.component({}))
  await check('主前缀失败时退到兼容前缀并成功', () => {
    assert.ok(texts.includes('宿主引擎可用'), texts.slice(0, 500))
    assert.ok(texts.includes('/api/voice-play'), '没有记录实际生效的前缀')
  })
  await check('探测从主前缀开始，并且两个前缀都试过', () => {
    const tries = env.requests.filter((r) => r.url.endsWith('/voices')).map((r) => r.url)
    assert.equal(tries[0], '/voice-play/voices', `实际：${tries.join(', ')}`)
    assert.ok(tries.includes('/api/voice-play/voices'), `实际：${tries.join(', ')}`)
  })
}

{
  // 两个前缀都失败 → 报错里要能看出是谁应答的（状态码 + 状态文本 + 响应体）。
  installBrowser({ hostMode: 'all-fail' })
  const runtime = makeReactShim()
  const { registrations } = activate(() => runtime.shim)
  const tab = entryOf(registrations, 'settings.plugins.tab')
  runtime.beginRender()
  tab.component({})
  runtime.runEffects()
  await flush()
  await wait(50)
  runtime.beginRender()
  const texts = JSON.stringify(tab.component({}))
  await check('全部失败时报错含状态码与响应体', () => {
    assert.ok(texts.includes('宿主引擎不可用'), texts.slice(0, 500))
    assert.ok(texts.includes('403'), '报错里没有状态码')
    assert.ok(texts.includes('forbidden'), '报错里没有响应体片段')
    assert.ok(texts.includes('/voice-play') && texts.includes('/api/voice-play'), '报错里没有列出试过的前缀')
  })
}

// A9) 自动播报：任务完成后念当前会话的新回复。
{
  /**
   * 造一份聊天快照：turns 里每个回合带结束标记 `end` 与 turn-tail。
   * @param entries - [{ turn, id, text, closed }]
   * @returns 快照。
   */
  const makeTurns = (entries) => ({
    timeline: {
      turns: new Map(entries.map((entry) => [entry.turn, {
        ...(entry.closed ? { end: { seq: entry.turn * 10 } } : {}),
        data: new Map([['turn-tail', {
          closing: { blocks: [{ kind: 'text', text: entry.text }], finalNode: { messageId: entry.id, seq: entry.turn * 10 } }
        }]])
      }]))
    }
  })

  /** 取自动播报监听器并渲染一次。 */
  const renderWatcher = (runtime, component, snapshot) => {
    runtime.beginRender()
    const tree = component({ useChat: (selector) => selector(snapshot), sessionId: 's1' })
    runtime.runEffects()
    return tree
  }
  const speakCalls = (env) => env.requests.filter((r) => r.url.endsWith('/speak')).length

  // 1) 开关打开：新回合结束 → 自动念；挂载时已有历史 → 不念。
  {
    const env = installBrowser()
    globalThis.localStorage.setItem('dsh.voicePlay.settings', JSON.stringify({ autoRead: true }))
    const runtime = makeReactShim()
    const { registrations } = activate(() => runtime.shim)
    const watcher = entryOf(registrations, 'conversation.input.overlay').component
    const first = makeTurns([{ turn: 1, id: 'm1', text: '第一条旧回复。', closed: true }])
    renderWatcher(runtime, watcher, first)
    await flush()
    await check('挂载时把已有历史记为基线，不播报', () => assert.equal(speakCalls(env), 0))

    const second = makeTurns([
      { turn: 1, id: 'm1', text: '第一条旧回复。', closed: true },
      { turn: 2, id: 'm2', text: '刚刚完成的第二条回复。', closed: true }
    ])
    renderWatcher(runtime, watcher, second)
    await flush()
    await check('新回复完成时自动播报', () => {
      assert.equal(speakCalls(env), 1, `speak 请求数：${speakCalls(env)}`)
      const body = JSON.parse(env.requests.find((r) => r.url.endsWith('/speak')).init.body)
      assert.ok(body.text.includes('刚刚完成的第二条回复。'), `实际播报：${body.text}`)
    })
    await check('自动播报后按钮状态为播放中', () => assert.ok(env.audioInstances.length >= 1))
  }

  // 2) 回合还在跑（没有 end）→ 不播报。
  {
    const env = installBrowser()
    globalThis.localStorage.setItem('dsh.voicePlay.settings', JSON.stringify({ autoRead: true }))
    const runtime = makeReactShim()
    const { registrations } = activate(() => runtime.shim)
    const watcher = entryOf(registrations, 'conversation.input.overlay').component
    renderWatcher(runtime, watcher, makeTurns([{ turn: 1, id: 'm1', text: '旧的。', closed: true }]))
    await flush()
    renderWatcher(runtime, watcher, makeTurns([
      { turn: 1, id: 'm1', text: '旧的。', closed: true },
      { turn: 2, id: 'm2', text: '还在流式输出，没结束。', closed: false }
    ]))
    await flush()
    await check('回合未结束（无 end 标记）时不播报', () => assert.equal(speakCalls(env), 0))
  }

  // 3) 开关关闭 → 不播报。
  {
    const env = installBrowser()
    globalThis.localStorage.setItem('dsh.voicePlay.settings', JSON.stringify({ autoRead: false }))
    const runtime = makeReactShim()
    const { registrations } = activate(() => runtime.shim)
    const watcher = entryOf(registrations, 'conversation.input.overlay').component
    renderWatcher(runtime, watcher, makeTurns([{ turn: 1, id: 'm1', text: '旧的。', closed: true }]))
    await flush()
    renderWatcher(runtime, watcher, makeTurns([
      { turn: 1, id: 'm1', text: '旧的。', closed: true },
      { turn: 2, id: 'm2', text: '新回复。', closed: true }
    ]))
    await flush()
    await check('开关关闭时不播报', () => assert.equal(speakCalls(env), 0))
  }
}
// A10) 跨平台：非 Windows 上「自动」不再无条件走宿主（winrt / sapi 是 Windows 专有）。
{
  /** 跑一次「点击朗读」并返回本次发出的请求。 */
  const clickAndCollect = async (env, settings) => {
    globalThis.localStorage.setItem('dsh.voicePlay.settings', JSON.stringify(settings))
    const runtime = makeReactShim()
    const { registrations } = activate(() => runtime.shim)
    const action = entryOf(registrations, 'conversation.chat.assistant-actions').component
    const button = renderButton(runtime, action, { messageId: 'm1', useChat: (selector) => selector(makeSnapshot('m1')) })
    await flush()
    button.props.onClick()
    await flush()
    // 浏览器引擎在 cancel() 之后延后 120ms 才 speak（Chromium 竞态），得等它真的发声。
    await wait(300)
    await flush()
    return {
      speak: env.requests.filter((r) => r.url.endsWith('/speak')).length,
      browser: env.spoken.length
    }
  }

  {
    const env = installBrowser({ hostPlatform: 'darwin' })
    const result = await clickAndCollect(env, { engine: 'auto', voiceName: '' })
    await check('非 Windows + 自动 + 未选在线音色 → 用浏览器引擎（不白等宿主）', () => {
      assert.equal(result.speak, 0, `不该请求宿主合成：${result.speak}`)
      assert.ok(result.browser >= 1, '浏览器引擎没有发声')
    })
  }
  {
    const env = installBrowser({ hostPlatform: 'darwin' })
    const result = await clickAndCollect(env, { engine: 'auto', voiceName: 'zh-CN-XiaoxiaoNeural' })
    await check('非 Windows + 自动 + 选中在线音色 → 仍走宿主（在线后端跨平台）', () => {
      assert.equal(result.speak, 1, `宿主合成请求数：${result.speak}`)
    })
  }
  {
    const env = installBrowser({ hostPlatform: 'darwin' })
    const result = await clickAndCollect(env, { engine: 'host', voiceName: 'Microsoft Kangkang' })
    await check('显式选「宿主」引擎时不拦（用户自己知道在做什么）', () => {
      assert.equal(result.speak, 1, `宿主合成请求数：${result.speak}`)
    })
  }
}
// #endregion

// #region ---------- B. 真 React ----------
{
  installBrowser()
  const requireFrom = createRequire(import.meta.url)
  const pairDir = PNPM_REACT_PAIRS.find((dir) => existsSync(`${dir}/react/package.json`) && existsSync(`${dir}/react-dom/server.js`))
  if (pairDir === undefined) {
    checks.push('  skip 真 React 渲染（本机未找到同一 store 的 react + react-dom，已由桩 React 覆盖）')
  } else {
    const React = requireFrom(`${pairDir}/react`)
    const renderToStaticMarkup = requireFrom(`${pairDir}/react-dom/server.js`).renderToStaticMarkup
    const { registrations } = activate((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require: ${name}`)
    })
    const entry = entryOf(registrations, 'conversation.chat.assistant-actions').component
    const snapshot = makeSnapshot('m1')
    let html = ''
    await check('真 React 渲染不抛错', () => {
      html = renderToStaticMarkup(React.createElement(entry, {
        messageId: 'm1',
        sessionId: 's1',
        useChat: (selector) => selector(snapshot)
      }))
    })
    await check('真 React 输出含朗读按钮与无障碍名', () => {
      assert.ok(html.includes('vp_action'), `渲染结果：${html}`)
      assert.ok(html.includes('aria-label="朗读这条回复"'))
      assert.ok(html.includes('<svg'))
    })

    const tab = entryOf(registrations, 'settings.plugins.tab').component
    let tabHtml = ''
    await check('真 React 渲染设置页不抛错', () => {
      tabHtml = renderToStaticMarkup(React.createElement(tab, {}))
    })
    await check('真 React 设置页含标题与试听', () => {
      assert.ok(tabHtml.includes('语音播放（回复朗读）'))
      assert.ok(tabHtml.includes('试听'))
    })
  }
}
// #endregion

console.log(checks.join('\n'))
console.log(process.exitCode ? '\nFAILED' : '\nALL PASS')
