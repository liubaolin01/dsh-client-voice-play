/**
 * dsh-client-voice-play —— 浏览器半端（静态手写 bundle，无需构建）。
 *
 * 功能：
 *  1. 在「已定稿的助手回复」操作栏（与复制 / 点赞 / 分支同一行）注册一个朗读按钮：
 *     点击 → 把这条回复的正文念出来；播放中再点 → 停止。
 *  2. 在「设置 → 插件」注册一个标签页：引擎 / 音色 / 语速 / 音调 / 音量 /
 *     单段字数 / 是否朗读代码块，并可试听；另有诊断读数。
 *
 * 两个发声引擎：
 *  - host（默认）：宿主半端用 Windows SAPI 合成 WAV（POST /api/voice-play/speak），
 *    页面用 <audio> 播放。桌面版 dsh 跑在 Electron 里，渲染进程的 speechSynthesis
 *    在本机不出声，所以这条路是主力。
 *  - browser：Web Speech API。留给浏览器版 dsh，也作为 host 失败时的兜底。
 *
 * 正文来源：聊天快照里助手回合的 turn-tail 节点带 closing.finalNode.messageId
 * 与 closing.blocks（见 textIndex），用 messageId 与按钮的 owner props 对齐；
 * 取不到时回退 DOM（turn-tail 的前一个兄弟块）。
 *
 * 格式：window.__ModuleLoader__.load({ id, factory })；factory 返回 { apply, inject }。
 * id 必须等于本包包名。除平台基座里的 react 外不 require 任何模块。
 */
window.__ModuleLoader__.load({
	id: "dsh-client-voice-play",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		/** 本半端版本号：显示在设置页标题上，用来判断页面跑的是哪一版。 */
		var PLUGIN_VERSION = "0.2.5";

		/**
		 * 宿主路由前缀候选，按顺序探测。
		 * `/voice-play` 是主前缀；`/api/voice-play` 只作兼容 —— `/api` 被 RPC 网关
		 * 注册成 prefix 路由占着，正常走不到那里。
		 */
		var HOST_BASES = ["/voice-play", "/api/voice-play"];
		/** 探测成功后固定下来的前缀。 */
		var hostBase = HOST_BASES[0];

		// #region ---------- 小工具 ----------
		/**
		 * 把数字收进区间。
		 * @param n - 任意输入。
		 * @param lo - 下限。
		 * @param hi - 上限。
		 * @returns 收敛后的有限数字；非法输入返回下限。
		 */
		function clamp(n, lo, hi) {
			var v = Number(n);
			return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
		}

		/** 极小快照 store：订阅者只在 set 被调用时被唤醒。 */
		function createStore(initial) {
			var state = initial;
			var listeners = new Set();
			return {
				get: function () { return state; },
				set: function (patch) {
					state = Object.assign({}, state, patch);
					listeners.forEach(function (listener) {
						try { listener(); } catch (error) { console.error("[voice-play] listener threw:", error); }
					});
				},
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				}
			};
		}

		/**
		 * 订阅一个 store 的钩子。
		 * @param store - createStore 产出的 store。
		 * @returns 当前快照。
		 */
		function useStore(store) {
			var pair = React.useState(store.get);
			var snapshot = pair[0];
			var setSnapshot = pair[1];
			React.useEffect(function () {
				return store.subscribe(function () { setSnapshot(store.get()); });
			}, [store]);
			return snapshot;
		}

		/** 文案：跟随界面语言（读不到就中文）。 */
		function isZh() {
			try {
				var lang = (document.documentElement && document.documentElement.lang) || navigator.language || "";
				return !/^en/i.test(String(lang));
			} catch (error) {
				return true;
			}
		}

		/**
		 * 取当前语言下的一句文案。
		 * @param pair - [中文, English]。
		 * @returns 文案。
		 */
		function copyFor(pair) {
			return isZh() ? pair[0] : pair[1];
		}
		// #endregion

		// #region ---------- 设置 ----------
		var SETTINGS_KEY = "dsh.voicePlay.settings";

		/** 默认设置；localStorage 里的值逐字段覆盖。 */
		var DEFAULTS = {
			engine: "auto",    // auto = 先用宿主引擎，失败再退浏览器引擎
			voiceName: "",     // 空 = 自动挑一个中文音色
			rate: 1,           // 语速 0.5~2
			pitch: 1,          // 音调 0~2（只对浏览器引擎有效）
			volume: 1,         // 音量 0~1
			maxChunk: 200,     // 单段最大字符数
			readCode: false,   // 是否把代码块也念出来
			autoRead: false    // 任务完成后自动播报当前会话的新回复
		};

		/** 设置版本号：设置页写入后自增，用来唤醒所有朗读按钮重取设置。 */
		var settingsStore = createStore({ version: 0 });
		var settingsCache = null;

		/**
		 * 读取设置（非法/缺失一律回退默认值，永不抛错）。
		 * @returns 完整的设置对象。
		 */
		function loadSettings() {
			var parsed = null;
			try {
				var raw = localStorage.getItem(SETTINGS_KEY);
				parsed = raw ? JSON.parse(raw) : null;
			} catch (error) {
				parsed = null;
			}
			var out = {};
			for (var key in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) out[key] = DEFAULTS[key];
			if (parsed && typeof parsed === "object") {
				for (var name in DEFAULTS) {
					if (Object.prototype.hasOwnProperty.call(DEFAULTS, name) && parsed[name] !== undefined) out[name] = parsed[name];
				}
			}
			out.rate = clamp(out.rate, 0.5, 2);
			out.pitch = clamp(out.pitch, 0, 2);
			out.volume = clamp(out.volume, 0, 1);
			out.maxChunk = Math.round(clamp(out.maxChunk, 40, 600));
			out.readCode = out.readCode === true;
			out.autoRead = out.autoRead === true;
			out.voiceName = typeof out.voiceName === "string" ? out.voiceName : "";
			out.engine = out.engine === "host" || out.engine === "browser" ? out.engine : "auto";
			return out;
		}

		/**
		 * 当前设置（进程内缓存，避免每个按钮每次渲染都读 localStorage）。
		 * @returns 完整的设置对象。
		 */
		function currentSettings() {
			if (settingsCache === null) settingsCache = loadSettings();
			return settingsCache;
		}

		/**
		 * 写入一项设置：更新缓存、持久化、并广播版本号。
		 * @param patch - 要合并的设置片段。
		 * @returns 写入后的完整设置。
		 */
		function writeSettings(patch) {
			var next = Object.assign({}, currentSettings(), patch);
			settingsCache = next;
			try {
				localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
			} catch (error) {
				/* localStorage 不可用（无痕等）：功能照常，只是设置不持久 */
			}
			settingsStore.set({ version: settingsStore.get().version + 1 });
			return next;
		}

		/** 订阅设置的钩子：设置页改动后按钮立即跟着变。 */
		function useSettings() {
			useStore(settingsStore);
			return currentSettings();
		}
		// #endregion

		// #region ---------- 两个引擎的可用性 ----------
		var synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
		var browserVoices = [];

		/** 宿主引擎与浏览器引擎的可用性读数（设置页展示）。 */
		var hostInfo = createStore({
			status: "unknown",   // unknown | ready | unavailable
			voices: [],
			error: "",
			base: null,
			/** 宿主所在平台：'win32' 才有 winrt / sapi 本机语音；其它平台只能用在线后端。 */
			platform: "",
			diag: null
		});

		/** 重新读取浏览器音色表（Chromium 的 getVoices 首次常为空）。 */
		function refreshBrowserVoices() {
			try {
				browserVoices = synth ? synth.getVoices() || [] : [];
			} catch (error) {
				browserVoices = [];
			}
			return browserVoices;
		}

		/** 进行中的探测：启动时与设置页挂载会各调一次，合流成一次请求。 */
		var probeInFlight = null;

		/**
		 * 探测宿主引擎：按候选前缀逐个试，拿系统语音列表。
		 * 失败时把**每一次**尝试的完整原因（状态码 + 状态文本 + 响应体片段）留在
		 * hostInfo.error 里 —— 排障时一眼能看出是谁应答的。
		 * @returns {Promise<boolean>} 宿主引擎是否可用。
		 */
		function probeHost() {
			if (probeInFlight !== null) return probeInFlight;
			probeInFlight = runProbe();
			var clear = function () { probeInFlight = null; };
			probeInFlight.then(clear, clear);
			return probeInFlight;
		}

		/**
		 * 真正执行一次探测（候选前缀依次尝试）。
		 * @returns {Promise<boolean>} 宿主引擎是否可用。
		 */
		function runProbe() {
			if (typeof fetch !== "function") {
				hostInfo.set({ status: "unavailable", voices: [], error: "no fetch", base: null });
				return Promise.resolve(false);
			}
			var attempts = [];
			/** 试第 index 个候选前缀。 */
			function attempt(index) {
				if (index >= HOST_BASES.length) {
					hostInfo.set({ status: "unavailable", voices: [], error: attempts.join("；"), base: null });
					return Promise.resolve(false);
				}
				var base = HOST_BASES[index];
				return fetch(base + "/voices", { headers: { accept: "application/json" } })
					.then(function (response) {
						if (!response.ok) {
							return response.text().then(function (body) {
								throw new Error("HTTP " + response.status + " " + (response.statusText || "") +
									(body ? " · " + String(body).slice(0, 120) : ""));
							}, function () { throw new Error("HTTP " + response.status); });
						}
						return response.json();
					})
					.then(function (payload) {
						var voices = payload && Array.isArray(payload.voices) ? payload.voices : [];
						hostBase = base;
						hostInfo.set({
							status: "ready",
							voices: voices,
							error: "",
							base: base,
							platform: payload && typeof payload.platform === "string" ? payload.platform : ""
						});
						return true;
					})
					.catch(function (error) {
						var reason = String(error && error.message ? error.message : error);
						attempts.push(base + " → " + reason);
						return attempt(index + 1);
					});
			}
			return attempt(0);
		}

		/**
		 * 拉取宿主诊断信息（日志尾巴）。
		 * @returns {Promise<void>} 完成后写入 hostInfo.diag。
		 */
		function fetchDiag() {
			if (typeof fetch !== "function") return Promise.resolve();
			return fetch(hostBase + "/diag", { headers: { accept: "application/json" } })
				.then(function (response) { return response.ok ? response.json() : null; })
				.then(function (payload) { hostInfo.set({ diag: payload }); })
				.catch(function () { hostInfo.set({ diag: null }); });
		}
		// #endregion

		// #region ---------- 正文提取 ----------
		/**
		 * 把 Markdown 正文压成适合朗读的纯文本。
		 * @param text - 原始 Markdown。
		 * @param keepCode - 为 true 时保留代码内容，否则整块丢弃。
		 * @returns 纯文本。
		 */
		function stripForSpeech(text, keepCode) {
			var out = String(text === undefined || text === null ? "" : text);
			out = out.replace(/```[\s\S]*?```/g, function (block) {
				return keepCode ? " " + block.replace(/```[^\n]*\n?/g, " ").replace(/```/g, " ") + " " : " ";
			});
			out = out.replace(/~~~[\s\S]*?~~~/g, " ");
			out = out.replace(/`([^`]*)`/g, "$1");
			out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
			out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
			out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
			out = out.replace(/^\s{0,3}>\s?/gm, "");
			out = out.replace(/^\s{0,3}[-*+]\s+/gm, "");
			out = out.replace(/^\s{0,3}\d+[.)]\s+/gm, "");
			out = out.replace(/^\s*\|?[\s:|-]{4,}\|?\s*$/gm, " ");
			out = out.replace(/\|/g, " ");
			out = out.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1");
			out = out.replace(/<[^>]+>/g, " ");
			out = out.replace(/https?:\/\/\S+/g, " ");
			out = out.replace(/[ \t\u00a0]+/g, " ");
			out = out.replace(/[ \t]*\n[ \t]*/g, "\n");
			out = out.replace(/\n{2,}/g, "\n");
			return out.trim();
		}

		/**
		 * 取一段助手内容块里的可见正文。
		 * @param blocks - 助手内容块数组（只有 kind === 'text' 的块是正文）。
		 * @returns 拼接后的正文。
		 */
		function assistantTextOf(blocks) {
			if (!Array.isArray(blocks)) return "";
			var parts = [];
			for (var i = 0; i < blocks.length; i++) {
				var block = blocks[i];
				if (block && block.kind === "text" && typeof block.text === "string") parts.push(block.text);
			}
			return parts.join("");
		}

		/**
		 * 从一个 turn-tail 节点的 data 里取出 (messageId, 正文)。
		 * @param data - turn-tail 节点的 data（Map）。
		 * @param keepCode - 是否保留代码块。
		 * @returns { id, text }；取不到时返回 null。
		 */
		function readTurnTail(data, keepCode) {
			if (!data || typeof data.get !== "function") return null;
			var tail = data.get("turn-tail");
			var closing = tail && tail.closing;
			var finalNode = closing && closing.finalNode;
			var id = finalNode && finalNode.messageId;
			if (!id) return null;
			return { id: id, text: stripForSpeech(assistantTextOf(closing.blocks), keepCode) };
		}

		/**
		 * 快照级缓存：messageId → 朗读文本（WeakMap 按快照对象缓存，一次流式更新只遍历一遍）。
		 * 缓存记录 keepCode，设置页切换「朗读代码块」后自动重建。
		 */
		var TEXT_INDEX = new WeakMap();

		/**
		 * 构建（或复用）某份聊天快照的 messageId → 朗读文本索引。
		 * @param snapshot - useChat 给出的聊天快照。
		 * @param keepCode - 是否保留代码块。
		 * @returns Map；快照不可用时返回 null。
		 */
		function textIndex(snapshot, keepCode) {
			if (!snapshot || typeof snapshot !== "object") return null;
			var cached = TEXT_INDEX.get(snapshot);
			if (cached && cached.keepCode === keepCode) return cached.map;
			var index = new Map();
			try {
				var timeline = snapshot.timeline;
				var turns = timeline && timeline.turns;
				if (turns && typeof turns.forEach === "function") {
					turns.forEach(function (turn) {
						var found = readTurnTail(turn && turn.data, keepCode);
						if (found && !index.has(found.id)) index.set(found.id, found.text);
					});
				}
			} catch (error) {
				/* 快照字段形状不匹配：交给下面的节点扫描与 DOM 回退 */
			}
			if (index.size === 0 && snapshot.nodes && typeof snapshot.nodes.forEach === "function") {
				try {
					snapshot.nodes.forEach(function (node) {
						var found = readTurnTail(node && node.data, keepCode);
						if (found && !index.has(found.id)) index.set(found.id, found.text);
					});
				} catch (error) {
					/* 同上：保持空索引，点击时走 DOM 回退 */
				}
			}
			TEXT_INDEX.set(snapshot, { keepCode: keepCode, map: index });
			return index;
		}

		/**
		 * 兜底：从 DOM 取正文 —— 朗读按钮所在的 turn-tail 块，它前面的兄弟块就是正文区。
		 * @param element - 朗读按钮的 DOM 节点。
		 * @param keepCode - 是否保留代码块。
		 * @returns 纯文本；取不到时为空串。
		 */
		function domFallbackText(element, keepCode) {
			try {
				var root = element && element.closest ? element.closest("[data-turn-tail]") : null;
				var cursor = root ? root.previousElementSibling : null;
				while (cursor) {
					var text = (cursor.innerText || cursor.textContent || "").trim();
					if (text) return stripForSpeech(text, keepCode);
					cursor = cursor.previousElementSibling;
				}
			} catch (error) {
				/* DOM 结构不匹配：返回空串，调用方提示无正文 */
			}
			return "";
		}
		// #endregion

		// #region ---------- 播放状态机 ----------
		/** 播放状态：messageId 非空且 status === 'playing' 表示正在念这一条。 */
		var playState = createStore({ messageId: null, status: "idle", note: "", noteFor: null });
		var noteTimer = null;

		/** 播放代次与当前资源。token 每次开始/停止都自增，旧回调据此判断自己是否过期。 */
		var playback = {
			token: 0,
			messageId: null,
			text: "",
			mode: null,
			queue: [],
			cursor: 0,
			audio: null,
			objectUrl: null,
			controller: null
		};

		/** 释放当前音频对象与它的 blob URL。 */
		function releaseAudio() {
			if (playback.audio) {
				try { playback.audio.pause(); } catch (error) { /* 已销毁 */ }
				try { playback.audio.src = ""; } catch (error) { /* 已销毁 */ }
				playback.audio = null;
			}
			if (playback.objectUrl) {
				try { URL.revokeObjectURL(playback.objectUrl); } catch (error) { /* 忽略 */ }
				playback.objectUrl = null;
			}
		}

		/**
		 * 结束播放并回到空闲；note 会短暂显示在按钮旁。
		 * @param note - 可选的提示文案。
		 * @param noteFor - 提示归属的 messageId；不传则用当前播放归属。
		 */
		function finishPlayback(note, noteFor) {
			var owner = noteFor === undefined ? playback.messageId : noteFor;
			playback.token += 1;
			playback.queue = [];
			playback.cursor = 0;
			if (playback.controller) {
				try { playback.controller.abort(); } catch (error) { /* 忽略 */ }
				playback.controller = null;
			}
			releaseAudio();
			try { if (synth) synth.cancel(); } catch (error) { /* 忽略 */ }
			if (noteTimer !== null) { clearTimeout(noteTimer); noteTimer = null; }
			playState.set({ messageId: null, status: "idle", note: note || "", noteFor: note ? owner : null });
			if (note) {
				noteTimer = setTimeout(function () {
					noteTimer = null;
					playState.set({ note: "", noteFor: null });
				}, 4000);
			}
		}

		/** 停止当前播放并清空状态（用户再点一次）。 */
		function stopSpeaking() {
			finishPlayback("", null);
		}

		/**
		 * 按句子切段，单段不超过 max 字符。
		 * @param text - 纯文本。
		 * @param max - 单段最大字符数。
		 * @returns 段落数组。
		 */
		function chunkText(text, max) {
			var source = String(text === undefined || text === null ? "" : text);
			var units = source.match(/[^。！？!?.;；\n]+[。！？!?.;；\n]?/g) || [source];
			var out = [];
			var buffer = "";
			for (var i = 0; i < units.length; i++) {
				var piece = units[i].trim();
				if (!piece) continue;
				if ((buffer + piece).length <= max) {
					buffer += piece;
					continue;
				}
				if (buffer) out.push(buffer);
				buffer = "";
				while (piece.length > max) {
					out.push(piece.slice(0, max));
					piece = piece.slice(max);
				}
				buffer = piece;
			}
			if (buffer) out.push(buffer);
			return out;
		}
		// #endregion

		// #region ---------- 宿主引擎播放 ----------
		/**
		 * 用宿主引擎念下一段：POST 合成 → <audio> 播放 → 播完再取下一段。
		 * @param token - 本次播放的代次。
		 * @param settings - 当前设置。
		 */
		function stepHost(token, settings) {
			if (token !== playback.token) return;
			if (playback.cursor >= playback.queue.length) { finishPlayback("", null); return; }
			var piece = playback.queue[playback.cursor];
			playback.cursor += 1;
			var controller = typeof AbortController === "function" ? new AbortController() : null;
			playback.controller = controller;
			fetch(hostBase + "/speak", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text: piece,
					voiceName: settings.voiceName,
					rate: settings.rate,
					volume: settings.volume
				}),
				signal: controller ? controller.signal : undefined
			}).then(function (response) {
				if (!response.ok) {
					return response.json().then(function (payload) {
						throw new Error("HTTP " + response.status + (payload && payload.error ? "：" + payload.error : ""));
					}, function () { throw new Error("HTTP " + response.status); });
				}
				return response.blob();
			}).then(function (blob) {
				if (token !== playback.token) return;
				var url = URL.createObjectURL(blob);
				playback.objectUrl = url;
				var audio = new Audio(url);
				playback.audio = audio;
				audio.onended = function () {
					releaseAudio();
					if (token === playback.token) stepHost(token, settings);
				};
				audio.onerror = function () {
					releaseAudio();
					if (token === playback.token) finishPlayback("音频播放失败", playback.messageId);
				};
				return audio.play().catch(function (error) {
					if (token !== playback.token) return;
					finishPlayback("浏览器拒绝了音频播放：" + String(error && error.message ? error.message : error), playback.messageId);
				});
			}).catch(function (error) {
				if (token !== playback.token) return;
				var reason = String(error && error.message ? error.message : error);
				if (reason.indexOf("abort") >= 0 || reason.indexOf("AbortError") >= 0) return;
				hostInfo.set({ status: "unavailable", voices: hostInfo.get().voices, error: reason });
				// auto：宿主引擎不可用时整条改用浏览器引擎再试一次。
				if (currentSettings().engine === "auto" && synth) {
					startPlayback(playback.messageId, playback.text, currentSettings(), "browser");
					return;
				}
				finishPlayback("宿主语音引擎失败：" + reason, playback.messageId);
			});
		}
		// #endregion

		// #region ---------- 浏览器引擎播放 ----------
		/**
		 * 选浏览器音色：优先用户指定，其次本地中文音色，最后任一中文音色。
		 * @param settings - 当前设置。
		 * @returns 选中的音色；没有中文音色时返回 null。
		 */
		function pickBrowserVoice(settings) {
			refreshBrowserVoices();
			if (!browserVoices.length) return null;
			var want = String(settings.voiceName || "").trim();
			if (want) {
				for (var i = 0; i < browserVoices.length; i++) if (browserVoices[i].name === want) return browserVoices[i];
				for (var j = 0; j < browserVoices.length; j++) {
					if (String(browserVoices[j].name || "").toLowerCase().indexOf(want.toLowerCase()) >= 0) return browserVoices[j];
				}
			}
			var zh = [];
			for (var k = 0; k < browserVoices.length; k++) if (/^zh([-_]|$)/i.test(browserVoices[k].lang || "")) zh.push(browserVoices[k]);
			if (!zh.length) return null;
			for (var m = 0; m < zh.length; m++) if (zh[m].localService) return zh[m];
			return zh[0];
		}

		/**
		 * 开始用浏览器引擎播下一段。
		 * @param token - 本次播放的代次。
		 * @param settings - 当前设置。
		 * @param voice - 已选音色（可为 null）。
		 */
		function stepBrowser(token, settings, voice) {
			if (token !== playback.token) return;
			if (playback.cursor >= playback.queue.length) { finishPlayback("", null); return; }
			var piece = playback.queue[playback.cursor];
			playback.cursor += 1;
			var utterance;
			try {
				utterance = new SpeechSynthesisUtterance(piece);
			} catch (error) {
				finishPlayback("语音合成失败", playback.messageId);
				return;
			}
			if (voice) utterance.voice = voice;
			utterance.lang = voice ? voice.lang : "zh-CN";
			utterance.rate = settings.rate;
			utterance.pitch = settings.pitch;
			utterance.volume = settings.volume;
			var started = false;
			utterance.onstart = function () { started = true; };
			utterance.onend = function () { if (token === playback.token) stepBrowser(token, settings, voice); };
			utterance.onerror = function (event) {
				if (token !== playback.token) return;
				finishPlayback("语音播放中断" + (event && event.error ? "（" + event.error + "）" : ""), playback.messageId);
			};
			try {
				synth.speak(utterance);
			} catch (error) {
				finishPlayback("语音播放失败", playback.messageId);
				return;
			}
			// 看门狗：引擎收下了却不出声（本机 Electron 的典型症状），明确报出来而不是让按钮卡在「播放中」。
			setTimeout(function () {
				if (token !== playback.token || started) return;
				finishPlayback("浏览器语音引擎没有出声（本机 Electron 常见）：请在设置里把引擎换成「宿主」", playback.messageId);
			}, 2000);
		}

		/**
		 * 用浏览器引擎播放整段文本：先 cancel 再延后 speak（Chromium 已知竞态：
		 * cancel() 之后在同一任务里 speak() 会被静默丢弃）。
		 * @param token - 本次播放的代次。
		 * @param settings - 当前设置。
		 */
		function playViaBrowser(token, settings) {
			if (!synth) { finishPlayback("当前环境不支持语音合成", playback.messageId); return; }
			var voice = pickBrowserVoice(settings);
			try { synth.cancel(); } catch (error) { /* 忽略 */ }
			setTimeout(function () {
				if (token !== playback.token) return;
				stepBrowser(token, settings, voice);
			}, 120);
		}
		// #endregion

		// #region ---------- 播放入口 ----------
		/**
		 * 按设置决定用哪个引擎。
		 *
		 * 「自动」在 Windows 上默认走宿主；非 Windows 上宿主**只有在线神经语音**可用
		 * （winrt / sapi 是 Windows 专有），所以只有明确选中在线音色时才走宿主，
		 * 否则直接用浏览器引擎 —— 免得每次都白等一次必然失败的宿主请求。
		 * @param settings - 当前设置。
		 * @returns 'host' | 'browser'。
		 */
		function resolveEngine(settings) {
			if (settings.engine === "browser") return "browser";
			if (settings.engine === "host") return "host";
			var info = hostInfo.get();
			if (!info.platform || info.platform === "win32") return "host";
			var picked = null;
			for (var index = 0; index < info.voices.length; index += 1) {
				if (info.voices[index] && info.voices[index].name === settings.voiceName) { picked = info.voices[index]; break; }
			}
			return picked && picked.backend === "edge" ? "host" : "browser";
		}

		/**
		 * 按设置选择引擎并开始播放。
		 * @param messageId - 归属的消息 id。
		 * @param text - 已去 Markdown 的正文。
		 * @param settings - 当前设置。
		 * @param forced - 强制指定引擎（'host' | 'browser'）；缺省按设置决定。
		 */
		function startPlayback(messageId, text, settings, forced) {
			playback.token += 1;
			var token = playback.token;
			playback.messageId = messageId;
			playback.text = text;
			var engine = forced || resolveEngine(settings);
			playback.mode = engine;
			// 两个引擎共用一条分段队列：宿主引擎逐段要 WAV，浏览器引擎逐段 speak。
			playback.queue = chunkText(text, settings.maxChunk);
			playback.cursor = 0;
			if (!playback.queue.length) { finishPlayback("这条回复没有可朗读的正文", messageId); return; }
			playState.set({ messageId: messageId, status: "playing", note: "", noteFor: null });
			if (engine === "browser") playViaBrowser(token, settings);
			else stepHost(token, settings);
		}

		/**
		 * 朗读一条消息。
		 * @param messageId - 归属的消息 id；试听用 "__preview__"。
		 * @param text - 已去 Markdown 的正文。
		 * @param settings - 当前设置。
		 */
		function speakMessage(messageId, text, settings) {
			stopSpeaking();
			if (!text) { finishPlayback("这条回复没有可朗读的正文", messageId); return; }
			if (settings.engine !== "browser" && hostInfo.get().status === "unknown") probeHost();
			startPlayback(messageId, text, settings);
		}
		// #endregion

		// #region ---------- 图标 ----------
		/** 喇叭图标（未播放）。 */
		function IconSpeaker() {
			return h("svg", {
				viewBox: "0 0 16 16", width: 15, height: 15, fill: "none",
				stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round",
				"aria-hidden": "true", focusable: "false"
			},
				h("path", { d: "M8.2 2.8 4.9 5.5H2.6v5h2.3l3.3 2.7z", fill: "currentColor", stroke: "none" }),
				h("path", { d: "M10.7 5.9a3.1 3.1 0 0 1 0 4.2" }),
				h("path", { d: "M12.7 4a5.7 5.7 0 0 1 0 8" })
			);
		}

		/** 方块停止图标（播放中）。 */
		function IconStop() {
			return h("svg", {
				viewBox: "0 0 16 16", width: 15, height: 15, fill: "currentColor",
				"aria-hidden": "true", focusable: "false"
			}, h("rect", { x: 4.6, y: 4.6, width: 6.8, height: 6.8, rx: 1.4 }));
		}
		// #endregion

		// #region ---------- 消息操作栏按钮 ----------
		var COPY = {
			play: ["朗读这条回复", "Read this reply aloud"],
			stop: ["停止朗读", "Stop reading"],
			empty: ["这条回复没有可朗读的正文", "Nothing to read in this reply"]
		};

		/**
		 * 一条助手回复上的朗读按钮（注册在 conversation.chat.assistant-actions）。
		 * @param props - 槽位 props（含 messageId 与标准工具包）。
		 * @returns 按钮元素（需要时附带一条短暂提示）。
		 */
		function PlayAction(props) {
			var messageId = props.messageId;
			var settings = useSettings();
			var state = useStore(playState);
			var text = useMessageText(props.useChat, messageId, settings.readCode);
			var playing = state.status === "playing" && state.messageId === messageId;
			var buttonRef = React.useRef(null);

			var onToggle = React.useCallback(function () {
				var now = playState.get();
				if (now.status === "playing" && now.messageId === messageId) {
					stopSpeaking();
					return;
				}
				var active = currentSettings();
				var body = text || domFallbackText(buttonRef.current, active.readCode);
				if (!body) {
					finishPlayback(copyFor(COPY.empty), messageId);
					return;
				}
				speakMessage(messageId, body, active);
			}, [messageId, text]);

			var label = playing ? copyFor(COPY.stop) : copyFor(COPY.play);
			var note = state.note && state.noteFor === messageId ? state.note : null;

			return h(React.Fragment, null,
				h("button", {
					ref: buttonRef,
					type: "button",
					className: CSS.action,
					"aria-label": label,
					"aria-pressed": playing,
					title: label,
					"data-active": playing || undefined,
					onClick: onToggle
				}, playing ? h(IconStop, null) : h(IconSpeaker, null)),
				note === null ? null : h("span", { className: CSS.note, role: "status" }, note)
			);
		}

		/**
		 * 订阅某条消息的朗读文本。
		 * @param useChat - 槽位的聊天快照选择器钩子（可能缺省）。
		 * @param messageId - 目标消息 id。
		 * @param keepCode - 是否保留代码块。
		 * @returns 朗读文本；取不到时为空串。
		 */
		function useMessageText(useChat, messageId, keepCode) {
			var text = typeof useChat === "function"
				? useChat(function (snapshot) {
					var index = textIndex(snapshot, keepCode);
					return index ? index.get(messageId) || "" : "";
				})
				: "";
			return typeof text === "string" ? text : "";
		}

		/**
		 * 找当前会话里「最近一条已结束回合」的助手回复 messageId。
		 *
		 * 结束判据用 `turn.end`（回合结束标记）：流式进行中的回合没有它，所以不会把半截
		 * 回复当成「任务完成」播出去。
		 * @param snapshot - useChat 给出的聊天快照。
		 * @returns messageId；没有已结束的回复时返回空串。
		 */
		function newestClosedReplyId(snapshot) {
			if (!snapshot || typeof snapshot !== "object") return "";
			var turns = snapshot.timeline && snapshot.timeline.turns;
			if (!turns || typeof turns.forEach !== "function") return "";
			var newestSeq = -1;
			var newestId = "";
			try {
				turns.forEach(function (turn) {
					if (!turn || turn.end === undefined || turn.end === null) return;
					var data = turn.data;
					var tail = data && typeof data.get === "function" ? data.get("turn-tail") : null;
					var closing = tail && tail.closing;
					var finalNode = closing && closing.finalNode;
					if (!finalNode || !finalNode.messageId) return;
					var seq = typeof finalNode.seq === "number" ? finalNode.seq : 0;
					if (seq >= newestSeq) { newestSeq = seq; newestId = finalNode.messageId; }
				});
			} catch (error) {
				return "";
			}
			return newestId;
		}

		/**
		 * 自动播报监听器（注册在 conversation.input.overlay，渲染 null）。
		 *
		 * 只在**当前会话**里工作：作曲区在哪个会话，这里就在哪个会话。首次渲染把已有历史
		 * 记为基线且**不播报**，所以刷新页面、切设置页都不会把旧回复念一遍。
		 * @param props - 槽位 props（含 useChat）。
		 * @returns null（纯监听，不渲染任何东西）。
		 */
		function AutoReadWatcher(props) {
			var settings = useSettings();
			var useChat = props.useChat;
			var newestId = typeof useChat === "function"
				? useChat(function (snapshot) { return newestClosedReplyId(snapshot); })
				: "";
			var id = typeof newestId === "string" ? newestId : "";
			var text = useMessageText(useChat, id, settings.readCode);
			var seen = React.useRef("");
			var primed = React.useRef(false);

			React.useEffect(function () {
				if (!primed.current) {
					// 首次渲染只记录基线：历史里已有的回复不播报。
					primed.current = true;
					seen.current = id;
					return;
				}
				if (id === seen.current) return;
				seen.current = id;
				if (id === "" || !settings.autoRead || !text) return;
				speakMessage(id, text, currentSettings());
			}, [id, text, settings.autoRead]);

			return null;
		}
		// #endregion

		// #region ---------- 设置页 ----------
		var ENGINE_LABELS = [
			["auto", "自动（优先宿主，失败退浏览器）"],
			["host", "宿主（系统 SAPI，推荐）"],
			["browser", "浏览器（Web Speech API）"]
		];

		/**
		 * 设置 → 插件 → 「语音播放」标签页。
		 * @returns 设置卡片元素。
		 */
		function SettingsTab() {
			var settings = useSettings();
			var playing = useStore(playState);
			var host = useStore(hostInfo);
			var voicePair = React.useState([]);
			var voiceList = voicePair[0];
			var setVoiceList = voicePair[1];

			// 进设置页就探一次宿主引擎，并顺手拉一份诊断日志。
			React.useEffect(function () {
				probeHost().then(fetchDiag);
			}, []);

			React.useEffect(function () {
				/** 浏览器音色表异步就绪：就绪后再取一次。 */
				function reload() {
					var all = refreshBrowserVoices();
					var kept = [];
					for (var i = 0; i < all.length; i++) {
						if (/^zh([-_]|$)/i.test(all[i].lang || "")) kept.push(all[i]);
					}
					setVoiceList(kept.length ? kept : all.slice());
				}
				reload();
				try { if (synth && synth.addEventListener) synth.addEventListener("voiceschanged", reload); } catch (error) { /* 忽略 */ }
				return function () {
					try { if (synth && synth.removeEventListener) synth.removeEventListener("voiceschanged", reload); } catch (error) { /* 忽略 */ }
				};
			}, []);

			/** 试听。 */
			var onTest = React.useCallback(function () {
				speakMessage("__preview__", "你好，这是一段朗读试听。点回复下面的喇叭按钮，就能把整条回复念出来。", currentSettings());
			}, []);

			/** 一行「标签 + 控件」。 */
			function row(label, node) {
				return h("div", { className: CSS.row },
					h("span", { className: CSS.label }, label),
					node
				);
			}

			/** 滑块。 */
			function slider(key, min, max, step) {
				return h("input", {
					type: "range", min: min, max: max, step: step,
					value: settings[key],
					"aria-label": key,
					onChange: function (event) {
						var patch = {};
						patch[key] = Number(event.target.value);
						writeSettings(patch);
					}
				});
			}

			/** 开关。 */
			function toggle(key) {
				var next = {};
				next[key] = !settings[key];
				return h("button", {
					type: "button",
					className: CSS.switch + (settings[key] ? " " + CSS.switchOn : ""),
					"aria-pressed": settings[key] === true,
					onClick: function () { writeSettings(next); }
				}, settings[key] ? "开" : "关");
			}

			// 音色选项：宿主引擎已就绪就用系统语音（两个后端合并），否则退浏览器音色表。
			var GENDER_LABEL = { Female: "女", Male: "男" };
			var BACKEND_LABEL = { winrt: "本机", sapi: "本机SAPI", edge: "Edge在线" };
			var options = [];
			if (host.status === "ready" && host.voices.length) {
				for (var i = 0; i < host.voices.length; i++) {
					var hostVoice = host.voices[i];
					var tags = [hostVoice.culture];
					if (GENDER_LABEL[hostVoice.gender]) tags.push(GENDER_LABEL[hostVoice.gender]);
					if (BACKEND_LABEL[hostVoice.backend]) tags.push(BACKEND_LABEL[hostVoice.backend]);
					options.push({ value: hostVoice.name, label: hostVoice.name + "（" + tags.join("·") + "）" });
				}
			} else {
				for (var j = 0; j < voiceList.length; j++) {
					options.push({ value: voiceList[j].name, label: voiceList[j].name + "（" + voiceList[j].lang + "）" });
				}
			}

			var hostStatusText = host.status === "ready"
				? "宿主引擎可用（" + (host.base || hostBase) + "），系统语音 " + host.voices.length + " 个"
				: (host.status === "unavailable" ? "宿主引擎不可用：" + (host.error || "未知原因") : "宿主引擎未探测");
			var browserStatusText = synth === null ? "浏览器引擎不可用（本环境没有 speechSynthesis）" : "浏览器引擎存在，音色 " + voiceList.length + " 个";
			var playStatusText = playing.status === "playing" ? "正在朗读" : "空闲";

			return h("div", { className: CSS.card },
				h("div", { className: CSS.head },
					h("div", { className: CSS.text },
						h("div", { className: CSS.title }, "语音播放（回复朗读） v" + PLUGIN_VERSION),
						h("div", { className: CSS.desc }, "助手回复下面的喇叭按钮：点一下把这条回复念出来，再点一下停止")
					),
					h("button", {
						type: "button",
						className: CSS.test,
						onClick: onTest
					}, "试听")
				),
				h("div", { className: CSS.body },
					row("引擎", h("select", {
						className: CSS.select,
						value: settings.engine,
						"aria-label": "引擎",
						onChange: function (event) { writeSettings({ engine: event.target.value }); }
					}, ENGINE_LABELS.map(function (entry) {
						return h("option", { key: entry[0], value: entry[0] }, entry[1]);
					}))),
					row("音色", h("select", {
						className: CSS.select,
						value: settings.voiceName,
						"aria-label": "音色",
						onChange: function (event) { writeSettings({ voiceName: event.target.value }); }
					},
						h("option", { value: "" }, "自动（优先中文）"),
						options.map(function (option) {
							return h("option", { key: option.value, value: option.value }, option.label);
						})
					)),
					row("语速 " + Number(settings.rate).toFixed(1) + "×", slider("rate", 0.5, 2, 0.1)),
					row("音量 " + Math.round(settings.volume * 100) + "%", slider("volume", 0, 1, 0.05)),
					row("单段字数", h("input", {
						className: CSS.number,
						type: "number", min: 40, max: 600, step: 10,
						value: settings.maxChunk,
						"aria-label": "单段字数",
						onChange: function (event) {
							writeSettings({ maxChunk: Math.round(clamp(Number(event.target.value), 40, 600)) });
						}
					})),
					row("朗读代码块", toggle("readCode")),
					row("音调（仅浏览器引擎）", slider("pitch", 0, 2, 0.05)),
					row("完成后自动播报", toggle("autoRead"))
				),
				h("div", { className: CSS.body },
					row("播放状态", h("span", { className: CSS.hint }, playStatusText)),
					row("宿主引擎", h("span", { className: CSS.hint }, hostStatusText)),
					row("浏览器引擎", h("span", { className: CSS.hint }, browserStatusText)),
					h("div", { className: CSS.row },
						h("span", { className: CSS.label }, "诊断"),
						h("button", {
							type: "button",
							className: CSS.test,
							onClick: function () { probeHost().then(fetchDiag); }
						}, "重新探测")
					),
					host.diag && host.diag.log && host.diag.log.length
						? h("pre", { className: CSS.log }, host.diag.log.slice(-6).join("\n"))
						: h("div", { className: CSS.hint }, "暂无宿主日志"),
					h("div", { className: CSS.hint },
						"宿主引擎用系统 SAPI 合成（Windows「设置 → 时间和语言 → 语音」可装更多中文语音）；浏览器引擎用 Web Speech API，音色随浏览器而定。设置保存在本机，改动即时生效。")
				)
			);
		}
		// #endregion

		// #region ---------- 样式 ----------
		var CSS_ID = "dsh-client-voice-play/voice-play.css";
		var CSS_SOURCE = [
			".vp_action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}",
			".vp_action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}",
			".vp_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".vp_action[data-active]{color:var(--dsw-alias-state-business-primary)}",
			".vp_note{color:var(--dsw-alias-label-tertiary);padding-left:4px;font-size:13px;line-height:20px}",
			".vp_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;flex-direction:column;padding:16px;display:flex;gap:12px}",
			".vp_head{justify-content:space-between;align-items:center;gap:16px;display:flex}",
			".vp_text{flex-direction:column;gap:2px;min-width:0;display:flex}",
			".vp_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}",
			".vp_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".vp_body{flex-direction:column;gap:8px;display:flex}",
			".vp_row{align-items:center;gap:10px;min-height:28px;display:flex}",
			".vp_label{width:130px;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".vp_row input[type=range]{min-width:0;flex:1;accent-color:var(--dsw-alias-state-business-primary)}",
			".vp_number{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);width:72px;height:26px;color:var(--dsw-alias-label-primary);text-align:right;border-radius:8px;padding:0 6px;font-size:12px}",
			".vp_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);height:28px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 8px;font-size:12px;min-width:0;flex:1}",
			".vp_switch{border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border-radius:14px;flex:none;align-items:center;gap:6px;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}",
			".vp_switchOn{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);border-color:transparent}",
			".vp_test{border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border-radius:14px;padding:0 14px;font-size:12px}",
			".vp_test:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".vp_test:disabled{cursor:default;opacity:.4}",
			".vp_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".vp_log{margin:0;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow:auto}"
		].join("");

		/** 类名表：与上面的样式一一对应。 */
		var CSS = {
			action: "vp_action",
			note: "vp_note",
			card: "vp_card",
			head: "vp_head",
			text: "vp_text",
			title: "vp_title",
			desc: "vp_desc",
			body: "vp_body",
			row: "vp_row",
			label: "vp_label",
			number: "vp_number",
			select: "vp_select",
			switch: "vp_switch",
			switchOn: "vp_switchOn",
			test: "vp_test",
			hint: "vp_hint",
			log: "vp_log"
		};

		/** 注入样式（同一 id 只注入一次，HMR 重载不会重复堆叠）。 */
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") !== null) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-client-voice-play";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS_SOURCE;
			document.head.appendChild(tag);
		}
		// #endregion

		// #region ---------- 插件主体 ----------
		/** 本插件需要的服务：槽位注册表。 */
		var inject = ["slots"];

		/**
		 * 浏览器插件主体。
		 * @param ctx - 客户端 cordis 上下文（含 ctx.slots）。
		 */
		function apply(ctx) {
			injectCss();

			refreshBrowserVoices();
			try { if (synth && synth.addEventListener) synth.addEventListener("voiceschanged", refreshBrowserVoices); } catch (error) { /* 忽略 */ }
			probeHost();

			// 1) 助手回复操作栏里的朗读按钮（与复制 / 点赞 / 分支同一行）。
			ctx.slots.inject("conversation.chat.assistant-actions", function () {
				return ctx.slots.register({
					name: "conversation.chat.assistant-actions",
					id: "voice-play",
					order: 5,
					registrant: "dsh-client-voice-play"
				}, PlayAction);
			});

			// 2) 自动播报监听器：挂在作曲区里（每会话一份，渲染 null）。
			//    放在这里而不是聊天区，是因为它需要「当前会话」这个语义 —— 作曲区在哪个
			//    会话，监听的就是哪个会话，不会替后台会话乱播。
			ctx.slots.inject("conversation.input.overlay", function () {
				return ctx.slots.register({
					name: "conversation.input.overlay",
					id: "voice-play-auto",
					order: 90,
					registrant: "dsh-client-voice-play"
				}, AutoReadWatcher);
			});

			// 3) 设置 → 插件 → 「语音播放」。
			ctx.slots.inject("settings.plugins.tab", function () {
				return ctx.slots.register({
					name: "settings.plugins.tab",
					id: "voice-play",
					order: 60,
					label: "语音播放",
					registrant: "dsh-client-voice-play"
				}, SettingsTab);
			});

			// 卸载：停掉朗读、清掉定时器。
			ctx.effect(function () {
				return function () {
					stopSpeaking();
				};
			}, "dsh-client-voice-play: teardown");
		}
		// #endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
