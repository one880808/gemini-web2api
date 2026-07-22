# gemini-web2api
[Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api/) 的 CF Workers 版本

将 Google Gemini 网页端转换为 OpenAI 兼容 API. 零认证, 零成本, 跨平台.

## 上游同步 (最新模型)

本仓库 Worker 的模型表 / 默认模型 / `GEMINI_BL` 对齐上游 Python 包近期提交:

| Upstream commit | 说明 |
|-----------------|------|
| [`fbd5dde`](https://github.com/Sophomoresty/gemini-web2api/commit/fbd5ddefcf9423575d0d9bede9b4a2ae994d1464) | `gemini_bl` → `boq_assistant-bard-web-server_20260716.08_p0` |
| [`d227668`](https://github.com/Sophomoresty/gemini-web2api/commit/d227668e4e53a819ab0e42b8b7da1d912d3c8438) | 新增 `gemini-3.6-flash` 为默认; `gemini-3.5-flash` 保留为 alias |
| [`e12c4ef`](https://github.com/Sophomoresty/gemini-web2api/commit/e12c4ef3548db63c7381449aa00101fb65fae08e) | 文档/模型列表描述更新 |

Worker 版本: `1.1.1-worker`

### 支持模型

| id | MODE_CATEGORY | 说明 |
|----|---------------|------|
| `gemini-3.6-flash` | 1 (FAST) | 默认; 当前网页端 Flash |
| `gemini-3.5-flash` | 1 | 兼容别名 → 同上 |
| `gemini-3.5-flash-thinking` | 2 | 深度思考 |
| `gemini-3.1-pro` | 3 | Pro (需 cookie 才真实路由) |
| `gemini-3.1-pro-enhanced` | 3 | Pro 增强输出 (实验) |
| `gemini-auto` | 4 | 自动选择 |
| `gemini-3.5-flash-thinking-lite` | 5 | 动态思考 |
| `gemini-flash-lite` | 6 | 轻量 Flash |

部署时若仍返回空响应, 优先核对 `CONFIG.GEMINI_BL` 是否与当前 gemini.google.com 前端一致, 或用 Worker secret `GEMINI_BL` 覆盖。

## 特性

- **可选密钥**: `api_keys` 为空时免密, 填入密钥后按 OpenAI Bearer Key 校验
- **OpenAI 兼容**: 直接替换 `/v1/chat/completions` 和 `/v1/models`
- **工具调用**: 完整的 Function Calling 支持 (OpenAI 格式)
- **多模型**: Flash 3.6, Flash Thinking (2万字+输出), Pro, Auto, Lite
- **思考深度**: 通过 `@think=N` 后缀调节 (0=最深, 4=最浅)
- **联网搜索**: 内置互联网访问 (Gemini 原生搜索能力)
- **流式输出**: SSE Streaming 支持
- **Codex CLI**: Responses API (`/v1/responses`) 兼容 OpenAI Codex
- **Gemini CLI**: Google 原生 API (`/v1beta/models`) 兼容 Gemini CLI

## 快速开始

复制 `worker.js` 内容直接部署 (Workers & Pages → Create → 粘贴 → Deploy), 或 `wrangler deploy`。

其他特性请参考原项目。

## 已知限制

- **图片/多模态**: 需配置 `GEMINI_COOKIE`; 未配置时图片会被忽略并提示。
- **Pro/Ultra 非真实路由**: 无付费订阅 cookie 时, `gemini-3.1-pro` 实际路由到 Flash. "Pro" 只是 UI 偏好标签.
- **单轮对话**: 每次请求是独立对话, 多轮上下文通过在 prompt 中包含历史消息模拟.
- **频率限制**: Google 可能限制高频请求, server 会自动重试但持续高负载可能被封.

## 系统要求
- 无要求

## 工作原理

逆向 Google Gemini 网页端的 StreamGenerate 协议, 将 OpenAI API 格式与 Gemini 内部 protobuf-like 格式互转. 模型选择通过请求 payload 的 `[79]` 字段控制, 映射自 Gemini 前端 JS 源码中的 `MODE_CATEGORY` 枚举.

## 致谢
- [Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api/)
- [linux.do](https://linux.do) 社区
- 开源 API 代理生态

## License

MIT
