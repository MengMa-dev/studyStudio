import type { AgentSkillTarget } from "@study-studio/shared";
import { AGENT_SKILL_VERSION } from "./tools.js";

/** `organize-kb` skill (installed as `<client>/skills/organize-kb/SKILL.md`). Kept as a TS string so the tsup bundle carries it; `skills/organize-kb/SKILL.md` is a test-enforced copy for agents installing from GitHub. */

export const SKILL_NAME = "organize-kb";

export const SKILL_DIRS: Record<AgentSkillTarget, string> = { cursor: ".cursor", claude: ".claude", codex: ".codex" };

export const INSTALL_GUIDE_URL = "https://github.com/MengMa-dev/studyStudio/blob/HEAD/skills/INSTALL.md";

export const SKILL_MARKDOWN = `---
name: ${SKILL_NAME}
description: 整理 Study Studio 收件箱到知识库，或把当前对话 / 本地文件录入并整理到知识库。用户说「整理收件箱 / 整理学习记录 / organize inbox」「把刚才的对话整理到知识库」「把这个文件整理到知识库」或要求安装 Study Studio skills 时使用。需要本地 Study Studio 服务与 study-studio MCP。
skillVersion: ${AGENT_SKILL_VERSION}
---

## 前置条件

本 skill 依赖本地 Study Studio 服务及其 study-studio MCP，缺一不可。用户要求安装本 skill，或当前会话没有 study-studio 的 MCP 工具（get_guidelines、start_session 等）时：

1. 先向用户确认，并等待明确同意：「Study Studio 的 skills 需要同时安装并启动本地服务（通过本地 MCP 读写知识库），否则无法生效。是否现在克隆、启动服务并安装 skills 与 MCP？」
2. 用户同意 → 按 ${INSTALL_GUIDE_URL} 执行安装；用户拒绝 → 结束，不做任何改动。
3. 服务已安装但未运行（MCP 连不上）→ 告诉用户在 Study Studio 目录运行 \`npm start\`（或 \`npx study-studio\`）后重试。

## 整理流程

你是知识库（wiki）的维护者：逐篇读来源、与用户确认方案，再写入词条。

1. 调用 get_guidelines，后续汇报与写作严格按其规范。
2. start_session，记下 run_id；若返回 busy，告诉用户自动整理或其他会话正在运行，稍后再试，结束。
3. list_inbox 取一批单元（用 next_cursor 翻页），以返回的 unit_key 逐篇处理，一次只处理一篇：
   a. get_unit 读全文（text 或 turns）、用户划线、条目备注与模糊备注；
   b. 对每个概念 search_kb，命中时 get_entry 读正文与章节（sections），list_vocab 查看类型与分类；
   c. 向用户汇报方案，然后停下等待确认：
      - 关键要点；
      - 计划新建 / 补充的词条与各章节标题，已被已有章节覆盖的内容（只追加来源）；
      - 按备注或判断要剔除的内容；
      - 与已有内容的矛盾、要建立的关系；
      - 或建议不入库及理由（非学习内容 / 低价值）；
   d. 用户确认或修改后按最终方案写入：
      - write_entry：补充已有词条（entry_id）或新建词条（new），sections 的 source_item_ids 填内容来自的条目 / 问答轮 id；
      - attach_source：已被某章节覆盖的内容，给该章节追加来源；
      - add_relation：建立词条关系；
   e. finish_unit：已写入 → organized；不入库 → rejected（附 reject_reason）或 not_learning；用户说跳过 → skipped。
   工具返回 ok: false 时按 error / message / details 修正后重试：
      - name_exists：已有同名词条，改为对返回的 entry_id 写入；
      - name_ignored：名称在忽略名单中，不新建该词条，对应内容不入库；
      - invalid_source：source_item_ids / item_ids 只能用 get_unit 返回的 item_ids；
      - invalid_kind：kind 从 list_vocab 的 kinds 中选；
      - section_not_found：重新 get_entry 取 sections；
      - nothing_written：organized 前需要先写入，否则改用 rejected / not_learning；
      - unit_has_writes：该单元已写入词条，只能以 organized 结束；
      - already_organized / unit_not_found：跳过该单元，重新 list_inbox。
4. 处理完或用户要求停止 → finish_session(run_id, summary)，向用户汇报新建 / 补充 / 不入库数量与词条名。

## 整理当前对话或文件

用户说「把刚才的对话整理到知识库」「把这个文件整理到知识库」时：

1. 按整理流程第 1–2 步 get_guidelines、start_session。
2. add_to_inbox 录入原文（agent 填当前 Agent 名：Cursor / Claude Code / Codex）：
   - 对话：source="conversation"，turns 按顺序列出与学习相关的每轮问答，question 为用户原话、answer 为你的回答原文，逐字照录（含代码与格式），不摘要、不改写、不补充；可略去与学习无关的轮次（如安装、闲聊）；
   - 文件：source="file"，file_path 为用户选中或提及文件的绝对路径（服务端读取原文，仅支持文本文件）。
3. 只对返回的 unit_key 执行整理流程第 3 步 a–e（同样先汇报方案、等待确认），然后 finish_session 并汇报。

禁止：未经用户确认就写入；编造来源中没有的内容；在正文中手写 \`<!-- section … -->\` 标记；用其他方式修改知识库文件或数据库。
`;
