export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function fmtMinutes(minutes: number): string {
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}` : `${minutes} 分钟`;
}

export function fmtShort(minutes: number): string {
  return minutes >= 60 ? `${+(minutes / 60).toFixed(1)} 小时` : `${minutes} 分`;
}

export function greetingText(period: "morning" | "afternoon" | "evening" | "night"): string {
  switch (period) {
    case "morning":
      return "早上好";
    case "afternoon":
      return "下午好";
    case "evening":
      return "晚上好";
    case "night":
      return "夜深了";
  }
}

export function organizeStatusLabel(status: string): { label: string; tone: string } {
  switch (status) {
    case "ingested":
      return { label: "已入库", tone: "green" };
    case "rejected":
      return { label: "未采纳", tone: "orange" };
    case "failed":
    case "pending":
    default:
      return { label: "待整理", tone: "purple" };
  }
}

export function readStatusLabel(status: string): { label: string; tone: string } {
  return status === "unread" ? { label: "未读", tone: "blue" } : { label: "已读", tone: "" };
}

export function siteShort(site: string | null): { color: string; short: string } {
  const map: Record<string, { color: string; short: string }> = {
    知乎: { color: "#0066ff", short: "知" },
    掘金: { color: "#1e80ff", short: "掘" },
    MDN: { color: "#1b1b1b", short: "M" },
    GitHub: { color: "#24292f", short: "GH" },
    Wikipedia: { color: "#636466", short: "W" },
    DeepSeek: { color: "#4d6bfe", short: "DS" },
    ChatGPT: { color: "#10a37f", short: "GPT" }
  };
  if (site && map[site]) return map[site];
  return { color: "#868e96", short: (site ?? "?").slice(0, 1) };
}

export function formatCapturedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date(Date.UTC(2026, 9, 2, 18, 0, 0));
  const sameDay = date.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10) === date.toISOString().slice(0, 10);
  const time = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${time}`;
  if (yesterday) return `昨天 ${time}`;
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${time}`;
}
