# 06 AI 配置与模型网关

## 功能（设置 → AI 模型）

- 今日用量条：tokens / 每日上限、调用次数；每日上限可编辑。
- 模型服务商列表：点击展开配置（Base URL、API Key、默认模型）、「测试连接」「保存」；状态（已连接 · 用于 n 项任务 / 未配置）；添加服务商。
- 按任务选择模型（见 07）：
  - 学习判定：只读行为摘要，建议本地小模型（Ollama 7B–8B）；
  - 知识处理：判定 + 抽取 + 词条对齐 + 补丁一次完成，需强模型；
  - 词条重写：仅手动重新整理、`stale`、全量整理时调用，中档模型即可；
  - 首页对话；
  - 向量 Embedding：建议本地，整理时 ④ 检索与 ⑥ 写入同步调用。
- 达到每日上限：自动整理暂停，剩余条目留到次日；手动整理与对话提示超限并允许本次继续（需确认）。

## 网关设计

```text
services/local-ingestion/src/ai/
  providers.ts      根据 providers 表实例化 SDK provider（openai-compatible / anthropic / ollama）
  gateway.ts        按任务取模型；统一 generateObject / streamText / embed；记录用量；限额检查；重试
  prompts/          提示词模板，带版本号（写入 organize_results.prompt_version）
```

- 服务商类型：`openai-compatible`（OpenAI、DeepSeek、通义、Kimi、智谱、OpenRouter 等）、`anthropic`、`ollama`。
- 结构化输出：整理与抽取使用 Zod schema 约束 JSON；对不支持 JSON Schema 的模型降级为「JSON 模式 + 本地校验 + 一次修复重试」。
- 用量：每次调用后写 `usage_daily`（输入/输出 tokens）；调用前检查当日累计是否超限。
- 重试：429 / 5xx 指数退避 3 次；上下文超长错误不重试，返回给整理流水线做切块降级。
- 测试连接：发送 1 token 的最小请求，同时拉取 `/models`（支持时）用于默认模型下拉。
- 隐私：仅整理与对话时把相关内容发送给所选服务商；日志只记录 token 数与耗时。

## API

| 方法与路径 | 说明 |
| --- | --- |
| `GET/POST/PATCH/DELETE /v1/ai/providers` | 服务商 CRUD（Key 只返回掩码 `sk-…abcd`） |
| `POST /v1/ai/providers/:id/test` | 测试连接 |
| `GET/PUT /v1/ai/tasks` | 按任务选模型 |
| `GET /v1/ai/usage?day` 、`PUT /v1/ai/limits` | 用量与每日上限 |

## 选型

### S10 模型网关

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible` / `@ai-sdk/anthropic` / Ollama provider） | 统一接口覆盖三类服务商；`generateObject` + Zod 结构化输出；`streamText` 返回 Web 流，直接接 Hono 与前端 `useChat`；tools 调用；返回 usage | 大版本迭代较快，需锁版本 |
| OpenAI SDK 直连（Anthropic、Ollama 都提供 OpenAI 兼容端点） | 依赖最少 | 各家兼容端点对结构化输出、tools、流式细节不一致，需要自己抹平；前端流式协议自写 |
| LangChain.js | 组件最全（检索器、文本切分） | 抽象层厚、升级破坏性变更多，本项目只用到很小子集 |
| Mastra（基于 AI SDK 的 Agent 框架） | 工作流、记忆、评估 | 对本项目过重 |

### S11 API Key 存储

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ `StudyStudioData/secrets.json`（权限 0600，不进 SQLite、不进备份与导出） | 简单、跨平台、可迁移 | 明文落盘，依赖系统账户隔离 |
| 系统钥匙串（`@napi-rs/keyring`） | 由操作系统加密保护 | 原生模块；Linux 无桌面环境时不可用；换机迁移麻烦 |
| SQLite 内加密存储（密钥存本机文件） | 与数据同库 | 密钥仍在本机，安全性与方案一接近，复杂度更高 |
