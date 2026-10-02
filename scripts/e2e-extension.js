import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { launchBrowser, positionalArgs } from "./lib/browser.js";

/**
 * Loads apps/browser-extension into Playwright's Chromium (headless by default, shared logged-in
 * profile), pairs it with the running ingestion service, asks one question on a real site and
 * reports what reached StudyStudioData.
 * Usage: node scripts/e2e-extension.js [url] [question] [--headed]
 * Env: E2E_RELOAD_EXTENSION=1 reloads the extension after the tab is open (no page refresh);
 *      E2E_SEND=click clicks the send button instead of pressing Enter.
 */
const [url = "https://chatgpt.com/", question = "用一句话解释向量召回"] = positionalArgs();
const root = process.cwd();
const dataDir = process.env.STUDY_STUDIO_DATA_DIR ?? join(root, "StudyStudioData");
const pairingToken = process.env.STUDY_STUDIO_TOKEN ?? (await readFile(join(dataDir, ".pairing-token"), "utf8")).trim();

const context = await launchBrowser({ extension: true });
let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
await worker.evaluate((token) => chrome.storage.local.set({ ingestionUrl: "http://127.0.0.1:43118", pairingToken: token }), pairingToken);
console.log("[extension]", worker.url());

const startedAt = new Date().toISOString();
const page = context.pages()[0] ?? (await context.newPage());
page.on("pageerror", (error) => console.log("[pageerror]", error.message.slice(0, 200)));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8_000);

if (process.env.E2E_RELOAD_EXTENSION) {
  // Same as a user clicking the reload icon on chrome://extensions.
  const previous = worker;
  const extensionsPage = await context.newPage();
  await extensionsPage.goto("chrome://extensions");
  await extensionsPage.locator("#devMode").click();
  await extensionsPage.locator("extensions-item #dev-reload-button").click();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(500);
    const next = context.serviceWorkers().find((candidate) => candidate !== previous);
    if (next) {
      worker = next;
      break;
    }
  }
  await extensionsPage.close();
  await page.bringToFront();
  await page.waitForTimeout(2_000);
  const reloadedAt = await worker.evaluate(() => globalThis.__startedAt ?? (globalThis.__startedAt = Date.now()));
  console.log("[extension reloaded without refreshing the tab]", { newWorker: worker !== previous, workers: context.serviceWorkers().length, reloadedAt });
}

const composer = page.locator("#prompt-textarea, textarea[name='prompt'], textarea[name='search'], textarea#chat-input, textarea").first();
await composer
  .waitFor({ timeout: 15_000 })
  .then(() => composer.focus())
  .catch(async (error) => {
    await page.screenshot({ path: join(tmpdir(), "study-studio-e2e.png") });
    console.log("[no composer] page:", page.url(), "screenshot:", join(tmpdir(), "study-studio-e2e.png"));
    throw error;
  });
await composer.pressSequentially(question, { delay: 30 });
if (process.env.E2E_SEND === "click") {
  await page.evaluate(() => {
    const textarea = document.querySelector("textarea");
    const buttons = [...document.querySelectorAll("[role='button'], button")].filter(
      (button) => textarea.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    (buttons.find((button) => button.classList.contains("ds-button--primary")) ?? buttons.at(-1)).click();
  });
} else {
  await page.keyboard.press("Enter");
}
console.log("[sent]", question);
await page.waitForTimeout(30_000);
await page.screenshot({ path: join(tmpdir(), "study-studio-e2e.png") });
console.log("[screenshot]", join(tmpdir(), "study-studio-e2e.png"));

const timelineDir = join(dataDir, "timeline");
const entries = [];
for (const file of await readdir(timelineDir)) {
  for (const line of (await readFile(join(timelineDir, file), "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.occurredAt >= startedAt) entries.push(entry);
  }
}
entries.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
for (const entry of entries)
  console.log("[timeline]", entry.type, entry.source.url, entry.message?.plainText ?? entry.answer?.preview ?? "", entry.artifact ?? "");
const pending = await worker.evaluate(() => chrome.storage.local.get("pendingEvents").then((value) => value.pendingEvents?.length ?? 0));
console.log("[pending in extension queue]", pending);
const ok =
  entries.some((entry) => entry.type === "user_message_sent") && entries.some((entry) => entry.type === "assistant_response_completed" && entry.artifact);
console.log(ok ? "E2E PASS" : "E2E FAIL");
await context.close();
process.exit(ok ? 0 : 1);
