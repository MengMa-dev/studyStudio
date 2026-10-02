import { join } from "node:path";
import { chromium } from "playwright-core";

/** Persistent profile shared by all live scripts so site logins (DeepSeek, ChatGPT) survive between runs. */
export const PROFILE_DIR = process.env.STUDY_STUDIO_BROWSER_PROFILE ?? join(process.cwd(), ".browser-profile");
export const EXTENSION_DIR = join(process.cwd(), "apps/browser-extension");

export const isHeaded = () => process.argv.includes("--headed") || process.env.HEADED === "1";

/** Positional CLI args without flags such as --headed. */
export const positionalArgs = () => process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

let cachedUserAgent = null;
async function desktopUserAgent() {
  if (cachedUserAgent) return cachedUserAgent;
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const version = browser.version();
  await browser.close();
  cachedUserAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  return cachedUserAgent;
}

/**
 * Launches Playwright's Chromium. Headless by default ("new" headless via channel "chromium",
 * which supports extensions); pass --headed or HEADED=1 to show the window (e.g. to log in).
 */
export async function launchBrowser({ extension = false, headed = isHeaded() } = {}) {
  const args = extension ? [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`] : [];
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chromium",
    headless: !headed,
    viewport: { width: 1200, height: 800 },
    locale: "zh-CN",
    ...(headed ? {} : { userAgent: await desktopUserAgent() }),
    ignoreDefaultArgs: extension ? ["--disable-extensions"] : [],
    args
  });
}
