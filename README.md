# dsh-client-voice-play —— 点一下，把这条回复念出来

[![CI](https://github.com/liubaolin01/dsh-client-voice-play/actions/workflows/ci.yml/badge.svg)](https://github.com/liubaolin01/dsh-client-voice-play/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个 **DeepSeek Harness（dsh）插件**：在每条**已定稿的助手回复**下方的操作栏
（和「复制 / 点赞 / 分支」同一行）加一个**喇叭按钮**。点一下把这条回复念出来，播放中再点停止。

- **两个发声引擎**：默认走**宿主引擎**（宿主半端用系统 SAPI 合成 WAV，页面用 `<audio>` 播放），
  失败或显式选择时走**浏览器引擎**（Web Speech API）。
- **为什么需要宿主引擎**：桌面版 dsh 跑在 Electron 里，渲染进程的 `speechSynthesis`
  在本机只接受调用但不出声（接口存在、`speak()` 不报错、就是没声音）。宿主引擎直接调
  Windows 自带的 SAPI，与渲染进程的语音能力无关。
- **零构建**：纯手写 JS，改完保存即可，不需要 tsdown / pnpm / 编译。
- **零额外依赖**：浏览器半端只 `require('react')`（dsh 平台基座自带），宿主半端只用 Node 内建。
- **不联网、不传数据**：语音全在本机合成。
- **可调**：设置 → 插件 → 「语音播放」，可选引擎、音色、语速、音量、单段字数、是否朗读代码块，
  以及**任务完成后自动播报**（默认关）；可试听，并能看到两个引擎的可用性与宿主诊断日志。

## 安装（Windows 一键）

把整个 `dsh-client-voice-play` 文件夹放到目标机器上，进入该文件夹运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本做三件事（幂等，可重复运行）：

1. 复制插件到 `%DSH_HOME%\plugins\dsh-client-voice-play`
2. 在 `%DSH_HOME%\profiles\node_modules\dsh-client-voice-play` 建接合点（Junction）——
   这样宿主按**包名**就能解析它，client-modules 再读到包里的 `dsh.client` 清单，
   把浏览器半端挂到 `/plugins/dsh-client-voice-play/client.js`
3. 在 **profile 级**补丁层 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml` 追加一行 `insert`

> 为什么写 profile 级而不是 `%DSH_HOME%\cordis.patch.yml`：机器级补丁层会被 dsh 的恢复
> 机制重置回 `[]`；profile 级才是官方编辑点（文件头写着 "Edit cordis.patch.yml, not this file"），
> 且 `initProfile` 只在文件不存在时创建、不覆盖。

默认 profile 为 `desktop`（DSH 桌面端）；没有 desktop 时取 `web`。也可显式指定：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web
```

**补丁层在启动时读取，装完要重启 DSH**（运行中改补丁的热重载不可靠，以重启后的状态为准）。
重启后每条已完成的回复下方、复制/点赞/分支那一行，会多出一个喇叭按钮。

`%DSH_HOME%` 默认是 `C:\Users\<你>\.dsh`；不在默认位置时用 `-DshHome D:\path\.dsh` 指定。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1              # 摘掉注册，保留插件文件
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -PurgeFiles  # 连插件文件一起删
```

同样需要重启 DSH。或手动三步：① 删掉 profile 的 `cordis.patch.yml` 里 `voice-play` 那段
`insert`；② `rmdir` 掉接合点 `profiles\node_modules\dsh-client-voice-play`（只断链）；
③ 删 `plugins\dsh-client-voice-play`。

## 用起来是什么样

```
助手回复正文……
─────────────────────────────────────────
🔊  ⧉  👍  👎  ⑂      9月30日 07:51
↑
朗读按钮（播放中变成 ■ 方块，点它停止）
```

- 同一时刻只念一条：点另一条会自动切过去。
- 回复里只有工具调用、没有正文时，点它会短暂提示「这条回复没有可朗读的正文」。
- 按钮只在**回合最后一条**助手回复上出现（与复制/点赞/分支同一行）——这也是 dsh 唯一
  暴露「按消息操作」的位置。
- 引擎出错时按钮旁会出现一行小字说明原因（例如宿主引擎失败、浏览器引擎没出声），不会静默卡住。

## 任务完成后自动播报

设置 → 插件 → 「语音播放」→ **完成后自动播报**（默认关）。打开后，**当前会话**每完成一个回合，
就自动把该回合的最终回复念出来。

- **只认「已结束」的回合**：判据是聊天快照里的 `turn.end` 标记 —— 还在流式输出的回合没有它，
  所以不会把半截回复当成「任务完成」播出去。
- **只在当前会话生效**：监听器挂在作曲区（`conversation.input.overlay`，每会话一份），
  作曲区在哪个会话就管哪个会话，不会替后台会话乱播。
- **不会重播历史**：首次挂载把已有回复记为基线，之后只有「新出现且已结束」的回复才播 ——
  刷新页面、切到设置页都不会把旧回复念一遍。
- 播放中再来了新回复：停掉旧的，念新的（与手动播放的「同一时刻只念一条」一致）。

```
设置 → 插件 → 语音播放
  完成后自动播报            [开]
```

## 两个引擎

### 宿主引擎（默认，推荐）

宿主半端在 dsh 进程里合成音频，页面用 `<audio>` 播放。**三个后端一起列出**：

| 后端 | 技术 | 能看到什么 |
|---|---|---|
| `edge` | 微软 Edge「大声朗读」的公开端点 | **322 个微软神经语音**（Azure Neural 那一档的音质），中文 14 个：晓晓 / 晓伊 / 云希 / 云扬 / 云健 / 云夏 / 晓北 / 晓妮 / 粤语 / 台湾腔。**免费、无需 API key**，但要联网 |
| `winrt` | `Windows.Media.SpeechSynthesis`（OneCore） | 系统里全部 OneCore 音色，**包括 SAPI5 选不到的那些**（如中文男声 `Microsoft Kangkang`、zh-TW 音色）。离线 |
| `sapi` | `System.Speech`（SAPI5） | 老音色集，如 `Microsoft Huihui Desktop`、`Microsoft Zira Desktop`。离线 |

音色列表按「中文优先 → 在线神经语音 → 本机 winrt → 本机 sapi」排序，所以打开下拉看到的前几个
就是最好听的中文神经语音；330 个音色若按字母排，中文会沉到最后等于不可用。

失败链：**同后端重试一次 → 本机 winrt 中文音色 → 本机 sapi 中文音色**。在线后端断网或接口变动时
自动退回本机，不会让用户点了没声（每次重试都记进日志）。

路由前缀**不能**用 `/api`：那是 RPC 网关注册的**前缀**路由（`connection.rpc.intercept('/api')`），
请求会先被它接走（表现为 4xx）；官方宿主插件也都用自有前缀（如 `/open-in-app/*`）。
为了兼容还没热更到新包的旧页面，同样的三条路由**额外**挂在 `/api/voice-play/*` 上
（exact + prefix 两种形式，谁赢都行）—— 真被这条兼容路由接住时，日志里会写 `compat-*`。

| 路由 | 作用 |
|---|---|
| `GET  /voice-play/voices` | 列出三个后端的全部语音（名称 / 语言 / 性别 / 后端） |
| `POST /voice-play/speak` | 正文 → `audio/wav`（本机）或 `audio/mpeg`（在线）；正文经 UTF-8 临时文件传递，中文与引号不走命令行 |
| `GET  /voice-play/diag` | 诊断：版本、平台、脚本路径、本机音色数、日志尾部 |

- 与官方插件同一套鉴权：先问组合的 `connection.requestRejection(req)`，未授权直接挡掉
  （`connection` 只作可选依赖，取不到时跳过篱笆并在日志里记一条 warn）。
- **服务只能通过 `ctx.get(name)` 读**（本项目最贵的坑）：cordis 上下文是代理，插件没声明
  `inject: ['connection']` 时，`ctx.connection` **甚至 `Reflect.get(ctx, 'connection')`** 都会抛
  `cannot get property "connection" without inject`；而 webServer 的派发层把**任何** handler
  异常统一变成**裸 400 Bad Request**（没有正文、没有线索）—— 排查了两轮才定位。
  本插件的路由因此一律用 `ctx.get()` 读服务，并且每个 handler 都套一层 `guard()`：
  异常变成**带正文的 500 + 一行日志**，再也不会变成谜之 400。
- 每次请求（**含被挡下的**）追加一行到 `%DSH_HOME%\logs\voice-play.log`，
  设置页会展示最后几行。**判据**：日志里有 `hit …` 却看不到后续行 = handler 抛异常了；
  连 `hit` 都没有 = 请求根本没走到本插件（前缀不对，或页面是缓存的旧包）。
- 语速 `0.5~2×`：winrt 走 SSML `<prosody rate="…">`，sapi 映射成 `-10~10`；
  音量 `0~1`：winrt 走 `<prosody volume="…">`，sapi 映射成 `0~100`。两个后端都没有音调参数。
- 没指定音色时**显式挑中文音色**，不落系统默认（英文默认音色念中文会产出空音频）。
- WinRT 首次调用偶发 `Wait` 聚合异常 → 同一后端重试一次，再失败退 SAPI 默认中文音色；
  每次重试都记进日志。**宁可换个声音，也别让用户点了没声。**
- 音色念不了这段文字的语言时（例如用英文音色念中文）引擎会产出空音频，此时接口明确报错，
  而不是让页面播一段静音。

### 浏览器引擎

`window.speechSynthesis`。留给浏览器版 dsh；也给「自动」模式做兜底。
两处已知坑都处理了：`cancel()` 之后延后 120ms 再 `speak()`（Chromium 的 cancel+speak 竞态会
静默丢句），以及 2 秒没收到 `onstart` 就判定「引擎没出声」并明确报出来，而不是让按钮一直卡在播放中。

## 正文怎么拿到的

dsh 的助手回合在聊天快照里有一个 `turn-tail` 节点，带 `closing.finalNode.messageId` 和
`closing.blocks`。插件注册的槽位 `conversation.chat.assistant-actions` 会把
**`messageId`** 交给按钮，于是：

```
聊天快照 timeline.turns → 每个回合的 turn-tail → (messageId, blocks) → 索引
按钮的 messageId ────────────────────────────────┘  → 这条回复的正文
```

索引按快照对象缓存（WeakMap），一次流式更新里几十个按钮只遍历一遍，不会每个按钮各扫一次。

正文先经 `stripForSpeech()` 去 Markdown（代码块、表格、链接、强调符、HTML 标签、裸 URL），
再按句切段（默认单段 ≤ 200 字），逐段排队：宿主引擎一段一个合成请求，浏览器引擎一段一次
`speak`。既避免超长文本的截断，也保证「念完了」和「停止」都能精确落地。

## 音色

打开「设置 → 插件 → 语音播放 → 音色」，排序后的前三档是：

**① 在线神经语音（免费、最好听，需联网）** —— 走微软 Edge 朗读接口，322 个音色，中文 14 个：

```
zh-CN-XiaoxiaoNeural  晓晓  女      zh-CN-YunxiNeural   云希  男
zh-CN-XiaoyiNeural    晓伊  女      zh-CN-YunyangNeural 云扬  男
zh-CN-YunjianNeural   云健  男      zh-CN-YunxiaNeural  云夏  男
zh-CN-liaoning-XiaobeiNeural 晓北（东北）   zh-CN-shaanxi-XiaoniNeural 晓妮（中原）
zh-HK-* 粤语三款        zh-TW-* 台湾腔三款
```

这是 Azure Neural TTS 那一档的音质，**不需要任何 API key、不花钱**。代价是走的是未公开文档的
接口（微软随时可能改动），所以它只是「加成」——失败会自动退回本机音色。协议细节（`Sec-MS-GEC`
令牌、`muid` cookie、扩展 Origin、二进制帧格式）都写在 `lib/edge-tts.js` 的注释里。

**② 本机 OneCore 音色（离线，8 个）**：

```
Microsoft Huihui    zh-CN  女      Microsoft Kangkang  zh-CN  男
Microsoft Yaoyao    zh-CN  女      Microsoft Hanhan    zh-TW  女
Microsoft Yating    zh-TW  女      Microsoft Zhiwei    zh-TW  男
Microsoft Huihui Desktop  zh-CN  女（SAPI）   Microsoft Zira Desktop  en-US  女（SAPI）
```

**③ 系统里再装更多**：Windows「设置 → 时间和语言 → 语音 → 添加语音」添加「中文（简体，中国）」，
装完刷新设置页即可选到 —— 这类语音属于 OneCore，正是本插件走 winrt 后端的原因（SAPI5 看不到）。

不想用在线语音时：把「引擎」改成 `宿主`/`浏览器`，或直接在下拉里挑本机音色；
参数上语速 0.9 左右会自然不少。

## 文件结构

```
dsh-client-voice-play/
├── package.json     # dsh.client 清单（platform: web，零 inject 依赖）
├── lib/
│   ├── index.js     # 宿主半端（webServer 三条路由 + 音色清单 + 合成调度 + 失败链）
│   ├── edge-tts.js  # 免费在线神经语音后端（WebSocket 协议，零依赖）
│   ├── speak.ps1    # 本机语音脚本：-List 枚举 winrt/sapi；合成走 winrt(SSML) 或 sapi
│   └── client.js    # 浏览器半端（朗读按钮 + 设置页，手写 __ModuleLoader__ bundle）
├── install.ps1      # Windows 一键安装
├── uninstall.ps1    # Windows 一键卸载
└── README.md
```

## 分发给别人

这个包是标准 dsh 插件（`dsh.client` 客户端半端 + `lib/index.js` 宿主半端），可以直接给别人用。
三种方式，按对方情况选：

### ① 压缩包（最省事，Windows 推荐）

把打包好的 `dsh-client-voice-play-v0.2.5.zip` 发给对方，解压后双击 / 运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` 会自己找 `%DSH_HOME%`（默认 `~/.dsh`），把包拷进 `plugins/`、在 profile 的
`node_modules` 里建接合点、并把一行注册写进 profile 级 `cordis.patch.yml`；重装时保留已有接合点。
装完**重启 dsh** 即可。卸载用 `uninstall.ps1`。

### ② npm（源里最干净）

```sh
npm publish                                  # 发布者：在本包目录执行
# 使用者（在 dsh profile 目录）：
pnpm add dsh-client-voice-play
```

然后把包名加进该 profile 的 `dsh.profile.bundles`（或让 dsh 的插件管理器接管）。
本插件不需要构建步骤：`lib/*` 就是可直接加载的 ESM 与经典脚本。

### ③ GitHub / 插件管理器（推荐给会用 git 的人）

```sh
git clone https://github.com/liubaolin01/dsh-client-voice-play
cd dsh-client-voice-play
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

或者用 dsh 桌面端的插件管理器加 `github:liubaolin01/dsh-client-voice-play`，
也可以在使用者的 profile `package.json` 里直接写：

```json
{ "dependencies": { "dsh-client-voice-play": "github:liubaolin01/dsh-client-voice-play" } }
```

仓库里自带测试：`npm test`（= 客户端 47 项 + 宿主 29 项；宿主部分要 Windows，
在线语音部分断网会自动跳过），以及在 windows-latest 上跑的 GitHub Actions。

### 别人装上后的平台差异

| 平台 | 手动朗读 | 自动播报 | 音色 |
|---|---|---|---|
| Windows | ✅ | ✅ | 330 个（在线 322 + 本机 8） |
| macOS / Linux | ✅ | ✅ | 322 个在线神经语音；**本机 winrt/sapi 不可用**，此时「自动」模式会自动改用浏览器引擎 |
| 无网络 | ✅（Windows 上退本机音色） | ✅ | Windows 本机 8 个；其它平台只有浏览器自带音色 |

宿主半端失败链已按平台收敛：Windows 上「同后端重试 → winrt → sapi → 在线」，
非 Windows 上跳过 winrt/sapi 直接退在线；全都不行时才由客户端退到浏览器引擎。

### 分发注意事项（请转告使用者）

- **在线神经语音走的是微软 Edge 朗读所用的公开接口，没有 API key，但属于未公开文档的接口**，
  可用性由微软决定。介意的话把「引擎」设成 `宿主` 并选本机音色，或设成 `浏览器`。
- Windows 本机音色来自 `System.Speech` / `Windows.Media.SpeechSynthesis`，**只在 Windows 上有**。
- 插件会在 `%DSH_HOME%\logs\voice-play.log` 记运行时日志，方便对方排障；
  设置页的「诊断」区能直接看到日志尾部与本机音色数。

## 兼容性

按 **dsh 0.2.0-rc.2**（本机运行版 `DeepSeek Harness.exe`，构建提交 `04f392c9`）的契约编写，
逐项对照该版本 app.asar 内的槽位目录与官方插件实现核对：

| 依赖的契约 | 值 |
|---|---|
| 回复操作栏槽位 | `conversation.chat.assistant-actions`（list / session 作用域，由 `dsh-client-ui-chat` 声明） |
| owner props | `{ messageId }` |
| 标准工具包 | `useChat`（聊天快照选择器）、`sessionId`、`useSession` 等 |
| 设置槽位 | `settings.plugins.tab`（root 作用域，`label` 提供标签名） |
| 客户端模块入口 | `window.__ModuleLoader__.load({ id: <包名>, factory })` |
| 平台基座 seed | `react` / `react/jsx-runtime` / `react-dom` / `@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-client-ui-primitives` 等（本插件只用 `react`） |
| 宿主路由 | `ctx.inject(['webServer'], scope => scope.effect(() => scope.webServer.register({ kind: 'exact', path, handler })))`，前缀必须避开 RPC 网关的 `/api` |
| 信任篱笆 | `ctx.connection.requestRejection(req)` 返回状态码即拒绝 |

`lib/client.js` 对快照形状做了防御：`timeline.turns` 取不到就退到 `nodes`，两者都取不到
再退到 DOM（读按钮所在 `[data-turn-tail]` 的前一个兄弟块）。

## 开发时怎么自测

两套测试都在插件目录的**上一级**工作区里（`tests/`），都不依赖浏览器：

```powershell
node tests\client.smoke.mjs   # 浏览器半端：桩 React 跑注册/渲染/点击/取音频/播放/停止/降级 + 真 React 18 渲染
node tests\host.smoke.mjs     # 宿主半端：真的调 PowerShell + SAPI 合成中文 WAV，并按路由契约打完请求/响应
```

`host.smoke.mjs` 会断言生成的 WAV 是合法容器、有真实音频数据、时长合理 —— 也就是说，
**在重启 dsh 之前就能证明发声链路在本机可用**。它还会断言 `speak.ps1` 是纯 ASCII：
PowerShell 5.1 读无 BOM 的 `.ps1` 时按 GBK 解码，**一旦混进中文，字符串里的 `&`/`<`
会被拆成语法错误，整个脚本连 `-List` 都跑不起来**（这个坑踩过两次，所以写成断言）。

## 排障：设置页说「宿主引擎不可用」

按顺序看三处，基本一眼定位：

1. **设置页标题的版本号**（`语音播放（回复朗读） v0.2.2`）：与 `package.json` 对不上，
   说明页面跑的是**缓存的旧 bundle** —— 与宿主无关，换个方式重新加载页面。
2. **「宿主引擎」那一行的完整文字**：新客户端会把**每一次尝试的前缀 + HTTP 状态码 +
   状态文本 + 响应体片段**全列出来，一眼能看出是谁应答的。
3. **`%DSH_HOME%\logs\voice-play.log`**：
   - 有 `hit …` → 请求到达了宿主，按 `hit` 后面的路径与 `rejected` 状态码判断；
   - 完全没有 `hit` → 请求根本没走到本插件（前缀不对，或页面是旧包）。

## 注意事项

- 宿主引擎依赖 Windows 的 `System.Speech`（PowerShell 5.1 自带）；非 Windows 平台会走
  `pwsh` 且大概率失败，此时把设置里的引擎改成「浏览器」。
- 运行中改 `lib/client.js` 后，本机开着 `pnpm run dev:web` 时页面会热更新；改宿主半端
  或 `speak.ps1` 一律需要重启 DSH。
- 设置保存在 localStorage 键 `dsh.voicePlay.settings`，仅存本机、不上传。
- 与既有的「语音播报」插件（任务完成自动念摘要）不冲突：那个是自动播报，本插件是**手动点读**。
