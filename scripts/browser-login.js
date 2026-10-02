import { launchBrowser, PROFILE_DIR, positionalArgs } from "./lib/browser.js";

/**
 * Opens a visible browser on the shared profile so you can log in once.
 * Close the window when done; later headless runs reuse the session.
 * Usage: npm run browser:login -- [url ...]
 */
const urls = positionalArgs();
const context = await launchBrowser({ headed: true });
const targets = urls.length > 0 ? urls : ["https://chat.deepseek.com/", "https://chatgpt.com/"];
const [first, ...rest] = targets;
const page = context.pages()[0] ?? await context.newPage();
await page.goto(first);
for (const url of rest) await (await context.newPage()).goto(url);
console.log(`Profile: ${PROFILE_DIR}`);
console.log("登录完成后关闭浏览器窗口即可保存登录状态。");
await new Promise((resolve) => context.on("close", resolve));
