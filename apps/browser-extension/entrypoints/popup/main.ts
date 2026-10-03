const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);

type Status = {
  connectivity?: { state: string; error?: string };
  counts?: { knowledge: number; records: number; total: number };
  failedCount?: number;
  sync?: { done: number; total: number; running: boolean };
  connection?: { ingestionUrl: string; pairingToken: string };
};

let connectionFilled = false;

function setConnectionUi(status: Status) {
  const state = status.connectivity?.state ?? "unknown";
  const dot = el("dot");
  dot.className = `dot ${state}`;
  const label = el("connection-label");
  if (state === "online") label.textContent = "已连接 Study Studio";
  else if (state === "unauthorized") label.textContent = "配对令牌无效，请重新填写";
  else if (state === "offline") label.textContent = "本地服务未启动（npx study-studio）";
  else label.textContent = "检测中…";

  const knowledge = status.counts?.knowledge ?? 0;
  const records = status.counts?.records ?? 0;
  el("knowledge-count").textContent = String(knowledge);
  el("record-count").textContent = `另含 ${records} 条阅读与提问记录`;
  el("failed-summary").textContent = `同步失败 ${status.failedCount ?? 0} 条`;

  const syncBtn = el<HTMLButtonElement>("sync");
  const online = state === "online";
  syncBtn.disabled = !online;
  syncBtn.title = online ? "立即同步" : "本地服务未连接";

  setProgressUi(status.sync);

  if (status.connection && !connectionFilled) {
    input("url").value = status.connection.ingestionUrl;
    input("token").value = status.connection.pairingToken;
    connectionFilled = true;
  }
}

function setProgressUi(sync: Status["sync"]) {
  const progress = el("progress");
  const bar = progress.firstElementChild as HTMLElement;
  if (sync?.running && sync.total > 0) {
    progress.style.display = "block";
    bar.style.width = `${Math.min(100, Math.round((sync.done / sync.total) * 100))}%`;
  } else {
    progress.style.display = "none";
  }
}

async function refresh() {
  const status = (await browser.runtime.sendMessage({ type: "study-studio:status" })) as Status;
  setConnectionUi(status);
  return status;
}

void refresh();

el<HTMLButtonElement>("sync").addEventListener("click", async () => {
  el("toast").textContent = "同步中…";
  const result = (await browser.runtime.sendMessage({ type: "study-studio:sync" })) as Status & {
    ok?: boolean;
    synced?: number;
  };
  setConnectionUi(result);
  if (result.ok) el("toast").textContent = `已同步 ${result.synced ?? 0} 条知识到 Study Studio`;
  else el("toast").textContent = result.connectivity?.error ?? "同步失败";
});

browser.runtime.onMessage.addListener((message: { type?: string; progress?: Status["sync"]; synced?: number }) => {
  if (message.type === "study-studio:sync-progress" && message.progress) {
    setProgressUi(message.progress);
  }
  if (message.type === "study-studio:sync-done") {
    el("toast").textContent = `已同步 ${message.synced ?? 0} 条知识到 Study Studio`;
    void refresh();
  }
});

el<HTMLButtonElement>("failed-toggle").addEventListener("click", async () => {
  const panel = el("failed-panel");
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;
  const failed = (await browser.runtime.sendMessage({ type: "study-studio:failed-list" })) as {
    eventId: string;
    error: string;
    event: { type?: string };
  }[];
  const list = el("failed-list");
  list.innerHTML = "";
  for (const item of failed) {
    const li = document.createElement("li");
    li.textContent = `${item.event.type ?? "event"} · ${item.error}`;
    list.append(li);
  }
});

el<HTMLButtonElement>("failed-clear").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "study-studio:failed-clear" });
  el("failed-list").innerHTML = "";
  await refresh();
});

el<HTMLButtonElement>("save").addEventListener("click", async () => {
  const status = (await browser.runtime.sendMessage({
    type: "study-studio:save-connection",
    ingestionUrl: input("url").value.trim().replace(/\/$/, ""),
    pairingToken: input("token").value.trim()
  })) as Status;
  setConnectionUi(status);
  el("toast").textContent = "连接已保存";
});

el<HTMLButtonElement>("add-note").addEventListener("click", async () => {
  const text = el<HTMLTextAreaElement>("note").value.trim();
  if (!text) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const result = tab?.id === undefined ? null : await browser.tabs.sendMessage(tab.id, { type: "study-studio:add-note", text }).catch(() => null);
  el("toast").textContent = result?.ok ? "备注已记录。" : "当前页面不可记录备注。";
  if (result?.ok) el<HTMLTextAreaElement>("note").value = "";
  await refresh();
});
