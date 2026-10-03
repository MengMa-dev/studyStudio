import type {
  KbEntryKind,
  KbRelation,
  KbSourceKind,
  OrganizeDecision,
  OrganizeRunItemStatus,
  OrganizeRunStatus,
  OrganizeScope,
  OrganizeStage,
  OrganizeTrigger
} from "@study-studio/shared";

export const KIND_LABEL: Record<KbEntryKind, string> = {
  concept: "概念",
  method: "方法",
  algorithm: "算法",
  model: "模型",
  paper: "论文",
  other: "其他"
};

/** Kinds offered in the type filter (08: 概念/方法/算法/模型/论文). */
export const FILTER_KINDS: KbEntryKind[] = ["concept", "method", "algorithm", "model", "paper"];

export function masteryColor(mastery: number | null): string {
  if (mastery === null) return "#ced4da";
  return mastery >= 0.65 ? "#2f9e44" : mastery >= 0.45 ? "#4c6ef5" : mastery >= 0.3 ? "#f08c00" : "#e03131";
}

export function masteryLabel(mastery: number | null): string {
  if (mastery === null) return "未估算";
  return mastery >= 0.65 ? "熟悉" : mastery >= 0.45 ? "了解" : mastery >= 0.3 ? "薄弱" : "陌生";
}

export function masteryPercent(mastery: number | null): string {
  return mastery === null ? "—" : `${Math.round(mastery * 100)}%`;
}

export const WEAK_MASTERY = 0.4;

export const SOURCE_KIND_LABEL: Record<KbSourceKind, string> = {
  official_doc: "官方文档",
  repo: "代码仓库",
  community: "社区",
  blog: "博客",
  ai_answer: "AI 回答",
  other: "其他"
};

type RelationGroup = { label: string; match: (relation: KbRelation) => boolean };

/** Display order for related entries in the detail sidebar (08: 属于/组成/前置/对比/相关). */
export const RELATION_GROUPS: RelationGroup[] = [
  { label: "属于", match: (r) => r.type === "part_of" && r.direction === "out" },
  { label: "组成部分", match: (r) => r.type === "part_of" && r.direction === "in" },
  { label: "前置知识", match: (r) => r.type === "prerequisite" && r.direction === "in" },
  { label: "是它的前置", match: (r) => r.type === "prerequisite" && r.direction === "out" },
  { label: "对比", match: (r) => r.type === "contrasts" },
  { label: "相关", match: (r) => r.type === "related" }
];

export const TRIGGER_LABEL: Record<OrganizeTrigger, string> = {
  manual: "手动",
  daily: "每天定时",
  batch: "攒够数量",
  on_ingest: "入箱即整理",
  catch_up: "补跑",
  retry: "重试"
};

export const SCOPE_LABEL: Record<OrganizeScope, string> = {
  inbox_selected: "收集箱 · 已选",
  inbox_pending: "收集箱 · 待整理",
  inbox_all: "收集箱 · 全量",
  kb_selected: "知识库 · 已选知识点",
  kb_pending: "知识库 · 待整理",
  kb_all: "知识库 · 全量",
  item: "单条内容",
  entry: "单个知识点"
};

export const RUN_STATUS: Record<OrganizeRunStatus, { label: string; tone: string }> = {
  queued: { label: "排队中", tone: "blue" },
  running: { label: "整理中", tone: "purple" },
  completed: { label: "已完成", tone: "green" },
  failed: { label: "失败", tone: "red" },
  paused: { label: "已暂停（达到每日上限）", tone: "orange" }
};

export const STAGE_LABEL: Record<OrganizeStage, string> = {
  context: "上下文加载",
  episode: "片段切分",
  learning_judge: "学习判定",
  retrieve: "检索与预过滤",
  knowledge_processing: "知识处理",
  integration: "知识入库",
  entry_rewrite: "词条重写",
  embedding: "向量索引"
};

export const DECISION_LABEL: Array<{ key: "new" | "supplement" | "duplicate" | "reject" | "notLearning"; label: string; tone: string }> = [
  { key: "new", label: "新知识", tone: "green" },
  { key: "supplement", label: "补充", tone: "teal" },
  { key: "duplicate", label: "重复（挂来源）", tone: "blue" },
  { key: "reject", label: "不入库", tone: "orange" },
  { key: "notLearning", label: "非学习片段", tone: "" }
];

export const DECISION_TEXT: Record<OrganizeDecision, string> = {
  new: "新知识",
  supplement: "补充",
  duplicate: "重复",
  reject: "不入库",
  not_learning: "非学习"
};

export const RUN_ITEM_STATUS: Record<OrganizeRunItemStatus, { label: string; tone: string }> = {
  pending: { label: "待处理", tone: "" },
  ingested: { label: "已入库", tone: "green" },
  rejected: { label: "未采纳", tone: "orange" },
  failed: { label: "失败", tone: "red" },
  skipped: { label: "跳过（无变化）", tone: "" }
};

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatElapsed(startedAt: string | null, finishedAt: string | null): string | null {
  if (!startedAt || !finishedAt) return null;
  const seconds = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
