/**
 * gemini-web2api — Cloudflare Worker(单文件)
 *
 * 把 Google Gemini 网页版的 StreamGenerate 协议转换成 OpenAI 兼容的 API。
 * 这是 Python 版 `gemini_web2api` 包的 JS 移植,改写为 Cloudflare Workers /
 * Web Fetch 运行时(不依赖 Node,不依赖标准库)。
 *
 * 接口:
 *   OpenAI:      GET  /v1/models
 *                POST /v1/chat/completions
 *                POST /v1/responses                       (Codex CLI)
 *   Google CLI:  GET  /v1beta/models
 *                POST /v1beta/models/{model}:generateContent
 *                POST /v1beta/models/{model}:streamGenerateContent
 *
 * 部署:把这个单文件粘贴到 Cloudflare 后台
 * (Workers & Pages → Create → 粘贴 → Deploy),或执行 `wrangler deploy`。
 * 不需要 wrangler.toml 的 [vars] 或 secrets —— 改下面的 CONFIG 即可。
 *
 * 配置:编辑本文件顶部的 CONFIG 对象。每个键也都可以用同名的 Worker
 * 环境变量 / secret 覆盖(GEMINI_COOKIE / API_KEYS 建议用 secret,避免提交进仓库):
 *   GEMINI_COOKIE        完整 cookie 字符串,或 JSON {"cookie": "...", "sapisid": "..."}
 *   SAPISID              可选,显式指定 SAPISID(否则从 cookie 自动提取)
 *   API_KEYS             逗号分隔的列表或 JSON 数组;为空 = 不鉴权
 *   GEMINI_BL            Gemini 网页版构建号(会随时间变化)
 *   GEMINI_ORIGIN        上游源站;部署被 Google 429 限流时,指向干净 IP 的反向代理
 *   UPSTREAM_SOCKET      true/false;true=上游优先用裸 socket(绕开 fetch 的 429)
 *   DEFAULT_MODEL        默认模型名
 *   RETRY_ATTEMPTS / RETRY_DELAY_SEC / REQUEST_TIMEOUT_SEC   整数
 *   LOG_REQUESTS         true/false
 *
 * 限制:图片/多模态输入需要登录态 —— 设置了 GEMINI_COOKIE 时,图片会经 Scotty
 * 上传到 Gemini 再绑进会话;未设置 cookie 时图片会被忽略(匿名带图会被后端以
 * 1100 拒绝),并在 prompt 里加一句提示。`gemini-3.1-pro` 也只有带付费账号 cookie
 * 时才会真正路由到 Pro,否则回退到 Flash。
 */

const VERSION = "1.1.1-worker";

// ════════════════════════════════════════════════════════════════════════════
//  CONFIG —— 改这些值,然后直接部署本文件。
//  若设置了同名的 Worker 环境变量 / secret,会覆盖这里的值;不设则用此处的值。
// ════════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // 调用方必须携带的密钥(Authorization: Bearer <key> 或 x-api-key: <key>)。
  // 空数组 = 不鉴权(任何知道地址的人都能调用)。
  API_KEYS: [],

  // Gemini cookie。匿名访问对所有模型都可用,唯独真正的 Pro 路由需要它。
  // 原始 cookie 字符串,例如:
  //   "SID=...; HSID=...; SSID=...; APISID=...; SAPISID=...; __Secure-1PSID=..."
  // 匿名就留空 ""。(出于安全考虑,建议把它设为 Worker secret。)
  GEMINI_COOKIE: "",
  SAPISID: "", // 可选;留空则自动从上面的 cookie 中提取

  // Gemini 网页版构建号。如果返回开始变空,去 gemini.google.com 页面源码里
  // 找一个新的值("boq_assistant-bard-web-server_...")。
  // Upstream: Sophomoresty/gemini-web2api@fbd5dde (update gemini_bl to 20260716.08_p0)
  // https://github.com/Sophomoresty/gemini-web2api/commit/fbd5ddefcf9423575d0d9bede9b4a2ae994d1464
  GEMINI_BL: "boq_assistant-bard-web-server_20260716.08_p0",

  // 上游源站。默认直连 gemini.google.com。若部署在 Cloudflare/无服务器平台
  // 被 Google 以 429 限流(出口 IP 被拦),把它指向一个跑在“干净 IP”上的反向
  // 代理(转发到 gemini.google.com 并保留 Host/Origin),即可绕开。例:
  //   GEMINI_ORIGIN = "https://your-relay.example.com"
  GEMINI_ORIGIN: "https://gemini.google.com",

  // 上游请求是否优先用裸 socket(cloudflare:sockets)绕开 fetch 的 429 限流。
  // true=优先 socket,不可用/失败再回退 fetch;false=只用 fetch。
  UPSTREAM_SOCKET: true,

  // Upstream: Sophomoresty/gemini-web2api@d227668 (Google mode 1 now serves 3.6 Flash)
  // https://github.com/Sophomoresty/gemini-web2api/commit/d227668e4e53a819ab0e42b8b7da1d912d3c8438
  DEFAULT_MODEL: "gemini-3.6-flash",
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_SEC: 2,
  REQUEST_TIMEOUT_SEC: 180,
  LOG_REQUESTS: true,
};

// ─── 模型 ────────────────────────────────────────────────────────────────
// MODE_CATEGORY 枚举(来自 Gemini 前端 JS):
//   1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE
// Upstream models list: Sophomoresty/gemini-web2api@d227668 / @e12c4ef
// https://github.com/Sophomoresty/gemini-web2api/commit/d227668e4e53a819ab0e42b8b7da1d912d3c8438
// https://github.com/Sophomoresty/gemini-web2api/commit/e12c4ef3548db63c7381449aa00101fb65fae08e
const MODELS = {
  "gemini-3.6-flash": { mode: 1, think: 4, desc: "Latest all-around model (Gemini 3.6 Flash)" },
  "gemini-3.5-flash": { mode: 1, think: 4, desc: "Alias for gemini-3.6-flash (backend upgraded)" },
  "gemini-3.5-flash-thinking": { mode: 2, think: 0, desc: "Deep thinking mode, longest output (~20k chars)" },
  "gemini-3.1-pro": { mode: 3, think: 4, desc: "Pro model (requires cookie for real routing)" },
  "gemini-3.1-pro-enhanced": { mode: 3, think: 4, extra: { 31: 2, 80: 3 }, desc: "Pro with enhanced output (experimental)" },
  "gemini-auto": { mode: 4, think: 4, desc: "Auto model selection" },
  "gemini-3.5-flash-thinking-lite": { mode: 5, think: 0, desc: "Dynamic thinking with adaptive depth" },
  "gemini-flash-lite": { mode: 6, think: 4, desc: "Lightweight fast model" },
};

/**
 * 把模型名解析成路由参数。
 * 未知名称会回退到 `def` 而不是报错(客户端可能传任意 id)。
 * 支持 `@think=N` 后缀来覆盖思考深度。
 * 返回 { name, modeId, thinkMode, extra },或 { error }。
 */
function resolveModel(modelName, def) {
  let thinkOverride = null;
  if (modelName.includes("@think=")) {
    const idx = modelName.lastIndexOf("@think=");
    const thinkStr = modelName.slice(idx + "@think=".length);
    modelName = modelName.slice(0, idx);
    if (!/^-?\d+$/.test(thinkStr)) return { error: `Invalid think level: ${thinkStr}` };
    thinkOverride = parseInt(thinkStr, 10);
  }
  let cfg = MODELS[modelName];
  if (!cfg) {
    modelName = def;
    cfg = MODELS[def];
  }
  return {
    name: modelName,
    modeId: cfg.mode,
    thinkMode: thinkOverride !== null ? thinkOverride : cfg.think,
    extra: cfg.extra || null,
  };
}

// ─── 配置 ──────────────────────────────────────────────────────────────────
function parseBool(v, def) {
  if (v === undefined || v === null || v === "") return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function parseIntDefault(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function parseApiKeys(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  v = String(v).trim();
  if (v.startsWith("[")) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.map(String);
    } catch (_) { /* 继续往下走 */ }
  }
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

// 当 env[key] 设置了非空值时返回它,否则返回内嵌的默认值。
function envOr(env, key, fallback) {
  const v = env[key];
  return v !== undefined && v !== null && v !== "" ? v : fallback;
}

function getConfig(env) {
  env = env || {};
  let cookie = envOr(env, "GEMINI_COOKIE", CONFIG.GEMINI_COOKIE) || "";
  let sapisid = envOr(env, "SAPISID", CONFIG.SAPISID) || "";
  if (cookie && cookie.trim().startsWith("{")) {
    // JSON 形式:{"cookie": "...", "sapisid": "..."}
    try {
      const o = JSON.parse(cookie);
      cookie = o.cookie || "";
      if (!sapisid) sapisid = o.sapisid || "";
    } catch (_) { /* 当作原始字符串处理 */ }
  }
  if (cookie && !sapisid) {
    const m = /(?:^|;\s*)SAPISID=([^;]+)/.exec(cookie);
    if (m) sapisid = m[1];
  }
  return {
    gemini_bl: envOr(env, "GEMINI_BL", CONFIG.GEMINI_BL),
    gemini_origin: String(envOr(env, "GEMINI_ORIGIN", CONFIG.GEMINI_ORIGIN)).replace(/\/$/, ""),
    upstream_socket: parseBool(envOr(env, "UPSTREAM_SOCKET", CONFIG.UPSTREAM_SOCKET), true),
    default_model: envOr(env, "DEFAULT_MODEL", CONFIG.DEFAULT_MODEL),
    retry_attempts: parseIntDefault(envOr(env, "RETRY_ATTEMPTS", CONFIG.RETRY_ATTEMPTS), 3),
    retry_delay_sec: parseIntDefault(envOr(env, "RETRY_DELAY_SEC", CONFIG.RETRY_DELAY_SEC), 2),
    request_timeout_sec: parseIntDefault(envOr(env, "REQUEST_TIMEOUT_SEC", CONFIG.REQUEST_TIMEOUT_SEC), 180),
    log_requests: parseBool(envOr(env, "LOG_REQUESTS", CONFIG.LOG_REQUESTS), true),
    api_keys: parseApiKeys(envOr(env, "API_KEYS", CONFIG.API_KEYS)),
    cookie,
    sapisid,
  };
}

// ─── 小工具 ──────────────────────────────────────────────────────────────────
function log(cfg, msg) {
  if (cfg && cfg.log_requests) {
    try { console.error(`[gemini-web2api] ${msg}`); } catch (_) {}
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    return AbortSignal.timeout(ms);
  }
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

function randomBytes(n) {
  const arr = new Uint8Array(n);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return arr;
}

/** 生成 `n` 个十六进制字符的随机串(n/2 个随机字节)。 */
function randHex(n) {
  const bytes = randomBytes(Math.ceil(n / 2));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s.slice(0, n);
}

function uuid() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

/** SAPISIDHASH 鉴权头(对 "<ts> <sapisid> <origin>" 做 SHA-1)。 */
async function makeSapisidHash(sapisid) {
  const ts = nowSec();
  const data = new TextEncoder().encode(`${ts} ${sapisid} https://gemini.google.com`);
  const buf = await globalThis.crypto.subtle.digest("SHA-1", data);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `SAPISIDHASH ${ts}_${hex}`;
}

function tokenEst(s) {
  return Math.floor((s ? s.length : 0) / 4);
}

// ─── Gemini StreamGenerate 协议 ────────────────────────────────────────────
/**
 * 构造 f.req 表单体。`inner` 是一个 102 槽的数组,对应 Gemini 网页前端发送的
 * 字段;字段 [79] 用于选择模型(MODE_CATEGORY)。
 */
function buildPayload(prompt, modelId, thinkMode, fileRefs, extra) {
  const inner = new Array(102).fill(null);
  if (fileRefs && fileRefs.length) {
    // 每个上传文件表示为 [[fileRef, 1], filename](格式来自 gemini_webapi,
    // 已实测能被后端接受 —— 详见 test/live-image.mjs 的诊断)。
    const files = fileRefs.map((ref) => [[ref, 1], "image.png"]);
    inner[0] = [prompt, 0, null, files, null, null, 0];
  } else {
    inner[0] = [prompt, 0, null, null, null, null, 0];
  }
  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[thinkMode]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;
  inner[59] = uuid();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modelId;
  if (extra) {
    for (const k of Object.keys(extra)) inner[Number(k)] = extra[k];
  }
  const outer = [null, JSON.stringify(inner)];
  return new URLSearchParams({ "f.req": JSON.stringify(outer) }).toString();
}

function getUrl(cfg) {
  const reqid = nowSec() % 1000000;
  const origin = (cfg.gemini_origin || "https://gemini.google.com").replace(/\/$/, "");
  return (
    origin +
    "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate" +
    `?bl=${encodeURIComponent(cfg.gemini_bl)}&hl=en&_reqid=${reqid}&rt=c`
  );
}

async function buildHeaders(cfg) {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://gemini.google.com",
    "Referer": "https://gemini.google.com/app",
    "X-Same-Domain": "1",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };
  if (cfg.cookie) headers["Cookie"] = cfg.cookie;
  if (cfg.sapisid) headers["Authorization"] = await makeSapisidHash(cfg.sapisid);
  return headers;
}

// ─── Socket 上游(绕开 fetch)──────────────────────────────────────────────────
// Cloudflare Workers 的 fetch 子请求走共享出口、易被 Google 429。改用
// cloudflare:sockets 的 connect() 裸 TCP+TLS 自行拼 HTTP/1.1,出口路径不同,
// 常能避开限流。Node(测试)拿不到该模块 -> resolveConnect() 返回 null -> 回退 fetch。
let _connect; // undefined=未解析, null=不可用, function=可用
async function resolveConnect() {
  if (_connect !== undefined) return _connect;
  try {
    const mod = await import("cloudflare:sockets");
    _connect = mod.connect || null;
  } catch (_) {
    _connect = null;
  }
  return _connect;
}
// 测试注入(Node 用 tls 模拟 connect();传 null 可强制走 fetch)。
function __setConnect(fn) { _connect = fn === undefined ? null : fn; }

function _concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function _findCRLF(buf, from) {
  for (let i = from; i + 1 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10) return i;
  return -1;
}
function _findDoubleCRLF(buf) {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

// 用裸 socket 发一个 HTTP/1.1 请求,返回类 Response 对象:{status, ok, headers, body, text()}。
// body 是已解码(去 chunked、identity 编码)的 ReadableStream<Uint8Array>,支持流式。
async function socketHttp(connect, url, { method = "GET", headers = {}, body, timeoutMs = 180000 } = {}) {
  const u = new URL(url);
  const secure = u.protocol !== "http:";
  const port = u.port ? Number(u.port) : (secure ? 443 : 80);
  const socket = connect({ hostname: u.hostname, port }, { secureTransport: secure ? "on" : "off", allowHalfOpen: false });

  let timer = null;
  if (timeoutMs) timer = setTimeout(() => { try { socket.close(); } catch (_) {} }, timeoutMs);

  const enc = new TextEncoder();
  const bodyBytes = body == null ? null : (typeof body === "string" ? enc.encode(body) : new Uint8Array(body));
  // 自管 Host/Connection/Accept-Encoding(identity 避免 gzip)/Content-Length
  const reqHeaders = { Host: u.hostname, "Accept-Encoding": "identity", Connection: "close" };
  for (const [k, v] of Object.entries(headers)) {
    if (/^(host|connection|accept-encoding|content-length)$/i.test(k)) continue;
    reqHeaders[k] = v;
  }
  if (bodyBytes) reqHeaders["Content-Length"] = String(bodyBytes.length);
  let head = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(reqHeaders)) head += `${k}: ${v}\r\n`;
  head += "\r\n";

  const writer = socket.writable.getWriter();
  await writer.write(enc.encode(head));
  if (bodyBytes) await writer.write(bodyBytes);
  try { writer.releaseLock(); } catch (_) {}

  const reader = socket.readable.getReader();
  let buf = new Uint8Array(0);
  let he = -1;
  while (he < 0) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = _concatBytes(buf, value);
    he = _findDoubleCRLF(buf);
  }
  if (he < 0) { if (timer) clearTimeout(timer); throw new Error("socket: incomplete HTTP response headers"); }
  const headerText = new TextDecoder().decode(buf.slice(0, he));
  let pending = buf.slice(he + 4);
  const hlines = headerText.split("\r\n");
  const status = parseInt((hlines[0] || "").split(" ")[1], 10) || 0;
  const respHeaders = new Headers();
  for (let i = 1; i < hlines.length; i++) {
    const c = hlines[i].indexOf(":");
    if (c > 0) { try { respHeaders.append(hlines[i].slice(0, c).trim(), hlines[i].slice(c + 1).trim()); } catch (_) {} }
  }
  const chunked = /chunked/i.test(respHeaders.get("transfer-encoding") || "");
  const clen = respHeaders.has("content-length") ? parseInt(respHeaders.get("content-length"), 10) : null;

  const stream = new ReadableStream({
    async start(controller) {
      const pull = async () => {
        const { done, value } = await reader.read();
        if (done) return false;
        pending = _concatBytes(pending, value);
        return true;
      };
      try {
        if (chunked) {
          for (;;) {
            let nl = _findCRLF(pending, 0);
            while (nl < 0) { if (!(await pull())) { controller.close(); return; } nl = _findCRLF(pending, 0); }
            const size = parseInt(new TextDecoder().decode(pending.slice(0, nl)).trim().split(";")[0], 16);
            pending = pending.slice(nl + 2);
            if (!size || Number.isNaN(size)) { controller.close(); return; } // 末块 0
            while (pending.length < size + 2) { if (!(await pull())) break; }
            controller.enqueue(pending.slice(0, size));
            pending = pending.slice(size + 2); // 跳过块尾 \r\n
          }
        } else if (clen != null) {
          let got = 0;
          if (pending.length) { const t = pending.slice(0, clen); controller.enqueue(t); got += t.length; pending = pending.slice(t.length); }
          while (got < clen) { const { done, value } = await reader.read(); if (done) break; const need = clen - got; const t = value.length > need ? value.slice(0, need) : value; controller.enqueue(t); got += t.length; }
          controller.close();
        } else {
          if (pending.length) controller.enqueue(pending);
          for (;;) { const { done, value } = await reader.read(); if (done) break; controller.enqueue(value); }
          controller.close();
        }
      } catch (e) {
        controller.error(e);
      } finally {
        if (timer) clearTimeout(timer);
        try { reader.releaseLock(); } catch (_) {}
        try { socket.close(); } catch (_) {}
      }
    },
    cancel() { if (timer) clearTimeout(timer); try { socket.close(); } catch (_) {} },
  });

  const res = { status, ok: status >= 200 && status < 300, headers: respHeaders, body: stream };
  res.text = async () => {
    const r = stream.getReader();
    let acc = new Uint8Array(0);
    for (;;) { const { done, value } = await r.read(); if (done) break; acc = _concatBytes(acc, value); }
    return new TextDecoder().decode(acc);
  };
  return res;
}

// 统一上游入口:socket 优先,失败/不可用则回退 fetch。返回类 Response 对象。
async function httpFetch(url, { method = "GET", headers = {}, body, timeoutMs = 180000, socket = true } = {}) {
  if (socket) {
    const connect = await resolveConnect();
    if (connect) {
      try {
        return await socketHttp(connect, url, { method, headers, body, timeoutMs });
      } catch (e) {
        // socket 连接层失败(非 HTTP 错误)-> 回退 fetch
      }
    }
  }
  return fetch(url, { method, headers, body, signal: timeoutSignal(timeoutMs) });
}

// ─── 多模态:图片上传(Scotty 续传)───────────────────────────────────────────
// 说明:图片输入需要登录态(GEMINI_COOKIE)。匿名会话上传文件能成功,但带图
// 生成会被后端以 BardErrorInfo[1100] 拒绝(权限门)。无 cookie 时不上传,
// 改为在 prompt 里追加一句提示,降级为纯文本。详见 test/live-image.mjs。

const _UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
let _pageTokens = { tokens: null, ts: 0 };

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 解析 OpenAI image_url:data:URL(base64)或 http(s) URL。返回 {b64,mime} 或 {url} 或 null。
function parseImageUrl(url) {
  if (!url || typeof url !== "string") return null;
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (m) return { b64: m[2], mime: m[1] || "image/png" };
  if (/^https?:\/\//.test(url)) return { url };
  return null;
}

// 抓取 gemini.google.com/app 页面里的上传 token(带 10 分钟缓存)。
async function getPageTokens(cfg) {
  const now = Date.now();
  if (_pageTokens.tokens && now - _pageTokens.ts < 600000) return _pageTokens.tokens;
  const headers = { "User-Agent": _UA };
  if (cfg.cookie) headers["Cookie"] = cfg.cookie;
  const tokens = {};
  try {
    const resp = await httpFetch(`${cfg.gemini_origin || "https://gemini.google.com"}/app`, { headers, timeoutMs: 30000, socket: cfg.upstream_socket });
    const html = await resp.text();
    for (const [k, re] of [["push_id", /"qKIAYe":"([^"]+)"/], ["pctx", /"Ylro7b":"([^"]+)"/]]) {
      const mm = re.exec(html);
      if (mm) tokens[k] = mm[1];
    }
  } catch (e) {
    /* 用默认值兜底 */
  }
  _pageTokens = { tokens, ts: now };
  return tokens;
}

// Scotty 续传上传一张图,返回文件引用(形如 "/contrib_service/ttl_1d/...")。
async function uploadImage(cfg, bytes, mime) {
  const tokens = await getPageTokens(cfg);
  const pushId = tokens.push_id || "feeds/mcudyrk2a4khkz";
  const pctx = tokens.pctx || "CgcSBWjK7pYx";

  const startHeaders = {
    "Push-ID": pushId,
    "X-Tenant-Id": "bard-storage",
    "X-Client-Pctx": pctx,
    "X-Goog-Upload-Header-Content-Length": String(bytes.length),
    "X-Goog-Upload-Header-Content-Type": mime,
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    "User-Agent": _UA,
  };
  if (cfg.cookie) startHeaders["Cookie"] = cfg.cookie;
  if (cfg.sapisid) startHeaders["Authorization"] = await makeSapisidHash(cfg.sapisid);

  const r1 = await httpFetch("https://content-push.googleapis.com/upload/", { method: "POST", headers: startHeaders, body: "", timeoutMs: 30000, socket: cfg.upstream_socket });
  const uploadUrl = r1.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error(`no upload URL (status ${r1.status})`);

  const r2 = await httpFetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Type": "application/octet-stream", "User-Agent": _UA },
    body: bytes,
    timeoutMs: 60000,
    socket: cfg.upstream_socket,
  });
  const fileRef = (await r2.text()).trim();
  if (!fileRef.startsWith("/")) throw new Error(`invalid file ref: ${fileRef.slice(0, 120)}`);
  return fileRef;
}

// 把收集到的图片解析/上传成文件引用。返回 { fileRefs, droppedNote }。
// 无 cookie 时不上传(会被 1100 拒),改为返回一段提示文字追加到 prompt。
async function resolveImages(cfg, images) {
  if (!images || !images.length) return { fileRefs: null, droppedNote: "" };
  if (!cfg.cookie) {
    return { fileRefs: null, droppedNote: `\n\n[Note: ${images.length} image(s) were provided but ignored — image input requires a configured GEMINI_COOKIE.]` };
  }
  const refs = [];
  for (const img of images) {
    try {
      let bytes, mime;
      if (img.url) {
        const r = await fetch(img.url, { signal: timeoutSignal(cfg.request_timeout_sec * 1000) });
        bytes = new Uint8Array(await r.arrayBuffer());
        mime = img.mime || r.headers.get("content-type") || "image/png";
      } else {
        bytes = base64ToBytes(img.b64);
        mime = img.mime || "image/png";
      }
      refs.push(await uploadImage(cfg, bytes, mime));
    } catch (e) {
      log(cfg, `image upload failed: ${e}`);
    }
  }
  return { fileRefs: refs.length ? refs : null, droppedNote: "" };
}

function stripArtifacts(text) {
  if (!text) return "";
  text = text.replace(
    /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g,
    ""
  );
  text = text.replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, "");
  return text;
}

// 整段清理:去掉残留标记并裁剪首尾空白。
function cleanText(text) {
  return stripArtifacts(text).trim();
}

/** 解析单行 `wrb.fr`,返回其中包含的文本字符串。 */
function extractTextsFromLine(line) {
  if (!line.includes('"wrb.fr"') || line.length < 200) return [];
  try {
    const arr = JSON.parse(line);
    const innerStr = arr[0][2];
    if (!innerStr || innerStr.length < 50) return [];
    const inner = JSON.parse(innerStr);
    if (!(Array.isArray(inner) && inner.length > 4 && inner[4])) return [];
    const texts = [];
    for (const part of inner[4]) {
      if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
        for (const t of part[1]) {
          if (typeof t === "string" && t) texts.push(t);
        }
      }
    }
    return texts;
  } catch (_) {
    return [];
  }
}

function extractResponseText(raw) {
  let lastText = "";
  for (const line of raw.split("\n")) {
    for (const t of extractTextsFromLine(line)) {
      if (t.length > lastText.length) lastText = t;
    }
  }
  return cleanText(lastText);
}

/** 非流式生成(带重试)。返回最终的响应文本。 */
async function generate(cfg, prompt, modelId, thinkMode, extra, fileRefs) {
  const body = buildPayload(prompt, modelId, thinkMode, fileRefs || null, extra);
  const url = getUrl(cfg);
  const headers = await buildHeaders(cfg);
  let lastErr;
  for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
    try {
      const resp = await httpFetch(url, {
        method: "POST",
        headers,
        body,
        timeoutMs: cfg.request_timeout_sec * 1000,
        socket: cfg.upstream_socket,
      });
      const raw = await resp.text();
      const text = extractResponseText(raw);
      if (!resp.ok || !text) {
        log(cfg, `upstream status=${resp.status} rawLen=${raw.length} parsedLen=${text.length} snippet=${JSON.stringify(raw.slice(0, 200))}`);
      }
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt < cfg.retry_attempts - 1) {
        log(cfg, `Retry ${attempt + 1}/${cfg.retry_attempts}: ${e}`);
        await sleep(cfg.retry_delay_sec * 1000);
      }
    }
  }
  throw lastErr;
}

/**
 * 流式生成。每步 yield 一段文本增量(本次新追加的后缀)。
 * 只在尚未 yield 过任何内容时才重试,以避免重复输出。
 */
async function* generateStream(cfg, prompt, modelId, thinkMode, extra, fileRefs) {
  const body = buildPayload(prompt, modelId, thinkMode, fileRefs || null, extra);
  const url = getUrl(cfg);
  const headers = await buildHeaders(cfg);
  let lastErr;
  let yielded = false;

  for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
    try {
      const resp = await httpFetch(url, {
        method: "POST",
        headers,
        body,
        timeoutMs: cfg.request_timeout_sec * 1000,
        socket: cfg.upstream_socket,
      });
      if (!resp.body) {
        const text = extractResponseText(await resp.text());
        if (text) {
          yielded = true;
          yield text;
        }
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let prev = "";
      let started = false; // 是否已 yield 过非空内容(用于裁掉开头的空白)
      const consumeLine = function* (line) {
        for (const t of extractTextsFromLine(line)) {
          if (t.length > prev.length) {
            // 每段增量:去掉残留标记,但流式过程中不裁剪内部空白,
            // 以保留分块之间的空格(比如 "1, 2, 3" 而不是 "1, 2,3")。
            // 在首个可见内容出现前,持续裁掉前导空白(避免开头空行)。
            let delta = stripArtifacts(t.slice(prev.length));
            prev = t;
            if (!started) delta = delta.replace(/^\s+/, "");
            if (delta) {
              started = true;
              yield delta;
            }
          }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          for (const delta of consumeLine(line)) {
            yielded = true;
            yield delta;
          }
        }
      }
      buf += decoder.decode();
      if (buf) {
        for (const delta of consumeLine(buf)) {
          yielded = true;
          yield delta;
        }
      }
      if (!yielded) log(cfg, `stream upstream produced no text (status=${resp.status})`);
      return;
    } catch (e) {
      lastErr = e;
      if (!yielded && attempt < cfg.retry_attempts - 1) {
        log(cfg, `Stream retry ${attempt + 1}/${cfg.retry_attempts}: ${e}`);
        await sleep(cfg.retry_delay_sec * 1000);
        continue;
      }
      throw e;
    }
  }
  if (lastErr) throw lastErr;
}

// ─── 工具调用 / 消息转换 ─────────────────────────────────────────────────────
function buildToolChoiceInstruction(toolChoice) {
  if (toolChoice === "none") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (toolChoice === "required") return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  if (toolChoice && typeof toolChoice === "object") {
    const fn = (toolChoice.function || {}).name || "";
    if (fn) return `\n\nIMPORTANT: You MUST call the tool "${fn}". Do not call other tools.`;
  }
  return "";
}

/** OpenAI messages -> [promptString, images]。images 恒为 [](不支持图片输入)。 */
function messagesToPrompt(messages, tools, toolChoice) {
  const parts = [];
  const images = [];

  if (tools && toolChoice !== "none") {
    const toolDefs = [];
    for (const tool of tools) {
      const fn = tool.type === "function" ? (tool.function || tool) : tool;
      toolDefs.push({
        name: fn.name != null ? fn.name : (tool.name || ""),
        description: fn.description != null ? fn.description : (tool.description || ""),
        parameters: fn.parameters != null ? fn.parameters : (tool.parameters || {}),
      });
    }
    if (toolDefs.length) {
      const constraint = buildToolChoiceInstruction(toolChoice);
      parts.push(
        "# Tool Use\n\n" +
          "You can call the following tools. Call format:\n" +
          '```tool_call\n{"name": "func_name", "arguments": {...}}\n```\n' +
          "When calling tools, output ONLY the tool_call block(s).\n\n" +
          `Available tools:\n${JSON.stringify(toolDefs, null, 2)}` +
          constraint
      );
    }
  }

  for (const msg of messages) {
    const role = msg.role || "user";
    let content = msg.content != null ? msg.content : "";

    if (Array.isArray(content)) {
      const textParts = [];
      for (const c of content) {
        const t = c && c.type;
        if (t === "text" || t === "input_text") {
          textParts.push(c.text || "");
        } else if (t === "image_url") {
          const u = c.image_url && (c.image_url.url || c.image_url);
          const img = parseImageUrl(typeof u === "string" ? u : "");
          if (img) images.push(img);
        } else if (t === "image") {
          // 兼容 Anthropic 风格 {source:{type:"base64",media_type,data}}
          if (c.source && c.source.data) {
            images.push({ b64: c.source.data, mime: c.source.media_type || "image/png" });
          } else if (c.image_url) {
            const img = parseImageUrl(typeof c.image_url === "string" ? c.image_url : c.image_url.url || "");
            if (img) images.push(img);
          }
        }
      }
      content = textParts.join(" ");
    }

    if (role === "system") {
      parts.push(`[System instruction]: ${content}`);
    } else if (role === "assistant") {
      if (msg.tool_calls) {
        const tcStrs = msg.tool_calls.map((tc) => {
          const fn = tc.function || {};
          return '```tool_call\n{"name": "' + fn.name + '", "arguments": ' + (fn.arguments || "{}") + "}\n```";
        });
        parts.push(`[Assistant]: ${content || ""}\n` + tcStrs.join("\n"));
      } else {
        parts.push(`[Assistant]: ${content}`);
      }
    } else if (role === "tool") {
      parts.push(`[Tool result for ${msg.name || ""}]: ${content}`);
    } else {
      parts.push(content ? content : "");
    }
  }

  return [parts.filter((p) => p).join("\n\n"), images];
}

/** 提取 ```tool_call``` 代码块 -> [cleanText, toolCalls]。 */
function parseToolCalls(text) {
  const toolCalls = [];
  const re = /```tool_call\s*\n([\s\S]*?)\n```/g;
  const cleanParts = [];
  let lastEnd = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    cleanParts.push(text.slice(lastEnd, m.index));
    lastEnd = m.index + m[0].length;
    try {
      const data = JSON.parse(m[1].trim());
      if (data.name === undefined) throw new Error("no name");
      toolCalls.push({
        id: `call_${randHex(8)}`,
        type: "function",
        function: {
          name: data.name,
          arguments: JSON.stringify(data.arguments != null ? data.arguments : {}),
        },
      });
    } catch (_) { /* 跳过格式错误的块 */ }
  }
  cleanParts.push(text.slice(lastEnd));
  return [cleanParts.join("").trim(), toolCalls];
}

// ─── Google 原生 API 辅助函数 ────────────────────────────────────────────────
function buildToolPrompt(toolDefs) {
  const spec = JSON.stringify(toolDefs, null, 2);
  return (
    "# Tool Use\n\n" +
    "You can call the following tools to help accomplish tasks. " +
    "These tools connect to the user's local environment and will execute when called.\n\n" +
    "Call format (use this exact format):\n" +
    "```function_call\n" +
    '{"name": "<tool_name>", "args": {<arguments>}}\n' +
    "```\n\n" +
    "When calling tools:\n" +
    "- Output ONLY the function_call block(s), nothing else\n" +
    "- You may call multiple tools with multiple blocks\n" +
    "- After receiving a [Tool result for ...], use that data to answer the user\n\n" +
    `Available tools:\n${spec}`
  );
}

function googleToolChoiceInstruction(req) {
  const fc = (req.toolConfig || {}).functionCallingConfig || {};
  const mode = fc.mode || "AUTO";
  const allowed = fc.allowedFunctionNames || [];
  if (mode === "NONE") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (mode === "ANY") {
    if (allowed.length) {
      const names = allowed.map((n) => `"${n}"`).join(", ");
      return `\n\nIMPORTANT: You MUST call one of these tools: ${names}. Do not respond with text only.`;
    }
    return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  }
  return "";
}

/** Google 的 contents/tools/systemInstruction -> [promptString, images]。 */
function googleContentsToPrompt(req) {
  const parts = [];
  const images = [];

  const fcMode = ((req.toolConfig || {}).functionCallingConfig || {}).mode || "AUTO";
  const tools = req.tools;
  const toolDefs = [];
  if (tools && fcMode !== "NONE") {
    for (const group of tools) {
      for (const fn of group.functionDeclarations || []) {
        const td = { name: fn.name || "", description: fn.description || "" };
        const params = fn.parameters || fn.parametersJsonSchema;
        if (params) td.parameters = params;
        toolDefs.push(td);
      }
    }
  }

  const sysInst = req.systemInstruction;
  if (sysInst) {
    const sysText = (sysInst.parts || []).filter((p) => p.text).map((p) => p.text).join(" ");
    if (sysText) {
      if (toolDefs.length) {
        parts.push(sysText + "\n\n" + buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
      } else {
        parts.push(sysText);
      }
    }
  } else if (toolDefs.length) {
    parts.push(buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
  }

  for (const content of req.contents || []) {
    const role = content.role || "user";
    const msgParts = [];
    for (const p of content.parts || []) {
      if (p.text) {
        msgParts.push(p.text);
      } else if (p.inlineData) {
        images.push({ b64: p.inlineData.data, mime: p.inlineData.mimeType || "image/png" });
      } else if (p.functionCall) {
        const fc = p.functionCall;
        msgParts.push("```function_call\n" + JSON.stringify({ name: fc.name, args: fc.args || {} }) + "\n```");
      } else if (p.functionResponse) {
        const fr = p.functionResponse;
        msgParts.push(`[Tool result for ${fr.name || ""}]: ${JSON.stringify(fr.response || {})}`);
      }
    }
    const text = msgParts.join("\n");
    if (role === "model") parts.push(`[Assistant]: ${text}`);
    else parts.push(text);
  }

  return [parts.filter((p) => p).join("\n\n"), images];
}

/** 提取 ```function_call``` 代码块(3 种格式)-> [cleanText, functionCalls]。 */
function parseGoogleFunctionCalls(text) {
  const functionCalls = [];
  const patterns = [
    /```function_call\s*\n([\s\S]*?)\n```/g,
    /(?:^|\n)function_call\s*\n(\{[^`]*?\})/g,
  ];
  let clean = text;
  for (const pat of patterns) {
    for (const m of clean.matchAll(new RegExp(pat.source, pat.flags))) {
      try {
        const data = JSON.parse(m[1].trim());
        if (data && "name" in data) {
          functionCalls.push({ name: data.name, args: data.args != null ? data.args : (data.arguments != null ? data.arguments : {}) });
        }
      } catch (_) { /* 跳过 */ }
    }
    clean = clean.replace(new RegExp(pat.source, pat.flags), "").trim();
  }
  if (!functionCalls.length && clean.trim().startsWith("{")) {
    try {
      const data = JSON.parse(clean.trim());
      if (data && "name" in data && ("args" in data || "arguments" in data)) {
        functionCalls.push({ name: data.name, args: data.args != null ? data.args : data.arguments });
        clean = "";
      }
    } catch (_) { /* skip */ }
  }
  return [clean, functionCalls];
}

// ─── HTTP 辅助函数 ──────────────────────────────────────────────────────────────
function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*" };
}

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extra },
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

// 从多种来源取调用方 key:Bearer / x-api-key / x-goog-api-key / ?key=
// (分别兼容 OpenAI 客户端、Anthropic 风格、Gemini CLI)。任一匹配即放行。
function authorized(request, url, cfg) {
  const keys = cfg.api_keys || [];
  if (!keys.length) return true;
  const h = request.headers;
  const auth = h.get("authorization") || "";
  const candidates = [
    auth.startsWith("Bearer ") ? auth.slice(7) : null,
    h.get("x-api-key"),
    h.get("x-goog-api-key"),
    url ? url.searchParams.get("key") : null,
  ];
  return candidates.some((k) => k && keys.includes(k));
}

/**
 * 构造一个 SSE 响应,响应体由 `producer(write)` 生成。
 * `write(str)` 会入队一个 UTF-8 分块。producer 结束后流会自动关闭。
 */
function sseResponse(producer) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (s) => controller.enqueue(encoder.encode(s));
      try {
        await producer(write);
      } catch (_) {
        /* 尽力而为:停止流式输出 */
      } finally {
        try { controller.close(); } catch (_) {}
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...corsHeaders(),
    },
  });
}

// ─── 处理函数 ──────────────────────────────────────────────────────────────────

// 上游返回为空时给客户端的可见提示(否则像 Cherry 这类客户端会“无返回”)。
// 线上常见原因:部署在 Cloudflare/无服务器平台时,出口 IP 被 Google 区别对待
// (本地能跑、线上空);其次是 GEMINI_BL 过期。用 `wrangler tail` 看上游状态。
const EMPTY_UPSTREAM_MSG =
  "⚠️ Upstream Gemini returned an empty response. " +
  "If this Worker runs on Cloudflare/serverless, Google may be blocking the egress IP " +
  "(works locally but empty in production); also verify GEMINI_BL is current. " +
  "Run `wrangler tail` to see the upstream status.";

// POST /v1/chat/completions
async function handleChat(req, cfg) {
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);

  const tools = req.tools;
  const toolChoice = req.tool_choice != null ? req.tool_choice : "auto";
  const [prompt0, images] = messagesToPrompt(req.messages || [], tools, toolChoice);
  const { fileRefs, droppedNote } = await resolveImages(cfg, images);
  const prompt = prompt0 + droppedNote;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty prompt" } }, 400);

  const stream = req.stream || false;
  const cid = `chatcmpl-${randHex(12)}`;

  if (stream && (!tools || toolChoice === "none")) {
    return sseResponse(async (write) => {
      let got = false;
      let errMsg = "";
      const chunk = (delta, finish) => write(`data: ${JSON.stringify({
        id: cid, object: "chat.completion.chunk", created: nowSec(), model: rm.name,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      try {
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs)) {
          got = true;
          chunk({ content: delta }, null);
        }
      } catch (e) {
        errMsg = `⚠️ upstream error: ${e}`;
      } finally {
        if (!got) {
          const note = errMsg || EMPTY_UPSTREAM_MSG;
          log(cfg, `chat stream produced no content -> ${note}`);
          chunk({ content: note }, null); // 让客户端看到原因,而非空白
        }
        chunk({}, "stop");
        write("data: [DONE]\n\n");
      }
    });
  }

  let text;
  try {
    text = await generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }

  let toolCalls = null;
  if (tools && text && toolChoice !== "none") {
    const [clean, tc] = parseToolCalls(text);
    text = clean;
    toolCalls = tc.length ? tc : null;
  }
  if (!text && !toolCalls) {
    log(cfg, "chat non-stream produced no content (empty upstream)");
    text = EMPTY_UPSTREAM_MSG; // 可见提示,避免客户端“无返回”
  }
  const msg = { role: "assistant", content: text || null };
  if (toolCalls) msg.tool_calls = toolCalls;
  const finish = toolCalls ? "tool_calls" : "stop";

  if (stream) {
    return sseResponse(async (write) => {
      write(`data: ${JSON.stringify({
        id: cid, object: "chat.completion.chunk", created: nowSec(), model: rm.name,
        choices: [{ index: 0, delta: msg, finish_reason: finish }],
      })}\n\n`);
      write("data: [DONE]\n\n");
    });
  }

  return jsonResponse({
    id: cid, object: "chat.completion", created: nowSec(), model: rm.name,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: {
      prompt_tokens: tokenEst(prompt),
      completion_tokens: tokenEst(text),
      total_tokens: tokenEst(prompt) + tokenEst(text),
    },
  });
}

// POST /v1/responses(Codex CLI 用)
async function handleResponses(req, cfg) {
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);

  const inputItems = req.input != null ? req.input : [];
  let tools = req.tools;
  const messages = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });

  if (typeof inputItems === "string") {
    messages.push({ role: "user", content: inputItems });
  } else if (Array.isArray(inputItems)) {
    for (const item of inputItems) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (item && typeof item === "object") {
        if (item.type === "function_call_output") {
          messages.push({ role: "tool", tool_call_id: item.call_id || "", name: item.name || "", content: item.output || "" });
        } else if (item.role === "assistant" || (item.type === "message" && item.role === "assistant")) {
          const cp = item.content != null ? item.content : [];
          let textAcc = "";
          const tcList = [];
          if (Array.isArray(cp)) {
            for (const c of cp) {
              if (c && typeof c === "object") {
                if (c.type === "output_text") textAcc += c.text || "";
                else if (c.type === "function_call") tcList.push(c);
              }
            }
          } else if (typeof cp === "string") {
            textAcc = cp;
          }
          const m = { role: "assistant", content: textAcc || null };
          if (tcList.length) {
            m.tool_calls = tcList.map((tc, i) => ({
              id: tc.call_id || `call_${i}`, type: "function",
              function: { name: tc.name || "", arguments: tc.arguments || "{}" },
            }));
          }
          messages.push(m);
        } else {
          const role = item.role || "user";
          let content = item.content != null ? item.content : "";
          if (Array.isArray(content)) {
            content = content.filter((c) => c.type === "text" || c.type === "input_text").map((c) => c.text || "").join(" ");
          }
          messages.push({ role, content });
        }
      }
    }
  }

  if (tools) {
    tools = tools.map((t) =>
      t.type === "function" && !("function" in t)
        ? { type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || {} } }
        : t
    );
  }

  const toolChoice = req.tool_choice != null ? req.tool_choice : "auto";
  const [prompt0, images] = messagesToPrompt(messages, tools, toolChoice);
  const { fileRefs, droppedNote } = await resolveImages(cfg, images);
  const prompt = prompt0 + droppedNote;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty input" } }, 400);

  let text;
  try {
    text = await generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }

  let toolCalls = null;
  if (tools && text && toolChoice !== "none") {
    const [clean, tc] = parseToolCalls(text);
    text = clean;
    toolCalls = tc.length ? tc : null;
  }

  const rid = `resp_${randHex(16)}`;
  const mid = `msg_${randHex(12)}`;
  const output = [];
  if (toolCalls) {
    for (const tc of toolCalls) {
      output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
    }
  }
  if (text || !toolCalls) {
    output.push({ type: "message", id: mid, role: "assistant", status: "completed", content: [{ type: "output_text", text: text || "", annotations: [] }] });
  }

  const usage = { input_tokens: tokenEst(prompt), output_tokens: tokenEst(text), total_tokens: tokenEst(prompt) + tokenEst(text) };

  if (req.stream) {
    return sseResponse(async (write) => {
      write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: rid, object: "response", status: "in_progress", model: rm.name, output: [] } })}\n\n`);
      for (const item of output) {
        if (item.type === "function_call") {
          write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments })}\n\n`);
        } else if (item.type === "message") {
          item.content.forEach((cp, ci) => {
            write(`event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: item.id, content_index: ci, text: cp.text })}\n\n`);
          });
        }
      }
      const respObj = { id: rid, object: "response", status: "completed", model: rm.name, output, usage };
      write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: respObj })}\n\n`);
    });
  }

  return jsonResponse({ id: rid, object: "response", created_at: nowSec(), status: "completed", model: rm.name, output, usage });
}

// POST /v1beta/models/{model}:generateContent | :streamGenerateContent
async function handleGoogleGenerate(req, cfg, path, stream) {
  const m = /\/v1beta\/models\/([^:?]+)/.exec(path);
  const rm = resolveModel(m ? m[1] : cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);

  const fcMode = ((req.toolConfig || {}).functionCallingConfig || {}).mode || "AUTO";
  const hasTools = !!req.tools && fcMode !== "NONE";
  const [prompt0, images] = googleContentsToPrompt(req);
  const { fileRefs, droppedNote } = await resolveImages(cfg, images);
  const prompt = prompt0 + droppedNote;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty content" } }, 400);

  log(cfg, `Google API: model=${rm.name} stream=${stream} tools=${hasTools} prompt_len=${prompt.length}`);

  if (stream && !hasTools) {
    return sseResponse(async (write) => {
      let fullText = "";
      try {
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs)) {
          if (!delta) continue;
          fullText += delta;
          write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: delta }], role: "model" }, index: 0 }], modelVersion: rm.name })}\n\n`);
        }
      } finally {
        write(`data: ${JSON.stringify({
          candidates: [{ finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: tokenEst(prompt), candidatesTokenCount: tokenEst(fullText), totalTokenCount: tokenEst(prompt) + tokenEst(fullText) },
          modelVersion: rm.name,
        })}\n\n`);
      }
    });
  }

  let text;
  try {
    text = await generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }
  if (!text) log(cfg, "Warning: empty response from Gemini");

  const responseParts = [];
  if (hasTools && text) {
    const [clean, fcs] = parseGoogleFunctionCalls(text);
    if (fcs.length) {
      if (clean) responseParts.push({ text: clean });
      for (const fc of fcs) responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
    } else {
      responseParts.push({ text });
    }
  } else {
    responseParts.push({ text: text || "I apologize, but I was unable to generate a response. Please try again." });
  }

  const responseObj = {
    candidates: [{ content: { parts: responseParts, role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: tokenEst(prompt), candidatesTokenCount: tokenEst(text), totalTokenCount: tokenEst(prompt) + tokenEst(text) },
    modelVersion: rm.name,
  };

  if (stream) {
    return sseResponse(async (write) => { write(`data: ${JSON.stringify(responseObj)}\n\n`); });
  }
  return jsonResponse(responseObj);
}

// GET /debug — 排查上游为何为空。从【当前部署环境】实地探测,回显原始状态/片段。
// 探针 A:裸请求(现行做法);探针 B:先抓访客 cookie + at token 再请求。
// 对比两者即可判断:是 IP 被拦(都空)、还是缺会话(B 能通 → 可自动修)。
async function handleDebug(cfg) {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

  async function probe(guest) {
    try {
      let cookie = cfg.cookie || "";
      let at = "";
      let bl = cfg.gemini_bl;
      let pageStatus = null;
      let setCookieCount = 0;
      if (guest && !cookie) {
        const pr = await httpFetch(`${cfg.gemini_origin}/app`, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, timeoutMs: 30000, socket: cfg.upstream_socket });
        pageStatus = pr.status;
        const sc = pr.headers.getSetCookie ? pr.headers.getSetCookie() : [];
        setCookieCount = sc.length;
        cookie = sc.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
        const html = await pr.text();
        at = (/"SNlM0e":"([^"]+)"/.exec(html) || [])[1] || "";
        const blm = /"cfb2h":"([^"]+)"/.exec(html);
        if (blm) bl = blm[1];
      }
      const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://gemini.google.com",
        "Referer": "https://gemini.google.com/app",
        "X-Same-Domain": "1",
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
      };
      if (cookie) headers["Cookie"] = cookie;
      if (cfg.sapisid) headers["Authorization"] = await makeSapisidHash(cfg.sapisid);
      let body = buildPayload("Reply with one word: PONG", 1, 4, null, null);
      if (at) body += "&at=" + encodeURIComponent(at);
      const resp = await httpFetch(getUrl({ gemini_bl: bl, gemini_origin: cfg.gemini_origin }), { method: "POST", headers, body, timeoutMs: 60000, socket: cfg.upstream_socket });
      const raw = await resp.text();
      return {
        status: resp.status,
        contentType: resp.headers.get("content-type"),
        rawLength: raw.length,
        parsed: extractResponseText(raw).slice(0, 160),
        rawSnippet: raw.slice(0, 500),
        usedCookie: !!cookie,
        usedAt: !!at,
        blUsed: bl,
        pageStatus,
        setCookieCount,
      };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  return jsonResponse({
    note: "上游已改用 socket(cloudflare:sockets)优先、fetch 兜底。socket.available=false 表示运行时没有该模块、退回 fetch。A=bare, B=guest. 若 status 仍是 429,说明 socket 出口同样被 Google 限流 -> 用 GEMINI_ORIGIN 中转或换非数据中心 IP。",
    bl: cfg.gemini_bl,
    geminiOrigin: cfg.gemini_origin,
    hasCookie: !!cfg.cookie,
    socket: { configEnabled: cfg.upstream_socket, available: !!(await resolveConnect()) },
    A_bare: await probe(false),
    B_guest: await probe(true),
  });
}

// ─── 路由 ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const cfg = getConfig(env);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders(), "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*" },
      });
    }

    // 鉴权:配置了 API_KEYS 时,除健康检查 "/" 外的所有接口都需要有效 key
    // (含 /v1/* 与 /v1beta/*,防止 Google 原生端点被绕过白嫖)。
    if (path !== "/" && !authorized(request, url, cfg)) {
      return jsonResponse({ error: { message: "invalid api key" } }, 401);
    }

    try {
      if (method === "GET") {
        if (path === "/v1/models") {
          return jsonResponse({
            object: "list",
            data: Object.entries(MODELS).map(([n, c]) => ({ id: n, object: "model", created: 1700000000, owned_by: "google", description: c.desc })),
          });
        }
        if (path.startsWith("/v1beta/models")) {
          return jsonResponse({
            models: Object.entries(MODELS).map(([n, c]) => ({ name: `models/${n}`, displayName: n, description: c.desc, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] })),
          });
        }
        if (path === "/") {
          return jsonResponse({ status: "ok", version: VERSION, models: Object.keys(MODELS) });
        }
        if (path === "/debug") {
          return await handleDebug(cfg);
        }
        return jsonResponse({ error: "not found" }, 404);
      }

      if (method === "POST") {
        const bodyText = await request.text();
        const req = parseJson(bodyText);

        if (path === "/v1/chat/completions") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleChat(req, cfg);
        }
        if (path === "/v1/responses") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleResponses(req, cfg);
        }
        if (path.includes(":generateContent")) {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleGoogleGenerate(req, cfg, path, false);
        }
        if (path.includes(":streamGenerateContent")) {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleGoogleGenerate(req, cfg, path, true);
        }
        return jsonResponse({ error: "not found" }, 404);
      }

      return jsonResponse({ error: "not found" }, 404);
    } catch (e) {
      log(cfg, `error: ${(e && e.stack) || e}`);
      return jsonResponse({ error: { message: String((e && e.message) || e) } }, 500);
    }
  },
};

// 导出给本地测试用(Workers 运行时会忽略)。
export {
  MODELS, resolveModel, getConfig, buildPayload, getUrl, buildHeaders, cleanText,
  extractTextsFromLine, extractResponseText, generate, generateStream,
  messagesToPrompt, parseToolCalls, googleContentsToPrompt, parseGoogleFunctionCalls,
  makeSapisidHash, parseImageUrl, getPageTokens, uploadImage, resolveImages,
  __setConnect, httpFetch, socketHttp,
};
