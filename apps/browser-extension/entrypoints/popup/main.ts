const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const setStatus = (text: string) => {
  document.getElementById("status")!.textContent = text;
};

type Status = { paired?: boolean; status?: number; error?: string; pending?: number } | undefined;

async function refreshStatus() {
  const result = (await browser.runtime.sendMessage({ type: "study-studio:status" })) as Status;
  const pending = result?.pending ? `，待重发 ${result.pending} 条` : "";
  if (result?.paired) setStatus(`已连接本地服务${pending}`);
  else if (result?.status === 401) setStatus(`配对令牌无效${pending}`);
  else setStatus(`未连接：${result?.error ?? "本地服务不可用"}${pending}`);
}

void browser.storage.local.get({ ingestionUrl: "http://127.0.0.1:43118", pairingToken: "" }).then((config) => {
  input("url").value = String(config.ingestionUrl);
  input("token").value = String(config.pairingToken);
  void refreshStatus();
});

input("save").addEventListener("click", async () => {
  await browser.storage.local.set({ ingestionUrl: input("url").value.trim().replace(/\/$/, ""), pairingToken: input("token").value.trim() });
  await refreshStatus();
});

input("add-note").addEventListener("click", async () => {
  const text = input("note").value.trim();
  if (!text) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const result = tab?.id === undefined ? null : await browser.tabs.sendMessage(tab.id, { type: "study-studio:add-note", text }).catch(() => null);
  setStatus(result?.ok ? "备注已记录。" : "当前页面不可记录备注。");
  if (result?.ok) input("note").value = "";
});
