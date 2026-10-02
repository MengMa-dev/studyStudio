import { join } from "node:path";
import { build } from "esbuild";
import { launchBrowser, positionalArgs } from "./lib/browser.js";

/**
 * Opens a real conversation site with the collector runtime injected and reports DOM probes and events.
 * Usage: node scripts/debug-live-chat.js [url] [question] [--headed]
 */
const [url = "https://chatgpt.com/", question = "用一句话解释什么是向量召回"] = positionalArgs();
const root = process.cwd();
const { outputFiles } = await build({ entryPoints: [join(root, "packages/collector-runtime/src/browser-collector.js")], bundle: true, format: "iife", globalName: "StudyStudioCollector", platform: "browser", target: ["chrome120"], write: false });

const context = await launchBrowser();
const page = context.pages()[0] ?? await context.newPage();
page.on("console", (message) => { if (message.text().startsWith("[ss]")) console.log(message.text()); });
page.on("pageerror", (error) => console.log("[pageerror]", error.message));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8_000);

const probe = () => page.evaluate(() => {
  const adapter = window.StudyStudioCollector?.resolveConversationAdapter(location);
  if (!adapter) return { url: location.href, adapter: null };
  return {
    url: location.href,
    platform: adapter.platform,
    composer: adapter.getComposer(document)?.outerHTML.slice(0, 80) ?? null,
    users: adapter.getUserMessages(document).length,
    assistants: adapter.getAssistantMessages(document).length,
    generating: adapter.isGenerating(document)
  };
});
await page.addScriptTag({ content: outputFiles[0].text }).catch((error) => console.log("[inject error]", error.message));
console.log("[probe:before]", await probe());
await page.evaluate(() => {
  window.StudyStudioCollector.installCollector({
    emit: (event) => console.log(`[ss] ${event.type} ${JSON.stringify({ q: event.message?.plainText, a: event.answer?.markdown?.slice(0, 300), platform: event.source?.platform })}`),
    channel: "browser_extension"
  });
}).catch((error) => console.log("[install error]", error.message));

const composer = page.locator("#prompt-textarea, textarea[name='prompt'], textarea[name='search'], textarea#chat-input, textarea").first();
await composer.click();
await composer.pressSequentially(question, { delay: 30 });
await page.waitForTimeout(500);
console.log("[probe:typed]", await probe());
await page.keyboard.press("Enter");
await page.waitForTimeout(3_000);
console.log("[probe:sent]", await probe());
await page.waitForTimeout(25_000);
console.log("[probe:after]", await probe());
await context.close();
