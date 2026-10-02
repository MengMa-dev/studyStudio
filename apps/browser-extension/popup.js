const $ = (id) => document.getElementById(id);
const status = (text) => { $("status").textContent = text; };

async function refreshStatus() {
  const result = await chrome.runtime.sendMessage({ type: "study-studio:status" });
  const pending = result?.pending ? `，待重发 ${result.pending} 条` : "";
  if (result?.paired) status(`已连接本地服务${pending}`);
  else if (result?.status === 401) status(`配对令牌无效${pending}`);
  else status(`未连接：${result?.error ?? "本地服务不可用"}${pending}`);
}

chrome.storage.local.get({ ingestionUrl: "http://127.0.0.1:43118", pairingToken: "" }).then((config) => {
  $("url").value = config.ingestionUrl;
  $("token").value = config.pairingToken;
  refreshStatus();
});
$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ ingestionUrl: $("url").value.trim().replace(/\/$/, ""), pairingToken: $("token").value.trim() });
  await refreshStatus();
});
$("add-note").addEventListener("click", async () => {
  const text = $("note").value.trim();
  if (!text) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.tabs.sendMessage(tab.id, { type: "study-studio:add-note", text }).catch(() => null);
  status(result?.ok ? "备注已记录。" : "当前页面不可记录备注。");
  if (result?.ok) $("note").value = "";
});
