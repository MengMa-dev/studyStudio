# 02 本地服务与 SQLite 存储

## 定位

- 单进程 Node 服务，监听 `127.0.0.1:43118`，同时承担：采集入库、工作台 API、静态托管前端 `/app`、整理调度、对话流式输出。
- 启动即「拉起数据库」：嵌入式 SQLite，无独立数据库进程。
- SQLite 是唯一事实源；FTS、向量、统计均为派生，可「重建索引」。

## 启动流程

```text
npx study-studio
 1. 解析数据目录（默认 ~/StudyStudioData，可用 STUDY_STUDIO_DATA_DIR 覆盖）
 2. 打开 studystudio.db：PRAGMA journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON; busy_timeout=5000
 3. PRAGMA quick_check；失败则提示从 backups/ 恢复
 4. 执行未应用的迁移（schema_migrations）
 5. 加载扩展：sqlite-vec（失败则向量检索降级为关闭）
 6. 生成/读取配对令牌；启动 HTTP；打印工作台一次性登录链接并打开浏览器
 7. 启动调度器：整理补跑、回收站过期清理、行为日志过期清理、每日备份
```

退出：捕获 SIGINT/SIGTERM，等待当前写事务与整理任务的检查点，`PRAGMA wal_checkpoint(TRUNCATE)` 后关闭。

## 数据目录

```text
StudyStudioData/
  studystudio.db (+ -wal, -shm)
  blobs/<sha256 前2位>/<sha256>     网页图片等二进制（后续学习区的 PDF/PPT 也放这里）
  backups/studystudio-YYYYMMDD.db   每日 VACUUM INTO，保留 7 份
  secrets.json                      API Key（0600，见 06）
  .pairing-token
```

## 表结构（核心）

```sql
-- 采集原始事件（时间线事实源）
CREATE TABLE events (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, occurred_at TEXT NOT NULL, day TEXT NOT NULL,
  channel TEXT, site TEXT, url TEXT, canonical_url TEXT, session_id TEXT,
  item_id TEXT REFERENCES items(id), payload TEXT NOT NULL,           -- JSON，不含正文
  received_at TEXT NOT NULL
);
CREATE INDEX events_day ON events(day, occurred_at);

-- 收集条目（网页 / 问答；document 为学习区预留）
CREATE TABLE items (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('webpage','conversation','document')),
  title TEXT, url TEXT, canonical_url TEXT, site TEXT, captured_at TEXT NOT NULL,
  reason TEXT, is_strong_learning INTEGER DEFAULT 0,
  read_status TEXT NOT NULL DEFAULT 'unread',             -- unread | read
  organize_status TEXT NOT NULL DEFAULT 'pending',        -- pending | ingested | rejected | failed（见 07）
  dirty INTEGER NOT NULL DEFAULT 0,                       -- 有未用于整理的编辑/备注，不触发自动整理
  content_hash TEXT, edited_at TEXT,
  reading_total_seconds INTEGER DEFAULT 0, reading_session_count INTEGER DEFAULT 0, last_read_at TEXT,
  doc_pages INTEGER, doc_read_pages INTEGER,
  deleted_at TEXT
);
CREATE UNIQUE INDEX items_canonical ON items(canonical_url) WHERE type='webpage' AND deleted_at IS NULL;

CREATE TABLE item_contents (                              -- 正文与列表分表，列表查询不读大字段
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  markdown TEXT, plain_text TEXT, sanitized_html TEXT,
  question TEXT, reasoning TEXT, extractor TEXT, meta TEXT, original_markdown TEXT  -- 用户编辑前的原文
);
CREATE TABLE reading_sessions (id TEXT PRIMARY KEY, item_id TEXT, started_at TEXT, seconds INTEGER, is_first INTEGER, pages TEXT);
-- 内容露出：同一条目跨会话累计（见 01 内容露出）
CREATE TABLE item_exposure (
  item_id TEXT, section_key TEXT, heading TEXT, chars INTEGER,
  exposed_seconds INTEGER, coverage REAL,      -- coverage 按累计秒数重算
  top_blocks TEXT,                              -- JSON：[{ fp, exposed_seconds }]，保留累计前 10
  updated_at TEXT, PRIMARY KEY (item_id, section_key)
);
CREATE TABLE assets (id TEXT PRIMARY KEY, item_id TEXT, kind TEXT, sha256 TEXT, mime TEXT, size INTEGER, source_url TEXT);
CREATE TABLE tags (item_id TEXT, tag TEXT, PRIMARY KEY (item_id, tag));

-- 三类备注（见 03）
CREATE TABLE notes (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('fuzzy','item','entry')),
  target_id TEXT, text TEXT NOT NULL,
  origin TEXT NOT NULL,          -- extension | workbench | organize_requirement | derived
  derived_from TEXT,             -- entry 备注来自哪条 item 备注
  used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT, deleted_at TEXT
);

-- 知识库（见 08）
CREATE TABLE kb_categories (id TEXT PRIMARY KEY, name TEXT, description TEXT, sort INTEGER);
CREATE TABLE kb_entries (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category_id TEXT, kind TEXT, aliases TEXT,
  summary TEXT, body_markdown TEXT, completeness TEXT,
  mastery REAL, mastery_source TEXT DEFAULT 'auto',       -- auto | user
  user_edited INTEGER DEFAULT 0, stale INTEGER DEFAULT 0, orphan INTEGER DEFAULT 0,
  patch_count INTEGER DEFAULT 0,                          -- 上次全量重写后的补丁次数（见 07 ⑦）
  updated_at TEXT, deleted_at TEXT
);
CREATE TABLE kb_edges (src TEXT, dst TEXT, type TEXT, PRIMARY KEY (src, dst, type));
CREATE TABLE kb_edge_sources (src TEXT, dst TEXT, type TEXT, item_id TEXT,
  description TEXT               -- contrasts 边的一句话区别，用于渲染「与 X 的区别」
);
CREATE TABLE kb_entry_sources (
  entry_id TEXT, item_id TEXT,
  evidence TEXT,                 -- JSON 数组：[{ quote, question?, turn_item_id? }]；question 仅问答来源
  source_kind TEXT,              -- official_doc | repo | community | blog | ai_answer | other
  added_at TEXT,                 -- 用于时间衰减（见 07 ④）
  PRIMARY KEY (entry_id, item_id)
);
CREATE TABLE kb_ignore (name TEXT PRIMARY KEY, created_at TEXT);

-- 整理（见 07）
CREATE TABLE organize_results (
  item_id TEXT PRIMARY KEY, summary TEXT, points TEXT, model TEXT, prompt_version TEXT, input_hash TEXT, run_id TEXT, updated_at TEXT,
  episode_id TEXT,
  decision TEXT,                 -- new | supplement | duplicate | reject | not_learning
  route TEXT,                    -- prefilter:<规则名> | llm | llm_long（长文两步）
  value_score REAL, target_entry_ids TEXT,                      -- JSON
  output TEXT,                   -- 知识处理完整输出 JSON（含补丁、被替换的原章节），用于校准与回滚
  reject_reason TEXT, reason TEXT,                              -- 只存后台，不展示
  override TEXT                  -- adopt：对未采纳条目手动整理（用户确认入库）
);
-- 活动片段（片段切分 + 学习判定结果）
CREATE TABLE episodes (
  id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT, active_seconds INTEGER,
  status TEXT NOT NULL,          -- open | prefiltered | judged
  is_learning INTEGER, confidence REAL, topic TEXT, learning_goal TEXT,
  judge_output TEXT,             -- 学习判定完整 JSON
  run_id TEXT, prompt_version TEXT, created_at TEXT
);
CREATE TABLE episode_items (episode_id TEXT, item_id TEXT, PRIMARY KEY (episode_id, item_id));
CREATE TABLE organize_runs (id TEXT PRIMARY KEY, trigger TEXT, scope TEXT, requirement TEXT, status TEXT, started_at TEXT, finished_at TEXT, stats TEXT, tokens INTEGER, model TEXT);
CREATE TABLE organize_jobs (id TEXT PRIMARY KEY, run_id TEXT, kind TEXT, target_id TEXT, status TEXT, attempts INTEGER, error TEXT, updated_at TEXT);

-- 对话、设置、回收站、用量
CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, citations TEXT, context TEXT, created_at TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
CREATE TABLE rules (id TEXT PRIMARY KEY, kind TEXT, value TEXT, note TEXT, created_at TEXT);
CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, type TEXT, base_url TEXT, default_model TEXT, status TEXT, checked_at TEXT);
CREATE TABLE task_models (task TEXT PRIMARY KEY, provider_id TEXT, model TEXT, fallback_provider_id TEXT, fallback_model TEXT);
CREATE TABLE usage_daily (day TEXT, task TEXT, provider_id TEXT, calls INTEGER, input_tokens INTEGER, output_tokens INTEGER, PRIMARY KEY (day, task, provider_id));
CREATE TABLE trash (id TEXT PRIMARY KEY, kind TEXT, target_ids TEXT, snapshot TEXT, deleted_at TEXT, expires_at TEXT);

-- 检索（派生）
CREATE TABLE chunks (id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, seq INTEGER, text TEXT, tokens INTEGER);
CREATE VIRTUAL TABLE chunks_fts USING fts5(seg_text, content='', tokenize='unicode61');   -- 预分词文本
CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[1024]);                         -- sqlite-vec，维度随模型
```

软删除：`items` / `notes` / `kb_entries` 用 `deleted_at`，配合 `trash` 快照实现 30 天撤销，过期后物理删除并清理无引用的 blob。

## 采集入库（替换现有文件写入）

`ingest(event)` 在单个事务中完成，逻辑与现有实现一致，只换存储：

| 事件 | 写入 |
| --- | --- |
| `user_message_sent` | `events`（等回答完成后回填 `item_id`） |
| `assistant_response_completed` | `items`(conversation) + `item_contents` + `events` |
| `webpage_captured` | canonical URL 已存在 → `duplicatePage`；否则 `items`(webpage) + `item_contents` + `assets` + `events` |
| `user_note` | `events` + `notes`（有当前页面已入箱条目 → `scope=item`；否则 `scope=fuzzy`） |
| `reading_session_closed` | 规则不变（首次停留全额、之后 ≥ 60 秒）→ `reading_sessions` + 更新 `items` 统计 + `events` |
| `page_session` / `search_performed` / `selection` / `copy` / `activity_state`（行为记录，见 01） | 只写 `events`（`payload` 为元数据，不含正文）；同页已入箱时回填 `item_id`，并把 `page_session.exposure` 按 `section_key` 累加到 `item_exposure` |

- 行为日志保留期：`page_session`、`activity_state` 等行为事件保留 14 天（可配置），过期由调度器删除；已被 `episodes` 引用的统计已落在片段上，不受影响。`webpage_captured` 等内容事件不过期。

- 去重：`events.id` 主键冲突 → `duplicate`；不再启动时扫描 jsonl 构建内存 Set。
- 写入串行：沿用单队列，`node:sqlite` 同步 API 在事务内执行，单次入库 < 5 ms。
- 新增条目后：写 `organize_jobs` 前判断是否命中「入箱即整理 / 攒够数量」（见 07）；写 FTS 分块交给后台索引任务，不阻塞采集响应。

## 旧数据

不迁移旧版文件目录（`timeline/`、`inbox/`、`state/`）：服务不读取、不导入、不改动它们，新库从空开始；用户可自行删除旧目录。

## 鉴权与安全

- 仅监听 `127.0.0.1`；校验 `Host` 为 `127.0.0.1:<port>` / `localhost:<port>`，防 DNS rebinding。
- 采集 API：`Authorization: Bearer <pairingToken>`（扩展）。
- 工作台：同源访问，见 S23；写操作要求 `Origin` 同源。
- 不开放宽松 CORS；扩展请求依赖 `host_permissions`，无需 CORS。
- 日志不打印正文与 API Key。

## 选型

### S4 SQLite 驱动

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ `node:sqlite`（Node 内置） | 零依赖、无原生编译，`npx` 安装最稳；同步 API；已实测本机 Node 22.22（SQLite 3.51）支持 FTS5/trigram 与 `loadExtension` | 仍标记 experimental（启动有警告，可屏蔽）；要求 Node ≥ 22.13；生态（ORM）支持较新 |
| better-sqlite3 | 最成熟、性能最好、ORM 支持完善 | 原生模块，Node 大版本升级或特殊平台需编译，开源用户安装失败率高 |
| libsql（Turso） | 兼容 SQLite，内置向量类型，未来可同步到云 | 原生模块；与上游 SQLite 有分叉 |
| sqlite3（node-sqlite3） | 老牌异步 | 慢、回调式、维护活跃度低 |

### S5 数据访问层

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ 手写 SQL + 自研迁移（`migrations/NNN_*.sql`） | 与 `node:sqlite` 无适配问题；FTS/vec 虚表、递归 CTE 直接写 | 无类型推导，需在仓储层手写 TS 类型 |
| Drizzle ORM | 类型安全、迁移生成 | 对 `node:sqlite` 支持需确认版本；虚表需原生 SQL |
| Kysely | 类型安全查询构建器，不绑定迁移 | `node:sqlite` 需社区方言；需维护表类型 |

### S6 HTTP 框架

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ Hono（`@hono/node-server`） | 轻量、TS 优先；Web 标准 `Request/Response`，可直接返回 AI SDK 的流式 Response；内置 SSE、静态文件、zod 校验中间件 | 插件生态小于 Fastify |
| Fastify | 成熟、JSON Schema 校验、插件丰富 | 流式需转换 Node stream；较重 |
| 原生 http（现状） | 零依赖 | 路由、校验、流式、静态托管都要自写，工作台 API 数量多后难维护 |
| Express | 最普及 | 性能与 TS 体验一般，异步错误处理弱 |

### S7 中文全文检索

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ `Intl.Segmenter('zh')` 预分词 + `unicode61` | 零依赖、内置 ICU 词典，「重排」「交叉编码器」可按词命中；查询同样分词 | 分词质量一般，专业新词可能被拆开 → 用 trigram 兜底 |
| FTS5 `trigram` | 内置，无需分词；子串命中 | 查询少于 3 个字（如「重排」）无法 MATCH，需 LIKE 回退；索引约 3 倍大小 |
| simple 扩展（jieba） | 分词质量好、支持拼音 | 原生扩展需按平台分发二进制 |
| nodejieba | 分词质量好 | 原生模块，安装问题同上 |

推荐组合：主索引用 Segmenter 预分词；查询词 < 3 字或主索引无结果时回退 trigram 表 / LIKE。

### S8 向量检索（对话与知识点合并）

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ sqlite-vec | 与 SQLite 同库同事务，删除级联简单；npm 提供各平台预编译；十万级向量毫秒级 | v0.x 阶段；暴力搜索为主（个人数据量足够） |
| JS 内存暴力计算 | 零依赖 | 每次启动全量载入内存；数据量大后慢 |
| LanceDB | 嵌入式、ANN 索引、性能强 | 另一个存储引擎，与 SQLite 数据一致性需自己维护；包体积大 |
| Orama | 纯 JS，全文 + 向量 | 内存型，持久化需序列化 |

### S9 二进制文件存储

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ `blobs/` 按 sha256 存文件，库表引用 | 数据库保持小，备份快；pdf.js 可直接按 URL 流式读取；天然去重 | 备份/导出需同时打包目录 |
| SQLite BLOB | 单文件，一致性最强 | 大文件使库膨胀，`VACUUM` 与备份变慢 |

### S23 工作台鉴权

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ 一次性登录链接（启动时打印并自动打开 `/app/login?code=`），服务换发 `HttpOnly; SameSite=Strict` Cookie | 用户无感；Cookie 不可被页面脚本读取 | 换浏览器需从终端或扩展弹窗重新打开链接 |
| 页面输入配对令牌，存 localStorage | 实现简单 | 令牌暴露给页面脚本；每次换浏览器都要粘贴 |
