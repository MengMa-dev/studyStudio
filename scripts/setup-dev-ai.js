#!/usr/bin/env node
// 开发环境 AI 配置：读取本机 key 文件 → 写入数据目录 secrets.json（0600）与 ai-seed.json → 逐个验证服务商。
// 用法：node scripts/setup-dev-ai.js [--check-only]
// key 文件每行「名称<分隔符>key」，分隔符可为 : = 或空白；默认 ../.api.txt，可用 STUDY_STUDIO_KEYS_FILE 覆盖。
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const keysFile = process.env.STUDY_STUDIO_KEYS_FILE ?? resolve(root, "..", ".api.txt");
const dataDir = process.env.STUDY_STUDIO_DATA_DIR ?? join(root, "StudyStudioData");
const checkOnly = process.argv.includes("--check-only");

const KEY_ALIASES = {
  gemini: ["gemini", "google"],
  openrouter: ["openrouter"],
  groq: ["groq", "grop"]
};

const providers = [
  { id: "ollama", name: "Ollama（本地）", type: "ollama", base_url: "http://127.0.0.1:11434/api", default_model: "qwen3:4b-instruct" },
  { id: "gemini", name: "Google Gemini", type: "google", base_url: "https://generativelanguage.googleapis.com/v1beta", default_model: "gemini-3.8-flash" },
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    default_model: "nvidia/nemotron-3-super-120b-a12b:free"
  },
  { id: "groq", name: "Groq", type: "openai-compatible", base_url: "https://api.groq.com/openai/v1", default_model: "openai/gpt-oss-120b" }
];

const taskModels = [
  { task: "learning_judge", provider_id: "ollama", model: "qwen3:4b-instruct", fallback_provider_id: "groq", fallback_model: "openai/gpt-oss-120b" },
  {
    task: "knowledge_processing",
    provider_id: "gemini",
    model: "gemini-3.8-flash",
    fallback_provider_id: "openrouter",
    fallback_model: "nvidia/nemotron-3-super-120b-a12b:free"
  },
  { task: "entry_rewrite", provider_id: "gemini", model: "gemini-3.5-flash-lite", fallback_provider_id: "openrouter", fallback_model: "qwen/qwen3.8-27b:free" },
  { task: "embedding", provider_id: "ollama", model: "nomic-embed-text", fallback_provider_id: null, fallback_model: null }
];

async function readKeys() {
  const keys = {};
  const text = await readFile(keysFile, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_-]+)\s*[:=：\s]\s*(\S+)$/);
    if (!match) continue;
    const name = match[1].toLowerCase();
    const id = Object.keys(KEY_ALIASES).find((key) => KEY_ALIASES[key].includes(name));
    if (id) keys[id] = match[2];
  }
  return keys;
}

async function check(provider, apiKey) {
  const signal = AbortSignal.timeout(15000);
  if (provider.type === "ollama") {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal });
    const names = (await res.json()).models.map((m) => m.name);
    const missing = ["qwen3:4b-instruct", "nomic-embed-text:latest"].filter((m) => !names.includes(m));
    return missing.length ? `缺少模型 ${missing.join(", ")}` : "ok";
  }
  if (!apiKey) return "未找到 key";
  const res =
    provider.type === "google"
      ? await fetch(`${provider.base_url}/models?pageSize=200`, { headers: { "x-goog-api-key": apiKey }, signal })
      : await fetch(`${provider.base_url}/${provider.id === "openrouter" ? "key" : "models"}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
  if (!res.ok) return `HTTP ${res.status}`;
  const body = await res.json();
  if (provider.id === "openrouter") {
    const daily = body.data?.free_model_daily_requests;
    return daily ? `ok（免费模型今日 ${daily.used}/${daily.limit}）` : "ok";
  }
  const ids = provider.type === "google" ? body.models.map((m) => m.name.replace(/^models\//, "")) : body.data.map((m) => m.id);
  const wanted = taskModels
    .flatMap((t) => [t.provider_id === provider.id && t.model, t.fallback_provider_id === provider.id && t.fallback_model])
    .filter(Boolean);
  const missing = wanted.filter((m) => !ids.includes(m));
  return missing.length ? `key 有效，但未列出模型 ${missing.join(", ")}` : "ok";
}

const keys = await readKeys();

if (!checkOnly) {
  await mkdir(dataDir, { recursive: true });
  const secretsPath = join(dataDir, "secrets.json");
  const existing = existsSync(secretsPath) ? JSON.parse(await readFile(secretsPath, "utf8")) : {};
  const secrets = { ...existing, providers: { ...existing.providers } };
  for (const [id, apiKey] of Object.entries(keys)) secrets.providers[id] = { apiKey };
  await writeFile(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  await chmod(secretsPath, 0o600);
  await writeFile(join(dataDir, "ai-seed.json"), `${JSON.stringify({ providers, task_models: taskModels }, null, 2)}\n`);
  console.log(`已写入 ${secretsPath}（0600）与 ai-seed.json，key：${Object.keys(keys).join(", ") || "无"}`);
}

for (const provider of providers) {
  const result = await check(provider, keys[provider.id]).catch((error) => `失败：${error.message}`);
  console.log(`${provider.id.padEnd(11)} ${result}`);
}
