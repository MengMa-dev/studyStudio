import { AGENT_SKILL_VERSION } from "./tools.js";

/** `organize-kb` skill (installed as `<client>/skills/organize-kb/SKILL.md`). Kept as a TS string so the tsup bundle carries it. */

export const SKILL_NAME = "organize-kb";

export const SKILL_MARKDOWN = `---
name: ${SKILL_NAME}
description: 整理 Study Studio 收件箱到知识库。用户说「整理收件箱 / 整理学习记录 / organize inbox」时使用。需要 study-studio MCP。
skillVersion: ${AGENT_SKILL_VERSION}
---

1. 调用 get_guidelines(stage="all")，后续判断与写作严格按其规则。
2. start_session，记下 run_id；若返回 busy，告诉用户自动整理或其他会话正在运行，稍后再试，结束。
3. list_inbox 取一批单元（用 next_cursor 翻页），以返回的 unit_key 逐个处理：
   a. get_unit 读全文分块、用户划线与笔记；
   b. 判定：非学习内容 → not_learning；低价值 / 导航 / 临时 → reject（附 reject_reason）；
   c. 抽取知识点（按规则，quote 从 chunks 原文逐字摘录，按顺序编号 p1…pn）；
   d. 每个概念 search_kb，必要时 get_entry 对比，决定补充已有词条或新建；
      全部已覆盖 → duplicate；但 has_note / has_highlight 为 true 的单元不能 duplicate，必须 compose（已覆盖的知识点在 compose.dropped 中以 covered 标注）；
   e. list_vocab 选 kind / 分类（优先复用）；
   f. submit_decision（带 run_id、unit_key，每单元一次）。返回 ok: false 时按 error / message / details 修正后重交，同一单元最多 3 次：
      - quote_not_found：对应 quote 不是原文，改为逐字摘录；
      - invalid_compose：按列出的问题修正 compose；
      - missing_points：把遗漏的知识点写入 compose 或在 dropped 中说明；
      - invalid_input：补齐该 decision 必需的字段；
      - marked_requires_compose：改用 compose 提交；
      - already_organized / unit_not_found：跳过该单元，重新 list_inbox；
      3 次仍失败 → reject(low_information)，并在 finish_session 的 summary 中说明。
4. 处理完或用户要求停止 → finish_session(run_id, summary)，向用户汇报新建 / 补充 / 拒绝数量与词条名。

禁止：编造引文；跨单元合并提交；用其他方式修改知识库文件或数据库。
`;
