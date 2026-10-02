import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import { launchBrowser, positionalArgs } from "./lib/browser.js";

/**
 * Sends one real question and dumps the conversation DOM shape (attributes, buttons) for adapter work.
 * Usage: node scripts/probe-chat-dom.js [url] [question] [--headed]
 */
const [url = "https://chatgpt.com/", question = "用一句话解释向量召回，并给一行 python 代码示例"] = positionalArgs();
const context = await launchBrowser();
const page = context.pages()[0] ?? await context.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8_000);

const describe = () => page.evaluate(() => {
  const attrs = (node) => Object.fromEntries([...node.attributes].filter((a) => a.name !== "class" && a.name !== "style").map((a) => [a.name, a.value.slice(0, 80)]));
  const composer = document.querySelector("textarea, [contenteditable='true']");
  return {
    url: location.href,
    composer: composer && { tag: composer.tagName, attrs: attrs(composer), value: composer.value ?? composer.innerText },
    buttons: [...document.querySelectorAll("button, [role='button']")].map((b) => ({ ...attrs(b), text: b.innerText.trim().slice(0, 30) })).filter((b) => Object.keys(b).length > 1).slice(0, 60),
    dataAttrs: [...new Set([...document.querySelectorAll("*")].flatMap((n) => [...n.attributes].map((a) => a.name)).filter((n) => n.startsWith("data-")))],
    roles: [...document.querySelectorAll("[data-message-author-role], [data-turn], [data-testid^='conversation-turn']")].map((n) => ({ tag: n.tagName, ...attrs(n), text: n.innerText.slice(0, 80) }))
  };
});

const composer = page.locator("textarea, [contenteditable='true']").first();
await composer.click();
await composer.pressSequentially(question, { delay: 30 });
const typed = await describe();
await page.keyboard.press("Enter");
await page.waitForTimeout(1_500);
const streaming = await describe();
await page.waitForTimeout(25_000);
const done = await describe();
const html = await page.evaluate(() => document.querySelector("main")?.outerHTML ?? document.body.outerHTML);
await writeFile(join(tmpdir(), "chat-dom.json"), JSON.stringify({ typed, streaming, done }, null, 2));
await writeFile(join(tmpdir(), "chat-dom.html"), html);
console.log(join(tmpdir(), "chat-dom.json"), join(tmpdir(), "chat-dom.html"));
await context.close();
