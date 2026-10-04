export const COLLECTING_KEY = "collecting";

export async function readCollecting(): Promise<boolean> {
  const stored = await browser.storage.local.get({ [COLLECTING_KEY]: false });
  return stored[COLLECTING_KEY] === true;
}

export async function writeCollecting(collecting: boolean): Promise<void> {
  await browser.storage.local.set({ [COLLECTING_KEY]: collecting });
}
