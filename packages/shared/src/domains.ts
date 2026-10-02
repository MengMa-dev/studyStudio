export type DomainCategory = "learning_candidate" | "unrelated" | "neutral";
export type SourceKind = "official_doc" | "repo" | "community" | "blog" | "ai_answer" | "other";

const LEARNING_DOMAINS = [
  "github.com",
  "gitlab.com",
  "stackoverflow.com",
  "stackexchange.com",
  "developer.mozilla.org",
  "wikipedia.org",
  "arxiv.org",
  "zhihu.com",
  "juejin.cn",
  "csdn.net",
  "cnblogs.com",
  "segmentfault.com",
  "medium.com",
  "dev.to",
  "substack.com",
  "infoq.cn",
  "chatgpt.com",
  "chat.openai.com",
  "chat.deepseek.com",
  "claude.ai",
  "gemini.google.com",
  "kimi.com",
  "doubao.com",
  "google.com",
  "bing.com",
  "baidu.com",
  "huggingface.co",
  "readthedocs.io",
  "npmjs.com",
  "pypi.org",
  "langchain.com",
  "langchain-ai.github.io",
  "python.org",
  "react.dev",
  "vuejs.org",
  "nodejs.org",
  "typescriptlang.org",
  "docs.rs",
  "go.dev"
];
const UNRELATED_DOMAINS = [
  "weibo.com",
  "douyin.com",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "xiaohongshu.com",
  "taobao.com",
  "tmall.com",
  "jd.com",
  "pinduoduo.com",
  "amazon.com",
  "iqiyi.com",
  "youku.com",
  "netflix.com",
  "bilibili.com",
  "douban.com",
  "hupu.com",
  "toutiao.com",
  "music.163.com",
  "qq.com"
];
const DOC_HOST = /(^|\.)(docs?|developer|developers|learn|wiki|api|reference)\./i;
const DOC_PATH = /\/(docs?|guide|guides|reference|api|manual|tutorial)(\/|$)/i;
const COMMUNITY = ["stackoverflow.com", "stackexchange.com", "zhihu.com", "segmentfault.com", "reddit.com", "v2ex.com", "juejin.cn"];
const BLOG = ["medium.com", "dev.to", "substack.com", "csdn.net", "cnblogs.com", "infoq.cn"];
const REPO = ["github.com", "gitlab.com", "gitee.com", "huggingface.co", "npmjs.com", "pypi.org"];

const matchesAny = (host: string, list: string[]) => list.some((domain) => host === domain || host.endsWith(`.${domain}`));

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function categorizeDomain(domain: string, extraUnrelated: string[] = []): DomainCategory {
  const host = domain.replace(/^www\./, "");
  if (matchesAny(host, [...UNRELATED_DOMAINS, ...extraUnrelated])) return "unrelated";
  if (matchesAny(host, LEARNING_DOMAINS) || DOC_HOST.test(`${host}.`)) return "learning_candidate";
  return "neutral";
}

export function sourceKindOf(type: string, url: string | null | undefined): SourceKind {
  if (type === "conversation") return "ai_answer";
  if (!url) return "other";
  const host = domainOf(url);
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {}
  if (matchesAny(host, REPO)) return "repo";
  if (DOC_HOST.test(`${host}.`) || DOC_PATH.test(path) || host.endsWith("readthedocs.io") || host === "developer.mozilla.org") return "official_doc";
  if (matchesAny(host, COMMUNITY)) return "community";
  if (matchesAny(host, BLOG)) return "blog";
  return "other";
}

export const SEARCH_ENGINES: { engine: string; host: RegExp; param: string; path?: RegExp }[] = [
  { engine: "google", host: /(^|\.)google\.[a-z.]+$/, param: "q", path: /^\/search/ },
  { engine: "bing", host: /(^|\.)bing\.com$/, param: "q", path: /^\/search/ },
  { engine: "baidu", host: /(^|\.)baidu\.com$/, param: "wd", path: /^\/s/ },
  { engine: "github", host: /^github\.com$/, param: "q", path: /^\/search/ },
  { engine: "duckduckgo", host: /(^|\.)duckduckgo\.com$/, param: "q" },
  { engine: "zhihu", host: /(^|\.)zhihu\.com$/, param: "q", path: /^\/search/ }
];

export function parseSearch(url: string): { engine: string; query: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    for (const rule of SEARCH_ENGINES) {
      if (!rule.host.test(host) || (rule.path && !rule.path.test(parsed.pathname))) continue;
      const query = parsed.searchParams.get(rule.param)?.trim();
      if (query) return { engine: rule.engine, query };
    }
  } catch {}
  return null;
}
