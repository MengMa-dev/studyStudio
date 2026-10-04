import { RULES as COMPOSE_RULES } from "../../ai/prompts/knowledge-compose.js";
import { RULES as EXTRACT_RULES } from "../../ai/prompts/knowledge-extract.js";
import { RULES as TRIAGE_RULES } from "../../ai/prompts/knowledge-triage.js";
import { PROCESSING_PROMPT_VERSION } from "../organize/process.js";

export const AGENT_GUIDELINES_VERSION = `organize-agent@1(${PROCESSING_PROMPT_VERSION})`;

export type GuidelineStage = "triage" | "extract" | "compose" | "all";

const SECTIONS = {
  triage: { title: "判定", rules: TRIAGE_RULES },
  extract: { title: "抽取知识点", rules: EXTRACT_RULES },
  compose: { title: "组织写作", rules: COMPOSE_RULES }
} as const;

const AGENT_CONSTRAINTS = `- 引文必须原文摘录，不得改写或编造。
- 知识点按提交顺序编号 p1…pn；组织写作中的 point_ids 等引用这些编号。
- 一个单元一次 submit_decision。
- 校验失败按返回信息修正后重交，同一单元最多 3 次；仍失败则 reject(low_information)，并在 finish_session.summary 中说明。`;

export function buildGuidelines(stage: GuidelineStage): { version: string; markdown: string } {
  const stages = stage === "all" ? (["triage", "extract", "compose"] as const) : [stage];
  const blocks = [
    `# 整理规则（version: ${AGENT_GUIDELINES_VERSION}）`,
    ...stages.map((key) => `## ${SECTIONS[key].title}\n\n${SECTIONS[key].rules}`),
    `## Agent 补充约束\n\n${AGENT_CONSTRAINTS}`
  ];
  return { version: AGENT_GUIDELINES_VERSION, markdown: blocks.join("\n\n") };
}
