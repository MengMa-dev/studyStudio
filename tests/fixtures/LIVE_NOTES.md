# 真实网站 fixture 采集说明（M2）

采集日期：2026-10-03（UTC+8）。脚本：`scripts/capture-live-fixtures.ts`（Playwright `channel: "chromium"`，headless，持久 profile `.browser-profile`）。

精简规则（脚本内 `SANITIZE_SOURCE`）：删除 `script`（保留 `application/ld+json`）/ `style` / `link` / `svg` / `img` / `iframe` / 注释等；属性只保留 `href`、`ping`、`mu`、`id`、`role`、`name`、`placeholder`、`aria-*`、`data-*` 等，超长值截断到 400 字符；文档页 `pre` 内的高亮 span 拍平为 `<pre><code class="language-x">纯文本</code></pre>`；含 `pre` 的 Shadow DOM 以声明式 `<template shadowrootmode="open">` 保留（`page.setContent` 可还原 shadowRoot）。每个文件第二行注释记录了来源 URL。

重新采集：

```bash
PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright \
STUDY_STUDIO_BROWSER_PROFILE=$PWD/.browser-profile \
npx tsx scripts/capture-live-fixtures.ts [search|docs|chat] [--headed]
# 可选：ENGINES=bing,baidu 只采部分搜索引擎；CHATS=deepseek 只采部分对话
```

## Fixture 清单

| 文件                                 | 来源                                                                        | 根节点                          |
| ------------------------------------ | --------------------------------------------------------------------------- | ------------------------------- |
| `search-bing.html`                   | `https://www.bing.com/search?q=langgraph%20interrupt`                       | `#b_results`                    |
| `search-baidu.html`                  | `https://www.baidu.com/s?wd=langgraph%20interrupt`                          | `#content_left`                 |
| `search-github.html`                 | `https://github.com/search?q=langgraph%20interrupt&type=repositories`       | `[data-testid='results-list']`  |
| `doc-langgraph-hitl.html`            | `https://docs.langchain.com/oss/python/langgraph/interrupts`                | `body`（含 head 的 og / ld+json） |
| `doc-mdn-intersection-observer.html` | `https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API` | `body`                          |
| `chatgpt-live-2026-10-03.html`       | `https://chatgpt.com/uc/<id>`（未登录态，见下）                              | `main`                          |
| `deepseek-live-2026-10-03.html`      | `https://chat.deepseek.com/a/chat/s/<id>`                                   | `#root`（已删侧栏历史列）        |

## 搜索结果链接形式（决定「从搜索结果点入」如何识别）

| 引擎   | 搜索页 URL（`parseSearch` 可解析）     | 结果链接 `href`                                                                                     | 真实目标                                                         |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Bing   | `/search?q=...`（会追加 `rdr=1&rdrig=`） | 跳转链接 `https://www.bing.com/ck/a?!&&p=...&u=a1<base64url>&ntb=1`                                  | `u` 参数去掉前缀 `a1` 后 base64url 解码                          |
| Baidu  | `/s?wd=...`                            | 跳转链接 `http://www.baidu.com/link?url=<加密串>`（不可解码）                                       | 结果容器 `.c-container[mu]` 的 `mu` 属性；AI / 聚合卡片的 `mu` 为 `http://nourl.ubs.baidu.com/...` 等非真实地址 |
| GitHub | `/search?q=...&type=repositories`      | 直链（相对路径）`/owner/repo`，`data-component="Link"`                                              | 即 href                                                          |
| Google | —                                      | 未采集（见下）。按经验现代 Google 结果 `href` 为直链，另有 `ping="/url?...&url=..."`；旧版 / 无 JS 版为 `/url?q=<目标>` | —                                                                |

识别建议（落地页 referrer 本次未实测）：Bing / Baidu 走跳转中间页，且搜索页通常设置了 referrer 策略，落地页 `document.referrer` 预计最多只有搜索引擎源，无法从中反查 query；应以「同一 tab 上一个 `search_performed`」+「落地页 referrer 的 host 属于搜索引擎」（或跳转中间页 `bing.com/ck/a`、`baidu.com/link` 的 tab 导航序列）判定来源，不要依赖 referrer 里的 `q` / `wd`。

## 长文档页结构（内容露出测试用）

- **LangGraph**：旧地址 `https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/` 已重定向到 `https://docs.langchain.com/oss/python/langgraph/interrupts`（Mintlify 站点）。
  - 正文段落大多是 `<span data-as="p">`（59 个），真正的 `<p>` 只有 5 个。块级选择器只用 `p` 会漏掉几乎所有正文，需要加 `[data-as='p']`（或按 display:block 判定）。
  - `main` 1 个、无 `article`；标题 h1×1、h2×13、h3×11，`li`×78、`pre`×33（含 Python / JS 代码 tab；精简时删除 `[hidden]` / `button` / `form` / `dialog` 后 fixture 保留 26 个）。右侧目录在 `#table-of-contents`（`li.toc-item`），与正文同在 `main` 内，正文容器需排除。
  - 每个代码示例后有一个「View example trace」h2（Mintlify 组件），会被当作章节标题，章节汇总时可能需过滤。
- **MDN**：`main` 1 个、无 `article`；h1×1、h2×9、h3×6、h4×12、`p`×80、`li`×33、`table`×2。
  - 代码块全部是 `<mdn-code-example>` 自定义元素，`pre` 在其 **Shadow DOM** 内（light DOM 中 `pre` 数量为 0）。按 `01-collection-sync.md` 的限制说明，这类块监听不到；实时页面检测到 23 个含 `pre` 的 `mdn-code-example`，精简后 fixture 用声明式 shadow DOM 保留 10 个，可用来测「Shadow DOM 内容退回 `maxScrollDepth`」或主动穿透 open shadowRoot。
  - 其余 Web Component（`mdn-dropdown`、`mdn-placement-*` 广告位等）的 shadow 内容未保留。

## AI 对话：URL 与 `conversationId`

| 平台     | 新对话发送前 | 发送后                                    | URL 变化时机                                                                                       | 解析规则                                                    |
| -------- | ------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| ChatGPT  | `https://chatgpt.com/` | `https://chatgpt.com/uc/6ac003a8-d54c-83ea-bb04-28d7229e9e47`（未登录） | 回车后约 1.1–1.4 s，经 `history.pushState`；此时用户消息与 `pending-` 助手消息已挂载、回答仍在流式输出 | `^/(?:g/[^/]+/)?(?:c\|uc)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`；DOM 兜底：`section[data-conversation-id]` |
| DeepSeek | `https://chat.deepseek.com/` | `https://chat.deepseek.com/a/chat/s/219872f6-17aa-48f6-9fdb-42ddf1f04bb0` | 提交瞬间（<100 ms，早于用户消息渲染完成）                                                         | `^/a/chat/s/([0-9a-f-]{36})`                                |

- ChatGPT 的 `/uc/` 是**未登录**会话路径（本次 profile 的 ChatGPT 登录已失效，见「未能采集」）。登录态的 `/c/<id>`、GPTs 的 `/g/<gizmo>/c/<id>` 本次未实测，正则先一并兼容。ID 形如 UUID 但不是 v4（第三段 `83ea`）。
- 由于 ChatGPT 新对话发送时 URL 仍是 `/`，`user_message_sent` 在发送瞬间拿不到 `conversationId`；应在 URL 变化后（或 `assistant_response_completed` 时）回填，或读 `section[data-conversation-id]`。
- ChatGPT 页面另有 `section[aria-label="对话 chat-<uuid>"]`，这是客户端临时 id，**不是** conversationId。
- DeepSeek 标题在回答后变为「<自动标题> - DeepSeek」。

## DOM 差异（对比 `chatgpt-2026.html` / `deepseek.html`）

两份 live fixture 已用现有 `conversation-adapters.js` 验证：完成态下 `getComposer` / `getUserMessages` / `getAssistantMessages` / `extractMessage` 均正确，`isGenerating` 为 false。

### ChatGPT（结构与 `chatgpt-2026.html` 一致，新增若干属性）

一致：`ol[aria-label="对话"][data-conversation-transcript]` > `li[data-message-role=user|assistant]`；`h4[data-message-attribution]`；`button[data-user-message-bubble] > p[data-user-message-copy]`；`[data-assistant-placeholder-slot]` + `[data-assistant-markdown]`；`li[data-assistant-content-started][data-message-complete]`；`textarea#mobile-composer-prompt[name=prompt][data-mobile-composer-prompt][aria-label="与 ChatGPT 聊天"]`；`[data-composer-dock]`、`button[data-composer-submit]`。

新增 / 差异：

| 项目           | live（2026-10-03）                                                                                                                                                                   | 现有 fixture                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 外层           | `section[data-web-mobile-conversation][data-conversation-id=<id>]` > `[data-mobile-thread]` > … > `ol`                                                                              | `main > ol`                                     |
| 消息 id        | `li#<message-uuid>`；流式期间助手为 `li#pending-<uuid>[data-message-streaming]`，URL 切换后换成真实 id 并移除 `data-message-streaming`                                               | 无 `data-message-streaming`                     |
| 回答段落       | `[data-assistant-markdown] > p[data-assistant-stream-block][data-assistant-stream-block-index]`                                                                                      | 直接 `<p>`                                      |
| 发送按钮       | `button[data-composer-submit][data-send-label="发送消息"][data-stop-label="停止生成"]`；生成中 `aria-label="停止生成"` + `type=button` + `data-stop-generating`；空闲 `aria-label="发送消息"` + `type=submit` + `aria-disabled=true` + `data-visually-disabled` | 只切换 `aria-label`                             |
| 消息操作       | 用户消息 `[data-user-message-actions][role=menu]`，`button[data-copy-message]`；助手 `[data-assistant-message-actions]`、`[data-share-message]`                                     | 无                                              |
| 其他           | 富文本输入宿主 `[data-composer-editor-host]` / `[data-octane-lexical-host]`（textarea 仍存在）；未登录标记 `[data-logged-out]`、`button[data-login-button]`                         | —                                               |

对 adapter 的影响：现有 `isGenerating`（`button[aria-label*='停止']` 或最后一条助手缺 `data-message-complete`）仍有效；可额外用 `[data-message-streaming]` / `[data-stop-generating]` 作更稳的判定。`extractMessage` 删除 `[data-assistant-placeholder-slot]` 后正常。

### DeepSeek（结构与 `deepseek.html` 一致，「生成中」判定失效）

一致：`.ds-virtual-list-items` > `[data-virtual-list-item-key]` > `.ds-message`；用户消息 `.ds-message.d29f3d7d > .fbb737a4 > .ds-collapsible-text > div > span`（比 fixture 多两层）；助手 `.ds-message > .ds-markdown.ds-assistant-message-main-content > p.ds-markdown-paragraph > span`；`textarea[name=search][placeholder="给 DeepSeek 发送消息 "]`；发送按钮 `div[role=button].ds-button--primary.ds-button--circle`（无 `id`、无 `aria-label`）。

差异：

| 项目       | live（2026-10-03）                                                                                                                                                                                  | 现有 fixture                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| key 取值   | 用户 `-2`、助手 `2`（新对话也一样，非 `u-new`/`a-new`）                                                                                                                                              | `u-new` / `a-new`                    |
| 生成中     | **没有** `aria-label*='停止'`、`.ds-loading`、`.ds-button--loading`；发送按钮在 composer 为空时仍可点（`tabindex=0`、无 `ds-button--disabled`），即变成停止按钮                                       | 发送按钮 `aria-label="停止生成"`     |
| 完成后     | 发送按钮加 `ds-button--disabled`（composer 为空时），去掉 `tabindex`                                                                                                                               | 移除 `aria-label`                    |
| 消息操作栏 | 消息外侧兄弟节点 `.ds-flex` 内多个 `div[role=button].ds-button--iconLabelTertiary`（复制、重新生成、`aria-label="朗读"` 等）                                                                         | 无                                   |
| 其他       | 顶部标题栏 `.the-header`（会话标题）；模式开关 `.ds-toggle-button`（「深度思考」`aria-pressed=false`、「智能搜索」`aria-pressed=true`）；`input[type=file]`                                            | —                                    |

对 adapter 的影响：`deepseekAdapter.isGenerating` 在真实页面上全程返回 false，只能靠 `stableMs` 文本稳定判定完成。建议补充：「composer 为空且主按钮不含 `ds-button--disabled`」视为生成中。

## 未能采集 / 未验证

- **Google 搜索**：headless 与 `--headed` 均被重定向到 `https://www.google.com/sorry/index?...`（验证码，按本机 IP 拦截），已跳过。
- **ChatGPT 登录态**：profile 中的 ChatGPT 会话已失效（页面出现「登录后使用」、`data-logged-out`、`data-login-button`，headed 同样如此），只采到未登录 UI 与 `/uc/<id>` URL。登录态 `/c/<id>`、侧栏历史、账号菜单的结构未验证；需手动 `npm run browser:login` 重新登录后再跑 `CHATS=chatgpt npx tsx scripts/capture-live-fixtures.ts chat`。
- **DeepSeek 深度思考**：使用默认模式（深度思考关闭），未采到 `.ds-think-content` 的真实结构。
- 采集期间共新建 ChatGPT 未登录会话 2 个、DeepSeek 会话 3 个（同一问题），fixture 取最后一次。
