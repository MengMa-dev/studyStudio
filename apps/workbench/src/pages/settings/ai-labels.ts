import type { AiProvider, AiProviderType, AiTaskName } from "@study-studio/shared";

export const PROVIDER_TYPE_LABEL: Record<AiProviderType, string> = {
  "openai-compatible": "OpenAI 兼容",
  google: "Google Gemini",
  ollama: "Ollama（本地）",
  anthropic: "Anthropic",
  mock: "Mock（测试用）"
};

export const PROVIDER_TYPE_COLOR: Record<AiProviderType, string> = {
  "openai-compatible": "#10a37f",
  google: "#4285f4",
  ollama: "#343a40",
  anthropic: "#d97757",
  mock: "#868e96"
};

export const BASE_URL_PLACEHOLDER: Record<AiProviderType, string> = {
  "openai-compatible": "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  ollama: "http://127.0.0.1:11434/api",
  anthropic: "https://api.anthropic.com/v1",
  mock: "无需填写"
};

export const TASK_META: { task: AiTaskName; label: string; en: string; desc: string }[] = [
  { task: "learning_judge", label: "学习判定", en: "Learning judge", desc: "只读行为摘要（搜索词、标题、提问、时长），调用最频繁，建议本地小模型" },
  { task: "knowledge_processing", label: "知识处理", en: "Knowledge processing", desc: "判定 + 抽取 + 词条对齐 + 补丁一次完成，需要读正文，建议强模型" },
  { task: "entry_rewrite", label: "词条重写", en: "Entry rewrite", desc: "仅手动重新整理、过期词条和全量整理时调用，中档模型即可" },
  { task: "embedding", label: "向量 Embedding", en: "Embedding", desc: "整理时检索与写入同步调用，建议本地；更换后需在「数据与隐私」重建索引" },
  { task: "chat", label: "首页对话", en: "Chat", desc: "回答学习记录与知识库问题，需要支持 tools 调用；未配置时使用「知识处理」的模型" }
];

export function providerStatusText(provider: AiProvider): string {
  if (provider.status === "connected") return provider.usedByTasks.length ? `已连接 · 用于 ${provider.usedByTasks.length} 项任务` : "已连接";
  if (provider.status === "error") return "连接失败，请检查配置后重新测试";
  return provider.usedByTasks.length ? `未测试 · 用于 ${provider.usedByTasks.length} 项任务` : "未配置";
}

export function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** `API 409: {"error":"provider_in_use",...}` → readable message. */
export function apiErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const body = message.replace(/^API \d+:\s*/, "");
  try {
    const parsed = JSON.parse(body) as { error?: string; tasks?: AiTaskName[] };
    if (parsed.error === "provider_in_use") {
      const names = (parsed.tasks ?? []).map((task) => TASK_META.find((meta) => meta.task === task)?.label ?? task);
      return `仍被「${names.join("、")}」使用，请先改选这些任务的模型`;
    }
    if (parsed.error) return parsed.error;
  } catch {
    /* plain text */
  }
  return body || message;
}
