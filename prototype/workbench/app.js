/*
 * Clickable prototype: hash routing + string templates + event delegation. No build step.
 * Sections: state & helpers → sidebar → home chat → wiki → progress/timeline → fuzzy notes → inbox
 *   → item detail → study → settings → router → dock → interactions → delete flows → organize flows → boot.
 * Every page is a function returning HTML; any state change calls render(). Clicks are dispatched by data-* attributes.
 */
const D = window.DATA;
const $main = document.getElementById("main");
const state = {
  inboxTab: "all", inboxStatus: "all", selected: new Set(),
  timelineTypes: new Set(), collapsedDays: new Set(), inboxPage: 1, inboxPageSize: 50,
  graphSelected: "交叉编码器", graphRelation: "all", treeCollapsed: new Set(),
  provider: "deepseek", preset: "prod",
  threshold: { minActiveSeconds: 90, minScrollDepth: 35, minRevisitSeconds: 60 },
  docPage: 6, platforms: { chatgpt: true, deepseek: true },
  liveSeconds: D.live.seconds,
  chat: [], wikiKind: "all", wikiQuery: "",
  lastRoute: {}, scrollMemory: {}, editingNote: null,
  dock: { open: false }, selectAllKey: null, wikiChecked: new Set()
};

/* Lucide-style line icons, 1.6px stroke, inherit currentColor. */
const ICONS = {
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
  study: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  wiki: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="m8.2 7.3 7.4 1.2M7 8.3l1.5 7.3m2.4.8 5.6-6.5"/>',
  progress: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  page: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.8 7.2L3 20l1.4-4.8A8.4 8.4 0 1 1 21 11.5z"/>',
  doc: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z"/><path d="M6.5 17H20v5H6.5A2.5 2.5 0 0 1 4 19.5"/>',
  note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  runs: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'
};
const icon = (name, size = 16) => `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

const NAV = [
  { id: "home", icon: "home", label: "首页" },
  { id: "study", icon: "study", label: "学习区" },
  { id: "wiki", icon: "wiki", label: "知识库" },
  { id: "progress", icon: "progress", label: "学习进度" },
  { id: "inbox", icon: "inbox", label: "收集箱", count: () => D.items.filter((item) => item.status === "unread").length },
  { id: "runs", icon: "runs", label: "整理记录" }
];

const STATUS = { unread: ["未读", "blue"], read: ["已读", ""] };
const REASON = { threshold: "达到阅读门槛", copy: "复制", selection: "划词", note: "备注", answer_completed: "问答", document: "学习区文档" };
const TYPE_LABEL = { webpage: "网页", conversation: "问答", document: "文档" };
const RELATION = { part_of: "组成", prerequisite: "前置", related: "相关", contrasts: "对比" };

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtDuration = (seconds) => {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
};
const fmtMinutes = (minutes) => minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}` : `${minutes} 分钟`;
/** "13:35" → minutes since midnight; "刚刚" sorts newest. */
const clockValue = (time) => /^\d{1,2}:\d{2}$/.test(time) ? Number(time.slice(0, -3)) * 60 + Number(time.slice(-2)) : 24 * 60;
const fmtShort = (minutes) => minutes >= 60 ? `${+(minutes / 60).toFixed(1)} 小时` : `${minutes} 分`;
const item = (id) => D.items.find((entry) => entry.id === id);
const srcIcon = (site, size = 30) => {
  const meta = D.sites[site] ?? { color: "#868e96", short: site.slice(0, 1) };
  return `<div class="src-icon" style="background:${meta.color};width:${size}px;height:${size}px">${meta.short}</div>`;
};
const statusTag = (status) => `<span class="tag ${STATUS[status][1]}">${STATUS[status][0]}</span>`;
const statusTags = (entry) => `${statusTag(entry.status)}<span class="tag ${entry.organized ? "green" : "purple"}">${entry.organized ? "已整理" : "待整理"}</span>`;
const tags = (list) => list.map((tag) => `<span class="tag">#${esc(tag)}</span>`).join("");
const graphNode = (id) => D.graph.nodes.find((entry) => entry.id === id);
const masteryColor = (mastery) => mastery >= 0.65 ? "#2f9e44" : mastery >= 0.45 ? "#4c6ef5" : mastery >= 0.3 ? "#f08c00" : "#e03131";
const masteryLabel = (mastery) => mastery >= 0.65 ? "熟悉" : mastery >= 0.45 ? "了解" : mastery >= 0.3 ? "薄弱" : "陌生";
const wikiHref = (id) => `#/wiki/${encodeURIComponent(id)}`;
const sourcesOf = (id) => D.items.filter((entry) => entry.concepts.includes(id));
const parentOf = (id) => D.graph.edges.find(([a, b, type]) => a === id && type === "part_of" && D.wiki.entries[b]?.category === D.wiki.entries[id]?.category)?.[1];
/* Notes are intent signals for organizing; `used` marks whether an organize run has consumed them. */
const itemNotes = (entry) => {
  entry.notes = (entry.notes ?? []).map((note) => typeof note === "string" ? { text: note, from: "网页备注 · 采集时", used: entry.organized } : note);
  return entry.notes;
};
const entryNotes = (id) => {
  const entry = D.wiki.entries[id];
  entry.notes ??= sourcesOf(id).flatMap((source) => itemNotes(source).map((note) => ({ text: note.text, from: `来自收集点备注 · ${source.title}`, used: true })));
  return entry.notes;
};
const notesOf = (scope, id) => scope === "item" ? itemNotes(item(id)) : entryNotes(id);

/** Plain-text round trip for editing article blocks: "## " heading, "- " list, "> " quote, ``` code. */
function toText(blocks) {
  return blocks.map(([kind, text]) => {
    if (kind === "h") return `## ${text}`;
    if (kind === "ul") return text.map((line) => `- ${line}`).join("\n");
    if (kind === "code") return `\`\`\`\n${text}\n\`\`\``;
    if (kind === "blockquote") return `> ${text}`;
    return text;
  }).join("\n\n");
}

function fromText(text) {
  const lines = text.split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("```")) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      index += 1;
      blocks.push(["code", code.join("\n")]);
    } else if (!line.trim()) {
      index += 1;
    } else if (line.startsWith("## ")) {
      blocks.push(["h", line.slice(3)]);
      index += 1;
    } else if (line.startsWith("- ")) {
      const list = [];
      while (index < lines.length && lines[index].startsWith("- ")) list.push(lines[index++].slice(2));
      blocks.push(["ul", list]);
    } else if (line.startsWith("> ")) {
      blocks.push(["blockquote", line.slice(2)]);
      index += 1;
    } else {
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !/^(## |- |> |```)/.test(lines[index])) paragraph.push(lines[index++]);
      blocks.push(["p", paragraph.join("")]);
    }
  }
  return blocks;
}

function notesCard(scope, id, title, hint) {
  const notes = notesOf(scope, id);
  const key = (index) => `${scope}:${id}:${index}`;
  const noteItem = (note, index) => state.editingNote === key(index)
    ? `<div class="note"><textarea class="input" rows="3" id="note-edit">${esc(note.text)}</textarea><div class="row" style="margin-top:6px;justify-content:flex-end"><button class="btn sm ghost" data-action="cancel-note">取消</button><button class="btn sm primary" data-action="save-note-edit" data-note="${index}">保存</button></div></div>`
    : `<div class="note"><div>${esc(note.text)}</div><div class="row small faint" style="margin-top:6px;flex-wrap:wrap">${esc(note.from)}${note.used ? "" : `<span class="tag orange">未用于整理</span>`}<div class="grow"></div><button class="btn sm ghost" data-action="edit-note" data-note="${index}">编辑</button><button class="btn sm ghost danger" data-action="delete-note" data-note="${index}">删除</button></div></div>`;
  return `<div class="card" data-note-scope="${scope}" data-note-id="${esc(id)}"><div class="card-title">${icon("note")} ${title}<span class="more muted">${notes.length} 条</span></div>
    <div class="small faint" style="margin:-4px 0 10px;line-height:1.6">${hint}</div>
    <div class="stack" style="gap:8px">${notes.map(noteItem).join("") || `<div class="small faint">还没有备注</div>`}</div>
    <textarea class="input" rows="3" id="note-new" placeholder="写下你的理解、疑问或希望整理时关注的点…" style="margin-top:10px"></textarea>
    <div class="row" style="margin-top:8px;justify-content:flex-end"><button class="btn sm primary" data-action="add-note">添加备注</button></div>
  </div>`;
}

/** Shown when notes or edits exist that no organize run has used yet; never auto-triggers organizing. */
function pendingBar(scope, id, edited) {
  const unused = notesOf(scope, id).filter((note) => !note.used).length;
  if (!unused && !edited) return "";
  const parts = [unused ? `${unused} 条新备注` : "", edited ? "内容已编辑" : ""].filter(Boolean).join("、");
  return `<div class="pending-bar">${parts}，尚未用于整理（不会自动整理）<div class="grow"></div><button class="btn sm" data-organize-scope="${scope}" data-organize-id="${esc(id)}">✦ 重新整理</button></div>`;
}
const conceptChip = (id) => {
  const node = graphNode(id);
  return node ? `<a class="concept-chip" href="${wikiHref(id)}"><i style="background:${masteryColor(node.mastery)}"></i>${esc(id)}<span>${Math.round(node.mastery * 100)}%</span></a>` : "";
};
const sourceChip = (entry) => `<span class="source-chip" data-open="${entry.id}">${srcIcon(entry.site, 18)}${esc(entry.title)}</span>`;
const moreMenu = (items) => `<details class="more-menu"><summary class="btn sm" title="更多操作">${icon("more")}</summary><div class="menu-pop">${items}</div></details>`;
const header = (title, sub = "", actions = "") => `<div class="page-header"><h1>${title}</h1><span class="sub">${sub}</span><div class="actions">${actions}</div></div>`;

function toast(text) {
  const node = document.getElementById("toast");
  node.textContent = text;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 1800);
}

function dangerConfirm(title, text, label, onConfirm) {
  const mask = modal(`<h3>${title}</h3><div class="muted" style="line-height:1.7">${text}</div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>取消</button><button class="btn primary danger-fill" data-confirm>${label}</button></div>`);
  mask.querySelector("[data-confirm]").addEventListener("click", () => { mask.remove(); onConfirm(); });
}

function modal(html) {
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `<div class="modal">${html}</div>`;
  mask.addEventListener("click", (event) => { if (event.target === mask || event.target.closest("[data-close]")) mask.remove(); });
  document.body.append(mask);
  return mask;
}

function renderBody(blocks) {
  return blocks.map(([kind, text]) => {
    if (kind === "h") return `<h3>${esc(text)}</h3>`;
    if (kind === "code") return `<pre><code>${esc(text)}</code></pre>`;
    if (kind === "blockquote") return `<blockquote>${esc(text)}</blockquote>`;
    if (kind === "ul") return `<ul>${text.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`;
    return `<p>${esc(text)}</p>`;
  }).join("");
}

/** Wiki entry id from #/wiki/:entry. */
function currentEntry() {
  return decodeURIComponent(location.hash.split("/")[2] ?? "");
}

/* ---------- Sidebar ---------- */
/* Detail routes highlight their parent module in the sidebar. */
const MODULE_OF = { item: "inbox", reader: "study" };
function renderNav(route) {
  const current = MODULE_OF[route] ?? route;
  const link = (entry) => {
    const active = current === entry.id;
    const count = entry.count?.();
    const href = active ? `#/${entry.id}` : state.lastRoute[entry.id] ?? `#/${entry.id}`;
    return `<a class="nav-item ${active ? "active" : ""}" href="${href}"><span class="icon">${icon(entry.icon, 17)}</span>${entry.label}${count ? `<span class="count">${count}</span>` : ""}</a>`;
  };
  document.getElementById("nav").innerHTML = NAV.map(link).join("");
  const running = state.organizing;
  document.getElementById("nav-bottom").innerHTML = `
    ${running ? `<div class="organizing"><span class="spinner"></span><span class="grow">整理中 ${running.done}/${running.total}</span><span class="faint">${Math.round((running.done / running.total) * 100)}%</span></div>` : ""}
    ${link({ id: "settings", icon: "settings", label: "设置" })}`;
}

/* ---------- Home: ask your own learning history ---------- */
const SUGGESTIONS = ["我今天学了什么？", "最近一周学了哪些东西？", "RAG 到底是什么？", "我哪些知识掌握得不好？"];

function home() {
  const { today } = D.stats;
  const weak = D.graph.nodes.filter((node) => node.mastery < 0.45).length;
  const profileTip = `学习者档案：${D.profile.role || "未设置角色"} · ${D.profile.focus.length} 个近期学习方向`;
  const composer = `<div class="composer-row"><div class="composer"><textarea id="chat-input" rows="1" placeholder="问问你学过的内容，或告诉我「我最近在学 AI 相关知识」"></textarea><button class="btn primary" data-action="send">发送</button></div>
    <button class="profile-btn" data-action="open-profile" title="${esc(profileTip)}" aria-label="学习者档案">${icon("user", 18)}${D.profile.role || D.profile.focus.length ? `<i class="profile-dot"></i>` : ""}</button></div>`;
  if (!state.chat.length) return `
    <div class="chat-home">
      <div class="chat-hero"><div class="brand-logo" style="width:44px;height:44px;font-size:20px;border-radius:12px">S</div>
        <h1>下午好，今天已经学习了 ${fmtMinutes(today.minutes)}</h1>
        <div class="muted">基于你的学习记录和知识库回答：学过什么、掌握得怎样、还缺什么</div></div>
      ${composer}
      <div class="chips" style="justify-content:center">${SUGGESTIONS.map((text) => `<button class="chip" data-ask="${text}">${text}</button>`).join("")}</div>
      <div class="home-stats">
        <a href="#/progress"><span class="muted">今日</span><b>${today.pages}</b> 篇网页 · <b>${today.qa}</b> 次问答</a>
        <a href="#/wiki"><span class="muted">知识库</span><b>${D.graph.nodes.length}</b> 个知识点 · 待整理 <b>${D.organize.pendingCount}</b></a>
        <a href="#/wiki"><span class="muted">薄弱</span><b style="color:var(--orange)">${weak}</b> 个知识点</a>
      </div>
    </div>`;
  return `
    <div class="chat-page">
      <div class="row" style="margin-bottom:8px"><span class="muted small">基于学习记录与知识库回答 · 对话不计入收集箱</span><div class="grow"></div><button class="btn sm" data-action="new-chat">＋ 新对话</button></div>
      <div class="chat-list">${state.chat.map((message) => chatMessage(message)).join("")}</div>
      <div class="chat-dock">${composer}</div>
    </div>`;
}

function chatMessage(message, currentLabel) {
  if (message.role === "user") return `<div class="msg user">${message.ctxLabel && message.ctxLabel !== currentLabel ? `<div class="msg-ctx">在「${esc(message.ctxLabel)}」提问</div>` : ""}<div class="bubble">${esc(message.text)}</div></div>`;
  if (message.pending) return `<div class="msg bot"><div class="bot-avatar">S</div><div class="bot-body muted">正在检索你的学习记录…</div></div>`;
  return `<div class="msg bot"><div class="bot-avatar">S</div><div class="bot-body">${message.html}
    ${message.basis ? `<div class="basis">${message.basis}</div>` : ""}</div></div>`;
}

function answer(question) {
  const lower = question.toLowerCase();
  const concept = D.graph.nodes.map((node) => node.id).sort((a, b) => b.length - a.length)
    .find((id) => lower.includes(id.toLowerCase()) || (D.wiki.entries[id]?.aliases ?? []).some((alias) => lower.includes(alias.toLowerCase())));
  if (concept) return answerConcept(concept);
  if (/今天|今日/.test(question)) return answerToday();
  if (/最近|这周|本周|一周|7 ?天/.test(question)) return answerWeek();
  if (/掌握|薄弱|不熟|复习|不好/.test(question)) return answerMastery();
  return {
    html: `<p>你的学习记录和知识库里还没有和「${esc(question)}」相关的内容。</p>
      <div class="row" style="margin-top:10px"><button class="btn sm" data-action="general-answer">用模型通用知识回答</button><span class="small faint">回答会标注「非学习记录」，不会写入知识库</span></div>`,
    basis: "检索：知识库 0 条命中 · 学习记录 0 条命中"
  };
}

function answerToday() {
  const day = D.timeline[0];
  const rows = timelineRows(day).filter((row) => row.itemId).reverse();
  const ids = rows.map((row) => row.itemId);
  const concepts = [...new Set(ids.flatMap((id) => item(id)?.concepts ?? []))];
  return {
    html: `<p>今天你学习了 <b>${fmtMinutes(day.minutes)}</b>，共 ${rows.length} 条学习记录：</p>
      <ul>${rows.map((row) => `<li><b>${row.start}</b> ${esc(item(row.itemId).title)}</li>`).join("")}</ul>
      <p>涉及的知识点：</p><div class="chips">${concepts.map(conceptChip).join("")}</div>
      <p style="margin-top:12px">主线是<b>重排模型选型</b>：先问了 DeepSeek 交叉编码器是什么，又读了知乎上双塔与交叉编码器的对比，并记了一条「输入控制在 512 token 内」的备注。</p>
      <p>建议：「HNSW」掌握度只有 20%，今天收的那篇掘金文章只读了 7 分钟，可以接着读完。</p>`,
    basis: `依据：今天的时间线 · ${ids.length} 条学习记录　${ids.map((id) => item(id)).filter(Boolean).map(sourceChip).join("")}`
  };
}

function answerWeek() {
  const total = D.stats.week.reduce((sum, day) => sum + day.minutes, 0);
  const groups = D.wiki.categories.map((category) => {
    const ids = Object.entries(D.wiki.entries).filter(([, entry]) => entry.category === category.id).map(([id]) => id);
    const sources = D.items.filter((entry) => entry.concepts.some((id) => ids.includes(id)));
    return { category, ids, sources };
  });
  return {
    html: `<p>最近 7 天你学习了 <b>${fmtMinutes(total)}</b>，连续学习 ${D.stats.streak} 天，主要集中在 ${groups.length} 个方向：</p>
      ${groups.map(({ category, ids, sources }) => `<div class="answer-block"><div class="row"><b>${category.name}</b><span class="small muted">${sources.length} 条学习记录</span></div><div class="chips" style="margin-top:6px">${ids.map(conceptChip).join("")}</div></div>`).join("")}
      <p style="margin-top:12px">另外读了 MDN 的 IntersectionObserver，属于前端方向，还没有整理进知识库。</p>`,
    basis: `依据：近 7 天时间线 · 知识库 ${D.graph.nodes.length} 个知识点　<a href="#/progress">查看学习进度 →</a>`
  };
}

function answerMastery() {
  const nodes = [...D.graph.nodes].sort((a, b) => a.mastery - b.mastery);
  const weak = nodes.filter((node) => node.mastery < 0.45);
  const strong = nodes.filter((node) => node.mastery >= 0.65);
  const reading = (id) => sourcesOf(id).reduce((sum, entry) => sum + (entry.reading?.total ?? 0), 0);
  return {
    html: `<p>比较薄弱的 ${weak.length} 个：</p>
      <ul>${weak.map((node) => `<li>${conceptChip(node.id)} <span class="small muted">${sourcesOf(node.id).length} 条来源 · 累计阅读 ${fmtDuration(reading(node.id))}</span></li>`).join("")}</ul>
      <p>掌握较好的：</p><div class="chips">${strong.map((node) => conceptChip(node.id)).join("")}</div>
      <p style="margin-top:12px">建议从 <b>ANN → HNSW</b> 补起：它们是向量检索的基础，而你在向量检索上已经有 70% 的掌握度。</p>`,
    basis: "依据：知识点掌握度（阅读时长、问答次数，以及你手动设定的掌握程度）"
  };
}

function answerConcept(id) {
  const node = graphNode(id);
  const entry = D.wiki.entries[id] ?? { points: [] };
  const parts = D.graph.edges.filter(([, b, type]) => b === id && type === "part_of").map(([a]) => a);
  const subParts = (parent) => D.graph.edges.filter(([, b, type]) => b === parent && type === "part_of").map(([a]) => a);
  const direct = sourcesOf(id);
  const related = D.items.filter((candidate) => !direct.includes(candidate) && candidate.concepts.some((concept) => parts.includes(concept) || parts.flatMap(subParts).includes(concept)));
  const masteryRow = (concept, indent = false) => {
    const target = graphNode(concept);
    return `<div class="mastery-row ${indent ? "indent" : ""}"><a href="${wikiHref(concept)}">${concept}</a><div class="progress"><div style="width:${target.mastery * 100}%;background:${masteryColor(target.mastery)}"></div></div><span class="small muted">${masteryLabel(target.mastery)} ${Math.round(target.mastery * 100)}%</span></div>`;
  };
  const weakest = parts.flatMap((part) => [part, ...subParts(part)]).map(graphNode).sort((a, b) => a.mastery - b.mastery)[0];
  return {
    html: `<p><b>${id}</b>：${esc(node.desc)}</p>
      ${entry.points.length ? `<ul>${entry.points.map((point) => `<li>${esc(point)}</li>`).join("")}</ul>` : ""}
      ${parts.length ? `<p>它由这些部分组成，你的掌握情况：</p><div class="answer-block">${parts.map((part) => masteryRow(part) + subParts(part).map((sub) => masteryRow(sub, true)).join("")).join("")}</div>` : `<p>你对它的掌握：</p><div class="answer-block">${masteryRow(id)}</div>`}
      ${entry.gaps ? `<p style="margin-top:12px"><b>还没覆盖：</b>${esc(entry.gaps)}</p>` : ""}
      ${weakest ? `<p>建议：先补「${weakest.id}」（${Math.round(weakest.mastery * 100)}%）${direct.some((candidate) => candidate.pages && candidate.readPages < candidate.pages) ? "；你收藏的《RAG 系统设计分享.pptx》读到第 11/24 页，可以接着看" : ""}。</p>` : ""}
      <div class="row" style="margin-top:10px"><a class="btn sm" href="${wikiHref(id)}">打开词条</a><a class="btn sm" href="#/wiki" data-graph-focus="${id}">在图谱中查看</a></div>`,
    basis: `依据：词条「${id}」· 直接来源 ${direct.length} 条 · 组成部分来源 ${related.length} 条　${[...direct, ...related].slice(0, 4).map(sourceChip).join("")}`
  };
}

/** Home and the floating dock share one conversation; dock questions carry the page they were asked on. */
function ask(question, ctx = null) {
  const text = question.trim();
  if (!text) return;
  const pending = { role: "bot", pending: true };
  state.chat.push({ role: "user", text, ctxLabel: ctx?.label }, pending);
  render();
  setTimeout(() => {
    const { after, ...reply } = profileIntent(text) ?? organizeIntent(text, ctx) ?? (ctx ? dockAnswer(text, ctx) : answer(text));
    state.chat[state.chat.indexOf(pending)] = { role: "bot", ...reply };
    render();
    if (ctx) document.getElementById("dock-input")?.focus();
    else window.scrollTo(0, document.body.scrollHeight);
    after?.();
  }, 600);
}

/**
 * Statements about the learner update the profile: "我是产品经理" sets the role,
 * "我最近在学 AI 相关知识" adds a learning focus. Questions ("我今天学了什么？") are left to other intents.
 */
function profileIntent(text) {
  if (/[？?吗呢]$|什么|哪些|怎么|多少/.test(text)) return null;
  const role = text.match(/我是(?:一[名个位])?([^，,。！!；;\s]{2,12}?)(?:[，,。！!；;\s]|$)/)?.[1];
  const rawTopic = text.match(/(?:最近|近期|现在|正在|这段时间|这阵子|这几天)(?:在|正在|开始|想)?(?:学习|学|研究|补|看)(?:一下|一些|一点)?(.+)$/)?.[1];
  const topic = rawTopic && normalizeTopic(rawTopic);
  if (!role && !topic) return null;
  if (role) D.profile.role = role;
  const added = topic && addFocus(topic);
  const parts = [role ? `角色「${esc(role)}」` : "", topic ? `近期学习方向「${esc(topic)}」${added ? `，${FOCUS_DAYS} 天后（${expiryOf(FOCUS_DAYS)}）到期` : "（已在档案中）"}` : ""].filter(Boolean);
  return {
    html: `<p>好的，已记录${parts.join("；")}。</p><p class="small muted">整理时，和它相关的内容更容易被判定为学习并入库；不在档案里的内容也不会因此被丢弃。</p>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-action="open-profile">查看学习者档案</button></div>`,
    basis: "已更新：学习者档案"
  };
}

const FOCUS_DAYS = 30;
const TODAY = new Date(2026, 9, 2);
const expiryOf = (days) => { const date = new Date(TODAY); date.setDate(date.getDate() + days); return `${date.getMonth() + 1}月${date.getDate()}日`; };
/** "ai相关知识" → "AI"; "LangGraph 的内容。" → "LangGraph". */
function normalizeTopic(raw) {
  const topic = raw.replace(/[。！!，,；;~～]+$/, "").replace(/(?:相关|方面|领域)?的?(?:知识|内容|东西|技术)$/, "").replace(/(?:相关|方面|领域)$/, "").trim();
  return /^[a-z0-9 .+-]{1,6}$/i.test(topic) ? topic.toUpperCase() : topic;
}
/** Returns false when the topic is already in the profile. */
function addFocus(topic, days = FOCUS_DAYS) {
  if (D.profile.focus.some((entry) => entry.topic.toLowerCase() === topic.toLowerCase())) return false;
  D.profile.focus.push({ topic, expires: expiryOf(days) });
  return true;
}

/* ---------- Learner Profile: shared by the home button modal and the settings section ---------- */
const ROLE_CHIPS = ["产品经理", "前端工程师", "后端工程师", "算法工程师", "设计师", "学生"];
function profileForm() {
  const { role, focus } = D.profile;
  return `<label class="field">角色<input class="input" id="profile-role" value="${esc(role)}" placeholder="例如：产品经理"></label>
    <div class="chips">${ROLE_CHIPS.map((text) => `<button class="chip ${text === role ? "active" : ""}" data-role-chip="${text}">${text}</button>`).join("")}</div>
    <div class="field-block">近期学习方向
      <div class="stack focus-list">${focus.map((entry, index) => `<div class="focus-row"><span class="grow">${esc(entry.topic)}</span><span class="small faint">${entry.expires} 到期</span><button class="btn sm ghost danger" data-remove-focus="${index}" title="移除">${icon("trash", 14)}</button></div>`).join("") || `<div class="small faint">还没有学习方向</div>`}</div>
      <div class="row"><input class="input" id="profile-focus-new" placeholder="例如：LangGraph、Agent 架构"><select class="input" id="profile-focus-days" style="width:110px"><option value="7">7 天</option><option value="30" selected>30 天</option><option value="90">90 天</option></select><button class="btn" data-action="profile-add-focus">添加</button></div>
    </div>
    <div class="small faint" style="line-height:1.6">只作为整理时「学习判定」和「知识判定」的加分参考：相关内容更容易入库，档案以外的内容不会因此被丢弃。学习方向到期后不再参与整理。也可以在对话里直接说「我最近在学 AI 相关知识」。</div>`;
}

function profileModal() {
  const mask = modal(`<h3>学习者档案</h3><div id="profile-modal-body" class="stack" style="gap:12px">${profileForm()}</div>
    <div class="row" style="justify-content:flex-end"><a class="btn" href="#/settings/profile" data-close>在设置中管理</a><button class="btn primary" data-close>完成</button></div>`);
  mask.querySelector(".modal").classList.add("profile-modal");
  mask.addEventListener("click", (event) => { if (event.target === mask || event.target.closest("[data-close]")) render(); });
}

/** Re-render the open modal (if any) and the page after a profile change. */
function refreshProfile(message) {
  const body = document.getElementById("profile-modal-body");
  if (body) body.innerHTML = profileForm();
  if (message) toast(message);
  if (!body) render();
}

/** "整理该页" resolves to the current page; a bare "整理" asks which scope to organize. */
function organizeIntent(text, ctx) {
  if (!/整理/.test(text)) return null;
  const pendingCount = D.items.filter((entry) => !entry.organized).length;
  const selectedEntry = ctx?.selected && !ctx.selected.startsWith("cat:") ? ctx.selected : null;
  const target = ctx?.item ? { scope: "item", id: ctx.item, name: `「${esc(item(ctx.item).title)}」` }
    : ctx?.entry || selectedEntry ? { scope: "entry", id: ctx.entry ?? selectedEntry, name: `知识点「${esc(ctx.entry ?? selectedEntry)}」` } : null;
  const open = (scope, id, html) => ({ html, basis: "已打开整理窗口，可补充整理要求后确认", after: () => organizeModal(scope, id) });
  if (/全量|全部重新|所有内容|全部内容/.test(text)) return open("all", null, `<p>好的，全量重新整理 ${D.items.length} 条内容。</p>`);
  if (/整理.*(待整理|未整理|没整理)/.test(text)) return open("batch", null, `<p>好的，整理 ${pendingCount} 条待整理内容。</p>`);
  if (/没整理|未整理|哪些|是否|吗|[？?]$/.test(text)) return null;
  if (target && /该页|改页|这页|本页|此页|当前|这个|这篇|这条/.test(text)) return open(target.scope, target.id, `<p>识别到当前页面是${target.name}，将整理它${target.scope === "entry" ? "（会使用知识点备注和来源内容）" : "（会使用收集点备注）"}。</p>`);
  return {
    html: `<p>要整理哪些内容？</p><div class="stack" style="gap:6px;margin-top:6px">
      ${target ? `<button class="btn sm" data-organize-scope="${target.scope}" data-organize-id="${esc(target.id)}">当前：${target.name}</button>` : ""}
      <button class="btn sm" data-organize-scope="batch">所有待整理内容（${pendingCount} 条）</button>
      <button class="btn sm" data-organize-scope="all">全量重新整理（${D.items.length} 条）</button></div>`,
    basis: target ? "当前页面可整理，也可以整理全部待整理内容或全量重整" : "当前页面没有具体知识点"
  };
}

/* ---------- Wiki ---------- */
/** Directory tree (category → part_of hierarchy) on the left, relation graph on the right; both share one selection. */
function wiki() {
  const { categories, kinds, entries } = D.wiki;
  const { nodes, edges } = D.graph;
  const ids = Object.keys(entries).filter((id) => graphNode(id));
  const q = state.wikiQuery.trim().toLowerCase();
  const filtering = Boolean(q) || state.wikiKind !== "all";
  const visible = (id) => (state.wikiKind === "all" || entries[id].kind === state.wikiKind)
    && (!q || id.toLowerCase().includes(q) || entries[id].aliases.some((alias) => alias.toLowerCase().includes(q)));
  const childrenOf = (id) => ids.filter((other) => parentOf(other) === id);

  const checked = state.wikiChecked;
  [...checked].forEach((id) => { if (!graphNode(id)) checked.delete(id); });
  const multi = checked.size > 0;
  const selected = state.graphSelected;
  const selectedCategory = selected.startsWith("cat:") ? selected.slice(4) : null;
  const lit = new Set(multi ? checked : selectedCategory ? ids.filter((id) => entries[id].category === selectedCategory) : [selected]);
  if (!multi && !selectedCategory) edges.forEach(([a, b]) => { if (a === selected) lit.add(b); if (b === selected) lit.add(a); });
  const edgeLit = ([a, b]) => multi || selectedCategory ? lit.has(a) && lit.has(b) : a === selected || b === selected;
  const edgeVisible = (type) => state.graphRelation === "all" || state.graphRelation === type;

  const row = (id, depth) => {
    const node = graphNode(id);
    return `<div class="tree-row ${selected === id && !multi ? "active" : ""} ${checked.has(id) ? "checked" : ""} ${!multi && !selectedCategory && lit.has(id) && selected !== id ? "linked" : ""}" data-tree-open="${id}" title="${id} · 掌握 ${Math.round(node.mastery * 100)}%" style="padding-left:${8 + depth * 18}px">
      <input type="checkbox" data-check-node="${id}" ${checked.has(id) ? "checked" : ""}><i class="tree-dot" style="background:${masteryColor(node.mastery)}"></i><span class="grow" title="${id}">${id}</span>
      ${node.stale ? `<span class="tag orange" title="来源有变化">↻</span>` : ""}${node.userEdited ? `<span class="tag purple" title="手动编辑过">✎</span>` : ""}
      <span class="small faint pct">${Math.round(node.mastery * 100)}%</span><button class="btn sm ghost icon-btn tree-del" data-delete-node="${id}" title="删除知识点">${icon("trash", 14)}</button></div>`;
  };
  const branch = (id, depth) => row(id, depth) + childrenOf(id).map((child) => branch(child, depth + 1)).join("");
  const tree = categories.map((category) => {
    const inCategory = ids.filter((id) => entries[id].category === category.id);
    const shown = filtering ? inCategory.filter(visible) : inCategory.filter((id) => !parentOf(id));
    if (!shown.length) return "";
    const collapsed = state.treeCollapsed.has(category.id) && !filtering;
    const avg = inCategory.reduce((sum, id) => sum + graphNode(id).mastery, 0) / inCategory.length;
    const catChecked = inCategory.filter((id) => checked.has(id)).length;
    return `<div class="tree-cat" data-toggle-cat="${category.id}" title="${collapsed ? "展开" : "折叠"}"><input type="checkbox" data-check-cat="${category.id}" ${catChecked === inCategory.length ? "checked" : ""} ${catChecked && catChecked < inCategory.length ? "data-partial" : ""} title="选中分类下全部词条"><span class="caret">${icon(collapsed ? "right" : "down", 14)}</span><span class="grow">${category.name}</span><span class="small faint">${inCategory.length} · ${Math.round(avg * 100)}%</span></div>
      ${collapsed ? "" : shown.map((id) => filtering ? row(id, 1) : branch(id, 1)).join("")}`;
  }).join("");

  const position = Object.fromEntries(nodes.map((node) => [node.id, node]));
  let info;
  if (multi) {
    const avg = [...checked].reduce((sum, id) => sum + graphNode(id).mastery, 0) / checked.size;
    info = `<div class="row"><b style="font-size:15px">已选 ${checked.size} 个知识点</b><span class="small muted">平均掌握 ${Math.round(avg * 100)}% · ${edges.filter(edgeLit).length} 条相互关系</span><div class="grow"></div><span class="small muted">已在图谱中高亮</span></div>
      <div class="chips" style="margin-top:8px">${[...checked].map(conceptChip).join("")}</div>`;
  } else if (selectedCategory) {
    const category = categories.find((candidate) => candidate.id === selectedCategory);
    info = `<div class="row"><b style="font-size:15px">${category.name}</b><span class="small muted">${category.desc}</span><div class="grow"></div><span class="small muted">${lit.size} 个词条已在图谱中高亮</span></div>`;
  } else {
    const node = graphNode(selected);
    const entry = entries[selected];
    info = `<div class="row"><b style="font-size:15px">${selected}</b>${entry ? `<span class="tag">${kinds[entry.kind]}</span>` : ""}${node.userEdited ? `<span class="tag purple">✎ 手动编辑过</span>` : ""}${node.stale ? `<span class="tag orange">↻ 来源有变化</span>` : ""}${node.orphan ? `<span class="tag red">无来源</span>` : ""}
        <div class="grow"></div><span class="small" style="color:${masteryColor(node.mastery)}">${masteryLabel(node.mastery)} ${Math.round(node.mastery * 100)}%</span>
        ${node.orphan ? `<button class="btn sm danger" data-action="delete-node">删除</button>` : ""}<a class="btn sm primary" href="${wikiHref(selected)}">查看详情</a></div>
      <div class="small muted" style="margin-top:6px;line-height:1.7">${esc(node.desc)} · ${sourcesOf(selected).length} 条来源 · ${lit.size - 1} 个关联知识点</div>`;
  }

  return `
    ${header("知识库", `${ids.length} 个词条 · ${categories.length} 个分类 · ${edges.length} 条关系 · 由 AI 整理生成，可手动编辑`, `<button class="btn primary" data-organize-scope="batch" data-organize-ranges="entries,batch,all">✦ 整理</button>`)}
    <div class="kb-layout">
      <div class="card kb-tree">
        <div class="row" style="gap:8px"><input class="input grow" id="wiki-search" placeholder="搜索词条或别名…" value="${esc(state.wikiQuery)}">
          <select class="input" id="wiki-kind" style="width:96px">${[["all", "全部类型"], ...Object.entries(kinds)].map(([id, label]) => `<option value="${id}" ${state.wikiKind === id ? "selected" : ""}>${label}</option>`).join("")}</select></div>
        <div class="kb-toolbar ${multi ? "active" : ""}">
          ${multi ? `<span>已选 <b>${checked.size}</b> 项</span>` : `<span class="small faint">勾选词条后可批量整理或删除</span>`}<div class="grow"></div>
          ${multi ? `<button class="btn sm" data-organize-scope="entries" data-organize-ranges="entries,batch,all">✦ 整理</button>
          <button class="btn sm danger" data-action="delete-checked">删除</button>
          <button class="btn sm ghost" data-action="clear-checked">取消</button>` : ""}
        </div>
        <div class="tree">${tree || `<div class="empty">没有匹配的词条</div>`}
          <div class="tree-cat muted" style="cursor:default;font-weight:400"><span class="caret"></span><span class="grow">未归类</span><span class="small faint">1 条待整理</span></div>
        </div>
      </div>
      <div class="stack" style="gap:12px">
        <div class="row"><div class="chips">${[["all", "全部关系"], ...Object.entries(RELATION)].map(([id, label]) => `<button class="chip ${state.graphRelation === id ? "active" : ""}" data-relation="${id}">${label}</button>`).join("")}</div></div>
        <div class="graph-wrap">
          <svg viewBox="0 0 1000 620">
            <defs><marker id="arrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#adb5bd"/></marker></defs>
            ${edges.filter(([, , type]) => edgeVisible(type)).map((edge) => `<line class="g-edge ${edge[2]} ${edgeLit(edge) ? "" : "dim"}" x1="${position[edge[0]].x}" y1="${position[edge[0]].y}" x2="${position[edge[1]].x}" y2="${position[edge[1]].y}" marker-end="url(#arrow)"/>`).join("")}
            ${nodes.map((node) => `<g class="g-node ${node.id === selected && !multi ? "selected" : ""} ${checked.has(node.id) ? "checked" : ""} ${lit.has(node.id) ? "" : "dim"}" data-node="${node.id}" transform="translate(${node.x},${node.y})">
              <circle r="${14 + node.mastery * 14}" fill="${masteryColor(node.mastery)}"/><text y="${32 + node.mastery * 14}" text-anchor="middle">${node.id}</text></g>`).join("")}
          </svg>
          <div class="legend"><div><b>掌握程度</b>：<span style="color:#2f9e44">●</span> 熟悉 <span style="color:#4c6ef5">●</span> 了解 <span style="color:#f08c00">●</span> 薄弱 <span style="color:#e03131">●</span> 陌生</div>
            <div><i style="border-color:#4c6ef5"></i>组成　<i style="border-color:#f08c00"></i>前置　<i style="border-color:#c3c9d1"></i>相关　<i style="border-color:#e03131;border-top-style:dashed"></i>对比</div></div>
        </div>
        <div class="card">${info}</div>
      </div>
    </div>`;
}

function wikiEntry(id) {
  const node = graphNode(id);
  const entry = D.wiki.entries[id];
  if (!node || !entry) return `<div class="empty">词条不存在</div>`;
  const category = D.wiki.categories.find((candidate) => candidate.id === entry.category);
  const edges = D.graph.edges;
  const groups = [
    ["属于", edges.filter(([a, , type]) => a === id && type === "part_of").map(([, b]) => b)],
    ["组成部分", edges.filter(([, b, type]) => b === id && type === "part_of").map(([a]) => a)],
    ["前置知识", edges.filter(([, b, type]) => b === id && type === "prerequisite").map(([a]) => a)],
    ["是它的前置", edges.filter(([a, , type]) => a === id && type === "prerequisite").map(([, b]) => b)],
    ["对比", edges.filter(([a, b, type]) => type === "contrasts" && (a === id || b === id)).map(([a, b]) => a === id ? b : a)],
    ["相关", edges.filter(([a, b, type]) => type === "related" && (a === id || b === id)).map(([a, b]) => a === id ? b : a)]
  ].filter(([, list]) => list.length);
  const sources = sourcesOf(id);
  const excerpts = sources.map((source) => [source.summary ?? (source.body ?? source.answer ?? []).find(([kind]) => kind === "p")?.[1], source]).filter(([text]) => text);
  const siblings = Object.keys(D.wiki.entries).filter((other) => other !== id && D.wiki.entries[other].category === entry.category && graphNode(other));
  const reading = sources.reduce((sum, source) => sum + (source.reading?.total ?? 0), 0);
  const ancestors = [];
  for (let parent = parentOf(id); parent; parent = parentOf(parent)) ancestors.unshift(parent);
  const content = D.wiki.content[id] ?? [["p", node.desc], ["ul", entry.points]];
  const percent = Math.round(node.mastery * 100);
  const editing = state.editingEntry === id;
  const article = editing ? `
        <label class="field" style="margin-top:14px">简介<textarea class="input" id="edit-desc" rows="2">${esc(node.desc)}</textarea></label>
        <label class="field" style="margin-top:12px">正文<textarea class="input mono" id="edit-content" rows="18">${esc(toText(content))}</textarea></label>
        <div class="small faint" style="margin-top:8px">支持 ## 小标题、- 列表、\`\`\` 代码块。保存后不会自动整理，后续整理也不会覆盖你手动编辑的内容</div>`
    : `<p class="lead">${esc(node.desc)}</p>
        <h3>正文</h3><div class="wiki-body">${renderBody(content)}</div>`;
  return `
    <div class="row small crumbs back-row"><a class="btn ghost back-btn" href="#/wiki">${icon("left", 18)} 返回</a>
      <a href="#/wiki">知识库</a><span class="faint">/</span><a href="#/wiki" data-wiki-cat="${category.id}">${category.name}</a>
      ${ancestors.map((ancestor) => `<span class="faint">/</span><a href="${wikiHref(ancestor)}">${ancestor}</a>`).join("")}<span class="faint">/</span><span>${id}</span></div>
    <div class="grid cols-main-side">
      <div class="card wiki-article">
        <div class="row"><h1>${id}</h1><div class="grow"></div>${editing ? `<span class="editing-badge">编辑中</span><button class="btn sm" data-action="cancel-edit-entry">取消</button><button class="btn sm primary" data-action="save-entry">保存</button>` : `<button class="btn sm" data-action="edit-entry">编辑</button><button class="btn sm" data-organize-scope="entry" data-organize-id="${esc(id)}">✦ 重新整理</button>${moreMenu(`<a href="#/wiki" data-graph-focus="${id}">在图谱中查看</a><button class="danger" data-delete-node="${id}">删除知识点</button>`)}`}</div>
        ${entry.aliases.length ? `<div class="muted small" style="margin-top:4px">又称：${entry.aliases.join(" · ")}</div>` : ""}
        <div class="chips" style="margin-top:10px"><span class="tag blue">${D.wiki.kinds[entry.kind]}</span><span class="tag">${category.name}</span>${node.userEdited ? `<span class="tag purple">✎ 手动编辑过</span>` : ""}${node.stale ? `<span class="tag orange">↻ 来源有变化，下次整理更新</span>` : ""}</div>
        ${editing ? "" : pendingBar("entry", id, entry.edited)}
        ${article}
        ${groups.length ? `<h3>关联词条</h3><table class="table wiki-rel">${groups.map(([label, list]) => `<tr><td class="muted">${label}</td><td>${list.map((other) => `<a href="${wikiHref(other)}">${other}</a>`).join("、")}</td></tr>`).join("")}</table>` : ""}
        ${excerpts.length ? `<h3>来源摘录</h3>${excerpts.map(([text, source]) => `<blockquote>${esc(text)}<div class="small" style="margin-top:4px">${sourceChip(source)}</div></blockquote>`).join("")}` : ""}
        <div class="small faint" style="margin-top:20px">最后整理 ${entry.updatedAt} · deepseek-chat · 内容由 ${sources.length} 条学习记录生成</div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-title">掌握程度<span class="more" id="mastery-label" style="font-weight:600;color:${masteryColor(node.mastery)}">${masteryLabel(node.mastery)} ${percent}%</span></div>
          <input type="range" class="mastery-range" min="0" max="100" value="${percent}" data-mastery="${id}" style="accent-color:${masteryColor(node.mastery)}">
          <div class="small muted" style="margin-top:6px;line-height:1.8">${node.masteryManual
            ? `<span class="tag purple">你手动设定</span> 自动计算值 ${Math.round(node.autoMastery * 100)}% · <a href="#" data-action="reset-mastery">恢复自动计算</a>`
            : `自动计算：相关阅读 ${fmtDuration(reading)} · ${sources.filter((source) => source.type === "conversation").length} 次问答。拖动滑块可手动设定`}</div>
        </div>
        ${notesCard("entry", id, "知识点备注", "包括整理时从收集点备注带过来的和你后续添加的。整理时作为意图信号；添加后不会自动重新整理")}
        <div class="card"><div class="card-title">来源<span class="more muted">${sources.length} 条</span></div>
          ${sources.map((source) => `<div class="list-item" data-open="${source.id}" style="padding:8px 0">${srcIcon(source.site, 24)}<div class="grow small">${esc(source.title)}<div class="faint">${source.capturedAt}</div></div></div>`).join("") || `<div class="small faint">暂无</div>`}
        </div>
        <div class="card"><div class="card-title">同分类词条</div><div class="chips">${siblings.map(conceptChip).join("")}</div></div>
      </div>
    </div>`;
}

/* ---------- Progress: timeline on the left, summary on the right ---------- */
function progress() {
  const { today, week, sources, streak } = D.stats;
  const max = Math.max(...week.map((day) => day.minutes));
  const maxSource = Math.max(...sources.map((source) => source.minutes));
  const unread = D.items.filter((entry) => entry.status === "unread").length;
  const unorganized = D.items.filter((entry) => !entry.organized).length;
  return `
    ${header("学习进度", "10月2日 周五 · 时间线只记录学习行为，按时间逐条展示", `<select class="input" style="width:130px"><option>最近 7 天</option><option>最近 30 天</option><option>自定义…</option></select>`)}
    <div class="progress-layout">
      <div>${timeline()}</div>
      <div class="stack">
        <div class="live">
          <div class="pulse"></div>
          <div class="grow" style="min-width:0"><div class="small muted">正在学习 · 来自浏览器扩展</div><div style="font-weight:600;margin-top:2px">${esc(D.live.title)}</div><div class="row" style="margin-top:4px"><span class="tag">${D.live.site}</span>${D.live.captured ? `<span class="tag green">已收集</span>` : ""}<div class="grow"></div><span id="live-timer" style="font-weight:650">${fmtDuration(state.liveSeconds)}</span></div></div>
        </div>
        <div class="grid cols-2" style="gap:12px">
          <div class="card stat"><div class="label">今日学习时长</div><div class="value">${fmtMinutes(today.minutes)}</div><div class="delta">连续学习 ${streak} 天</div></div>
          <div class="card stat"><div class="label">新收网页</div><div class="value">${today.pages}</div><div class="delta muted">知乎 2 · 掘金 1 · MDN 1</div></div>
          <div class="card stat"><div class="label">AI 问答</div><div class="value">${today.qa}</div><div class="delta muted">DeepSeek 4 · ChatGPT 2</div></div>
          <div class="card stat"><div class="label">备注</div><div class="value">${today.notes}</div><div class="delta muted">关联 2 篇内容</div></div>
        </div>
        <div class="card"><div class="card-title">近 7 天学习时长<span class="more muted">合计 ${fmtMinutes(week.reduce((sum, day) => sum + day.minutes, 0))}</span></div>
          <div class="bars">${week.map((day, index) => `<div class="bar-col"><div class="bar ${index === week.length - 1 ? "today" : ""}" style="height:${max ? (day.minutes / max) * 100 : 0}%"><span>${day.minutes ? fmtShort(day.minutes) : ""}</span></div><div class="small muted">${day.day}</div></div>`).join("")}</div>
        </div>
        <div class="card"><div class="card-title">待处理</div>
          <a class="todo" href="#/inbox"><span class="num" style="color:var(--primary)">${unread}</span><div class="grow"><div>未读内容</div><div class="small muted">收进来但还没回顾</div></div><span class="faint">→</span></a>
          <a class="todo" href="#/inbox" data-action="filter-unorganized"><span class="num" style="color:var(--purple)">${unorganized}</span><div class="grow"><div>待 AI 整理</div><div class="small muted">生成摘要、要点与知识点</div></div><span class="faint">→</span></a>
          <a class="todo" href="#/wiki"><span class="num" style="color:var(--orange)">${D.graph.nodes.filter((node) => node.mastery < 0.45).length}</span><div class="grow"><div>薄弱知识点</div><div class="small muted">${D.graph.nodes.filter((node) => node.mastery < 0.45).map((node) => node.id).join("、")}</div></div><span class="faint">→</span></a>
        </div>
        <div class="card"><div class="card-title">来源分布<span class="more muted">近 7 天</span></div>
          ${sources.map((source) => `<div class="hbar"><span>${source.name}</span><div class="hbar-track"><div class="hbar-fill" style="width:${(source.minutes / maxSource) * 100}%"></div></div><span class="small muted" style="text-align:right;white-space:nowrap">${fmtShort(source.minutes)}</span></div>`).join("")}
        </div>
      </div>
    </div>`;
}

const TIMELINE_KINDS = { webpage: ["page", "网页学习"], conversation: ["chat", "AI 问答"], document: ["doc", "文档阅读"], fuzzy: ["note", "模糊备注"] };

/** One row per item per day (a Q&A, a page studied, a document read) plus one row per fuzzy note, newest first; rows show the start time. */
function timelineRows(day) {
  const rows = [];
  day.events.forEach((event) => {
    if (isFuzzyNote(event)) return rows.push({ kind: "fuzzy", event, start: event.time });
    if (!event.item) return;
    const row = rows.find((other) => other.itemId === event.item);
    if (row) { row.events.push(event); if (clockValue(event.time) < clockValue(row.start)) row.start = event.time; }
    else rows.push({ kind: item(event.item)?.type ?? "webpage", itemId: event.item, events: [event], start: event.time });
  });
  return rows.sort((a, b) => clockValue(b.start) - clockValue(a.start));
}

function timelineRow(row) {
  if (row.kind === "fuzzy") {
    const { event } = row;
    const text = esc(noteText(event));
    return `<div class="event fuzzy"><span class="time">${row.start}</span><span class="ico">${icon("note")}</span><span class="ev-main"><span class="ev-title" title="${text}">${text}</span><span class="tag teal" title="不关联具体内容，整理时通过语义识别匹配">模糊备注</span></span><button class="btn sm ghost icon-btn" data-delete-fuzzy="${noteKey(event)}" title="删除这条模糊备注">${icon("trash", 14)}</button></div>`;
  }
  const entry = item(row.itemId);
  const reads = row.events.filter((event) => event.type === "reading_session_closed");
  const minutes = reads.reduce((sum, event) => sum + Number(event.text.match(/(\d+) 分钟/)?.[1] ?? 0), 0);
  const asked = row.events.find((event) => event.type === "user_message_sent");
  const answered = row.events.some((event) => event.type === "assistant_response_completed");
  const title = row.kind === "conversation" ? `${entry.site} · ${esc(entry.question ?? entry.title)}` : esc(entry.title);
  const meta = [
    row.events.some((event) => event.type === "webpage_captured") && "已收集",
    row.kind === "conversation" && asked && (answered ? "已回答" : "等待回答"),
    reads.length && `阅读 ${reads.length > 1 ? `${reads.length} 次 · 共 ` : ""}${minutes} 分钟`,
    entry.pages && `${entry.readPages}/${entry.pages} 页`
  ].filter(Boolean);
  return `<div class="event" data-open="${entry.id}"><span class="time">${row.start}</span><span class="ico">${icon(TIMELINE_KINDS[row.kind][0])}</span>
    <span class="ev-main"><span class="ev-title" title="${title}">${title}</span>${meta.map((text) => `<span class="tag">${text}</span>`).join("")}</span>
    <span class="faint">${icon("right", 14)}</span></div>`;
}

function timeline() {
  const visible = (row) => state.timelineTypes.size === 0 || state.timelineTypes.has(row.kind);
  return `
    <div class="chips" style="margin-bottom:18px"><button class="chip ${state.timelineTypes.size === 0 ? "active" : ""}" data-tl-type="all">全部</button>${Object.entries(TIMELINE_KINDS).map(([kind, [name, label]]) => `<button class="chip ${state.timelineTypes.has(kind) ? "active" : ""}" data-tl-type="${kind}">${icon(name, 13)} ${label}</button>`).join("")}</div>
    ${D.timeline.map((day) => {
      const rows = timelineRows(day).filter(visible);
      const collapsed = state.collapsedDays.has(day.day);
      return `<div class="day ${collapsed ? "collapsed" : ""}">
        <div class="day-head" data-collapse-day="${day.day}" title="${collapsed ? "展开" : "折叠"}"><span class="faint">${icon(collapsed ? "right" : "down", 16)}</span><h3>${day.day}</h3><span class="muted">${day.date}</span><span class="tag blue">学习 ${fmtMinutes(day.minutes)}</span><div class="grow"></div><span class="small muted">${rows.length} 条</span></div>
        ${collapsed ? "" : rows.length ? `<div class="day-body">${rows.map(timelineRow).join("")}</div>` : `<div class="small faint day-empty">没有符合条件的记录</div>`}
      </div>`;
    }).join("")}`;
}

/* ---------- Fuzzy notes: timeline notes not bound to any item; shown on the timeline and in the inbox ---------- */
let noteSeq = 0;
/** Stable selection key for a fuzzy note event; inbox selection mixes item ids and these keys. */
const noteKey = (event) => `note:${event.nid ??= ++noteSeq}`;
const isFuzzyNote = (event) => event.type === "user_note" && !event.item;
const noteText = (event) => event.text.replace(/^备注 · /, "");

function fuzzyNotes() {
  return D.timeline.flatMap((day) => day.events.filter(isFuzzyNote).map((event) => ({ event, day: day.day, key: noteKey(event) })));
}

function removeNotes(notes) {
  D.timeline.forEach((day) => { day.events = day.events.filter((event) => !notes.some((note) => note.event === event)); });
  notes.forEach((note) => state.selected.delete(note.key));
}

function deleteNotes(notes) {
  if (!notes.length) return;
  const mask = modal(`
    <h3>删除${notes.length > 1 ? ` ${notes.length} 条` : "这条"}模糊备注？</h3>
    ${notes.length === 1 ? `<div style="line-height:1.7">「${esc(noteText(notes[0].event))}」</div>` : ""}
    <div class="small muted">删除后不再作为整理的意图信号；已完成的整理结果不受影响。</div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>取消</button><button class="btn primary danger-fill" data-confirm>删除</button></div>`);
  mask.querySelector("[data-confirm]").addEventListener("click", () => {
    removeNotes(notes);
    mask.remove();
    toast(`已删除 ${notes.length} 条模糊备注`);
    render();
  });
}

const deleteFuzzyNote = (key) => deleteNotes(fuzzyNotes().filter((note) => note.key === key));

/* ---------- Inbox ---------- */
function listRow(entry) {
  const reading = entry.reading ? `${icon("clock", 13)} ${fmtDuration(entry.reading.total)}${entry.reading.sessions.length > 1 ? ` · ${entry.reading.sessions.length} 次` : ""}` : "";
  return `<div class="list-item" data-open="${entry.id}">
    <label class="check-hit" title="选择"><input type="checkbox" data-select="${entry.id}" ${state.selected.has(entry.id) ? "checked" : ""}></label>
    ${srcIcon(entry.site)}
    <div class="grow" style="min-width:0">
      <div class="title-row"><span class="title" title="${esc(entry.title)}">${esc(entry.title)}</span>${statusTags(entry)}</div>
      <div class="meta"><span>${entry.site}</span><span>${TYPE_LABEL[entry.type]}</span>${reading ? `<span>${reading}</span>` : ""}<span>${REASON[entry.reason]}</span>${tags(entry.tags)}</div>
    </div>
    <div class="right-meta"><span>${entry.capturedAt}</span></div>
  </div>`;
}

function trashList() {
  if (!D.trash.length) return `<div class="empty">回收站是空的。删除的内容会在这里保留 30 天，可撤销</div>`;
  return D.trash.map((entry, index) => `<div class="list-item" style="cursor:default">${srcIcon(entry.item.site)}
    <div class="grow"><div class="title">${esc(entry.item.title)}</div>
      <div class="meta"><span>${entry.deletedAt} 删除</span><span>${entry.removeFromKB ? `知识库已同步移除${entry.removedNodes.length ? ` · 删除 ${entry.removedNodes.length} 个知识点` : ""}` : "知识库内容已保留"}</span><span>29 天后彻底删除</span></div></div>
    <div class="row"><button class="btn sm" data-restore="${index}">撤销删除</button><button class="btn sm danger" data-purge="${index}">彻底删除</button></div></div>`).join("");
}

function inboxList() {
  if (state.inboxTab === "note") return [];
  return D.items.filter((entry) => (state.inboxTab === "all" || entry.type === state.inboxTab)
    && (state.inboxStatus === "all" || {
      unread: entry.status === "unread", read: entry.status !== "unread", organized: entry.organized, unorganized: !entry.organized
    }[state.inboxStatus]));
}

const DAY_OFFSET = { 今天: 0, 昨天: 1, 周四: 1, 周三: 2, 周二: 3, 周一: 4, 周日: 5, 周六: 6 };
const recency = (day, time) => (DAY_OFFSET[day] ?? 7) * 1440 - clockValue(time);

/** Items and fuzzy notes mixed, newest first; notes have no read/organize status, so they only show under 全部状态. */
function inboxRows() {
  const notes = state.inboxTab === "note" || (state.inboxTab === "all" && state.inboxStatus === "all") ? fuzzyNotes() : [];
  return [
    ...inboxList().map((entry) => ({ key: entry.id, entry, order: recency(...entry.capturedAt.split(" ")) })),
    ...notes.map((note) => ({ key: note.key, note, order: recency(note.day, note.event.time) }))
  ].sort((a, b) => a.order - b.order);
}

/** Current page of inboxRows; select-all applies to this page only. */
function inboxPage(rows = inboxRows()) {
  const pages = Math.max(1, Math.ceil(rows.length / state.inboxPageSize));
  state.inboxPage = Math.min(Math.max(1, state.inboxPage), pages);
  const start = (state.inboxPage - 1) * state.inboxPageSize;
  return { rows: rows.slice(start, start + state.inboxPageSize), total: rows.length, pages };
}

function pager({ total, pages }) {
  const page = state.inboxPage;
  const nums = Array.from({ length: pages }, (_, index) => index + 1).filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 1);
  const links = nums.map((n, index) => `${index && n - nums[index - 1] > 1 ? `<span class="faint">…</span>` : ""}<button class="pg ${n === page ? "active" : ""}" data-inbox-page="${n}">${n}</button>`).join("");
  return `<div class="pager"><span class="small muted">共 ${total} 条</span><div class="grow"></div>
    <select class="input" id="inbox-page-size">${[20, 50, 100].map((size) => `<option value="${size}" ${state.inboxPageSize === size ? "selected" : ""}>${size} 条/页</option>`).join("")}</select>
    <button class="pg" data-inbox-page="${page - 1}" ${page === 1 ? "disabled" : ""}>${icon("left", 14)}</button>${links}<button class="pg" data-inbox-page="${page + 1}" ${page === pages ? "disabled" : ""}>${icon("right", 14)}</button></div>`;
}

const selectedItems = () => [...state.selected].map(item).filter(Boolean);
const selectedNotes = () => fuzzyNotes().filter((note) => state.selected.has(note.key));

function fuzzyNoteRow({ event, day, key }) {
  return `<div class="list-item note-item" style="cursor:default">
    <label class="check-hit" title="选择"><input type="checkbox" data-select="${key}" ${state.selected.has(key) ? "checked" : ""}></label>
    <span class="note-icon">${icon("note", 16)}</span>
    <div class="grow" style="min-width:0"><div class="title-row"><span class="title" title="${esc(noteText(event))}">${esc(noteText(event))}</span><span class="tag teal" title="不关联具体内容，整理时通过语义识别匹配">模糊备注</span></div>
      <div class="meta">${event.source ? `<span>${esc(event.source)}</span>` : ""}<span>整理时作为意图信号</span></div></div>
    <div class="right-meta"><span>${day} ${event.time}</span><button class="btn sm ghost icon-btn" data-delete-fuzzy="${key}" title="删除这条模糊备注">${icon("trash", 14)}</button></div></div>`;
}

const inboxFilterKey = () => `${state.inboxTab}|${state.inboxStatus}|${state.inboxPage}|${state.inboxPageSize}`;

function inbox() {
  const tabs = [["all", "全部"], ["webpage", "网页"], ["conversation", "问答"], ["document", "文档"], ["note", "备注"]];
  const statuses = [["all", "全部状态"], ["unread", "未读"], ["read", "已读"], ["organized", "已整理"], ["unorganized", "待整理"]];
  const paged = inboxPage();
  const rows = paged.rows;
  const count = (type) => type === "note" ? fuzzyNotes().length : D.items.filter((entry) => type === "all" || entry.type === type).length;
  const picked = rows.filter((row) => state.selected.has(row.key)).length;
  const allChecked = state.selectAllKey === inboxFilterKey() && rows.length > 0 && picked === rows.length;
  const hidden = state.selected.size - picked;
  const organizeRanges = state.selected.size ? "selected,batch,all" : "batch,all";
  const body = state.inboxTab === "trash" ? `<div class="inbox-scroll">${trashList()}</div>` : `
      <div class="row" style="margin-bottom:10px"><label class="select-all" title="一次性选中当前筛选结果，切换筛选后不会自动选中其他内容"><input type="checkbox" data-select-all ${allChecked ? "checked" : ""} ${!allChecked && picked ? "data-partial" : ""} ${rows.length ? "" : "disabled"}> 全选</label>
        ${state.inboxTab === "note" ? `<span class="small muted">采集时通过扩展写下的备注，不关联具体内容，整理时按语义匹配</span>` : `<div class="chips">${statuses.map(([id, label]) => `<button class="chip ${state.inboxStatus === id ? "active" : ""}" data-inbox-status="${id}">${label}</button>`).join("")}</div>`}</div>
      ${state.selected.size ? `<div class="batch-bar">已选 ${state.selected.size} 项${hidden ? `<span class="small" style="opacity:.75">（${hidden} 项不在当前筛选中）</span>` : ""}<div class="grow"></div>${selectedItems().length ? `<button class="btn sm" data-action="batch-read">标记已读</button>` : ""}<button class="btn sm" data-organize-scope="selected" data-organize-ranges="${organizeRanges}">✦ 整理</button><button class="btn sm danger" data-action="batch-delete">删除</button><button class="btn sm ghost" data-action="batch-clear">取消</button></div>` : ""}
      ${rows.length ? `<div class="inbox-scroll">${rows.map((row) => row.note ? fuzzyNoteRow(row.note) : listRow(row.entry)).join("")}</div>${pager(paged)}` : `<div class="empty">${state.inboxTab === "note" ? "还没有时间线备注" : "没有符合条件的内容"}</div>`}`;
  return `
    ${header("收集箱", `共 ${D.items.length} 条`, `<button class="btn" data-organize-scope="${state.selected.size ? "selected" : "batch"}" data-organize-ranges="${organizeRanges}">✦ 整理</button>`)}
    <div class="card inbox-card">
      <div class="tabs">${tabs.map(([id, label]) => `<button class="tab ${state.inboxTab === id ? "active" : ""}" data-inbox-tab="${id}">${label} <span class="faint">${count(id)}</span></button>`).join("")}<div class="grow"></div><button class="tab ${state.inboxTab === "trash" ? "active" : ""}" data-inbox-tab="trash">${icon("trash", 14)} 回收站 <span class="faint">${D.trash.length}</span></button></div>
      ${body}
    </div>`;
}

function detail(id) {
  const entry = item(id);
  if (!entry) return `<div class="empty">内容不存在</div>`;
  if (entry.status === "unread") entry.status = "read";
  const ai = entry.organized ? `
    <div class="card ai-card"><div class="card-title">✦ AI 整理<span class="more"><button class="btn sm" data-organize-scope="item" data-organize-id="${entry.id}">✦ 重新整理</button></span></div>
      ${pendingBar("item", entry.id, entry.edited)}
      <div class="prose">${esc(entry.summary)}</div>
      ${entry.points ? `<ul>${entry.points.map((point) => `<li>${esc(point)}</li>`).join("")}</ul>` : ""}
      <div class="small faint" style="margin-top:10px">deepseek-chat · 提示词 v1 · 2026-10-02 14:30</div>
    </div>` : `
    <div class="card ai-card"><div class="card-title">✦ AI 整理</div>
      <div class="muted" style="margin-bottom:10px">还没整理。整理后会生成摘要和要点，并把知识点加入知识库。</div>
      <button class="btn primary" data-organize-scope="item" data-organize-id="${entry.id}">✦ 整理</button>
    </div>`;
  const blocks = entry.type === "conversation" ? entry.answer : entry.body;
  const main = state.editingItem === entry.id ? `
      <label class="field">标题<input class="input" id="edit-title" value="${esc(entry.title)}"></label>
      <label class="field" style="margin-top:12px">${entry.type === "conversation" ? "回答" : "正文"}<textarea class="input mono" id="edit-body" rows="16">${esc(toText(blocks))}</textarea></label>
      <div class="small faint" style="margin-top:8px">用于修正采集错误或删减无关内容。保存后不会自动整理，需要时点击「重新整理」</div>`
    : entry.type === "conversation" ? `
      <div class="qa-q">${esc(entry.question)}</div>
      ${entry.reasoning ? `<details class="reasoning"><summary>思考过程</summary><div style="margin-top:6px">${esc(entry.reasoning)}</div></details>` : ""}
      <div class="prose">${renderBody(entry.answer)}</div>`
    : `<div class="prose">${renderBody(entry.body)}</div>${entry.type === "document" ? `<a class="btn" href="#/reader/${entry.id}" style="margin-top:8px">在学习区继续阅读 →</a>` : ""}`;
  return `
    <div class="row back-row"><a class="btn ghost back-btn" href="#/inbox">${icon("left", 18)} 返回</a></div>
    <div class="grid cols-main-side">
      <div class="stack">
        <div class="card">
          <div class="detail-head">
            <div class="row">${srcIcon(entry.site, 22)}<span class="muted">${entry.site} · ${TYPE_LABEL[entry.type]} · ${entry.capturedAt} 收集 · ${REASON[entry.reason]}</span></div>
            <h2>${esc(entry.title)}</h2>
            <div class="row wrap">${statusTags(entry)}${entry.edited ? `<span class="tag">✎ 已编辑</span>` : ""}${tags(entry.tags)}<button class="btn sm ghost" data-action="add-tag">+ 标签</button>
              <div class="grow"></div>
              ${state.editingItem === entry.id ? `<span class="editing-badge">编辑中</span>
              <button class="btn sm" data-action="cancel-edit-item">取消</button>
              <button class="btn sm primary" data-action="save-item" data-id="${entry.id}">保存</button>` : `
              ${entry.url ? `<a class="btn sm" href="${entry.url}" target="_blank">打开原文 ↗</a>` : ""}
              <button class="btn sm" data-action="edit-item" data-id="${entry.id}">编辑内容</button>
              ${moreMenu(`<button class="danger" data-action="delete" data-id="${entry.id}">删除</button>`)}`}
            </div>
          </div>
        </div>
        ${ai}
        <div class="card">${main}</div>
      </div>
      <div class="stack">
        ${entry.reading ? `<div class="card"><div class="card-title">${icon("clock")} 阅读记录<span class="more" style="font-weight:600">${fmtDuration(entry.reading.total)}</span></div>
          ${entry.reading.sessions.map((session) => `<div class="session-row"><span>${session.at}${session.first ? ` <span class="tag green">首次 · 入箱</span>` : ""}</span><span class="muted">${fmtDuration(session.seconds)}</span></div>`).join("")}
          <div class="small faint" style="margin-top:8px">首次停留全额计入；之后每次可见 ≥ 60 秒才累加</div>
          ${entry.pages ? `<div class="small muted" style="margin-top:8px">已读 ${entry.readPages} / ${entry.pages} 页</div><div class="progress"><div style="width:${(entry.readPages / entry.pages) * 100}%"></div></div>` : ""}
        </div>` : ""}
        ${notesCard("item", entry.id, "收集点备注", "和这条内容绑定（网页备注、划词备注、工作台补充），整理时作为意图信号并带入知识点。已整理的内容新增备注不会自动重新整理")}
        <div class="card"><div class="card-title">✦ 关联知识点</div>
          <div class="chips">${entry.concepts.length ? entry.concepts.map((concept) => conceptChip(concept) || `<span class="chip">${concept}</span>`).join("") : `<span class="small faint">整理后自动生成</span>`}</div>
        </div>
      </div>
    </div>`;
}

/* ---------- Study area ---------- */
function study() {
  const docs = D.items.filter((entry) => entry.type === "document");
  return `
    ${header("学习区", "在这里阅读的文档会自动记录阅读时长与进度，并作为强学习来源进入收集箱")}
    <div class="dropzone" id="dropzone"><div class="faint">${icon("doc", 28)}</div><div style="font-weight:600;margin:6px 0">拖入 PDF / PPT / PPTX，或 <a href="#" data-action="upload">选择文件</a></div><div class="small">文件保存在本地 inbox/documents/，不会上传到任何服务器</div></div>
    <div class="card" style="margin-top:16px"><div class="card-title">我的文档<span class="more muted">网页请直接在浏览器中阅读，扩展会自动采集</span></div>
      <div class="grid cols-2">
        ${docs.map((doc) => `<div class="doc-card card" data-reader="${doc.id}">
          <div class="doc-thumb" style="background:${D.sites[doc.site].color}">${doc.site}</div>
          <div class="grow"><div style="font-weight:600">${esc(doc.title)}</div>
            <div class="small muted" style="margin-top:4px">已读 ${doc.readPages}/${doc.pages} 页 · 累计 ${fmtDuration(doc.reading.total)} · ${doc.capturedAt} 添加</div>
            <div class="progress"><div style="width:${(doc.readPages / doc.pages) * 100}%"></div></div></div>
          <span class="btn sm">继续阅读</span></div>`).join("")}
      </div>
    </div>`;
}

function reader(id) {
  const doc = item(id);
  const isSlide = doc.site === "PPT";
  const pages = Array.from({ length: Math.min(doc.pages, 12) }, (_, index) => index + 1);
  return `
    <div class="row back-row"><a href="#/study" class="btn ghost back-btn">${icon("left", 18)} 返回</a><strong>${esc(doc.title)}</strong><span class="tag green">● 记录中 · 本次 3 分 12 秒</span><div class="grow"></div>
      <button class="btn sm" data-page="-1">上一页</button><span class="small muted">第 ${state.docPage} / ${doc.pages} 页</span><button class="btn sm" data-page="1">下一页</button></div>
    <div class="reader">
      <div class="thumbs">${pages.map((page) => `<div class="thumb ${page === state.docPage ? "active" : ""} ${page <= doc.readPages ? "read" : ""}" data-goto="${page}">${page}</div>`).join("")}</div>
      <div class="page-sheet ${isSlide ? "slide" : ""}">
        ${isSlide ? `<h2>混合检索：BM25 + 向量</h2><p>• 关键词检索擅长精确匹配专有名词</p><p>• 向量检索擅长语义相近的表达</p><p>• 分数归一化后用 RRF 融合</p>`
          : `<h2>3.2 Attention</h2><p>An attention function can be described as mapping a query and a set of key-value pairs to an output, where the query, keys, values, and output are all vectors.</p><p>The output is computed as a weighted sum of the values, where the weight assigned to each value is computed by a compatibility function of the query with the corresponding key.</p><p style="background:#fff3bf">We call our particular attention "Scaled Dot-Product Attention". The input consists of queries and keys of dimension d<sub>k</sub>, and values of dimension d<sub>v</sub>.</p><p>In practice, we compute the attention function on a set of queries simultaneously, packed together into a matrix Q.</p>`}
      </div>
      <div class="stack" style="align-content:start">
        <div class="card"><div class="card-title">本页高亮与备注</div>
          <div class="note">“Scaled Dot-Product Attention” —— 除以 √d<sub>k</sub> 是为了防止点积过大导致 softmax 梯度消失。</div>
          <textarea class="input" rows="3" placeholder="选中文字后可直接添加备注…" style="margin-top:10px"></textarea>
          <div class="row" style="margin-top:8px;justify-content:flex-end"><button class="btn sm primary" data-action="save-note">保存</button></div>
        </div>
        <div class="card"><div class="card-title">阅读进度</div>
          <div class="small muted">已读 ${doc.readPages}/${doc.pages} 页 · 累计 ${fmtDuration(doc.reading.total)}</div>
          <div class="progress"><div style="width:${(doc.readPages / doc.pages) * 100}%"></div></div>
          <div class="small faint" style="margin-top:8px">每页可见 ≥ 10 秒记为已读</div>
        </div>
      </div>
    </div>`;
}

/* ---------- Settings: one page, four sections, single-column rows ---------- */
const SETTINGS_SECTIONS = [
  ["collect", "采集", "浏览器扩展、学习门槛和排除规则。修改后扩展自动同步"],
  ["ai", "AI 模型", "服务商、按任务选模型和用量。API Key 只保存在本机"],
  ["organize", "整理规则", "什么时候自动整理。每次整理的结果见「整理记录」"],
  ["profile", "学习者档案", "你的角色和近期学习方向，整理时作为判断学习和入库的加分参考"],
  ["data", "数据与隐私", "本地数据、备份和危险操作"]
];
const setGroup = (title, rows, extra = "", foot = "") => `<section class="set-group"><div class="set-group-head"><h3>${title}</h3><div class="grow"></div>${extra}</div><div class="set-card">${rows}</div>${foot ? `<div class="set-foot">${foot}</div>` : ""}</section>`;
const setRow = (label, desc, control = "", cls = "") => `<div class="set-row ${cls}"><div class="grow" style="min-width:0"><div class="set-label">${label}</div>${desc ? `<div class="set-desc">${desc}</div>` : ""}</div>${control ? `<div class="set-control">${control}</div>` : ""}</div>`;
const switchBtn = (on, attrs) => `<button class="switch ${on ? "on" : ""}" ${attrs}></button>`;

function settings(section = "collect") {
  const current = SETTINGS_SECTIONS.find(([id]) => id === section) ?? SETTINGS_SECTIONS[0];
  const body = { collect: settingsCollect, ai: settingsAI, organize: settingsOrganize, profile: settingsProfile, data: settingsData }[current[0]]();
  return `<div class="settings-layout">
    <nav class="settings-nav"><div class="settings-nav-title">设置</div>${SETTINGS_SECTIONS.map(([id, label]) => `<a class="settings-link ${id === current[0] ? "active" : ""}" href="#/settings/${id}">${label}</a>`).join("")}</nav>
    <div class="settings-body"><div class="settings-head"><h1>${current[1]}</h1><div class="muted">${current[2]}</div></div>${body}</div>
  </div>`;
}

function settingsCollect() {
  const t = state.threshold;
  const c = D.connection;
  const range = (key, min, max, unit) => `<input type="range" min="${min}" max="${max}" value="${t[key]}" data-range="${key}"><span class="range-val">${t[key]}${unit}</span>`;
  return setGroup("浏览器扩展",
      setRow(`<span class="dot"></span>已连接`, `最后上报 ${c.extensionLastSeen} · 离线队列 ${c.pending} 条`, `<a class="btn sm" href="#">安装扩展</a>`)
      + setRow("配对令牌", `<span class="mono">${c.token.slice(0, 8)}••••••••••••${c.token.slice(-4)}</span>`, `<button class="btn sm" data-action="copy-token">复制</button>`))
    + setGroup("学习门槛",
      setRow("入箱所需可见时长", "页面在前台可见的累计时间", range("minActiveSeconds", 5, 300, " 秒"), "range")
      + setRow("入箱所需滚动深度", "读到页面的百分之多少", range("minScrollDepth", 0, 100, "%"), "range")
      + setRow("再次停留计时下限", "之后每次停留超过这个时长才累加阅读时间", range("minRevisitSeconds", 3, 300, " 秒"), "range"),
      `<div class="seg"><button class="${state.preset === "prod" ? "active" : ""}" data-preset="prod">正式</button><button class="${state.preset === "dev" ? "active" : ""}" data-preset="dev">调试</button></div>`,
      "复制、划词、写备注会立即入箱；同一页面只收集一次")
    + setGroup("对话平台",
      setRow("ChatGPT", "采集你的提问与完整回答", switchBtn(state.platforms.chatgpt, 'data-platform="chatgpt"'))
      + setRow("DeepSeek", "采集你的提问与完整回答", switchBtn(state.platforms.deepseek, 'data-platform="deepseek"')))
    + setGroup("排除规则",
      D.rules.map((rule, index) => setRow(`<span class="tag">${rule.kind}</span> <span class="mono">${esc(rule.value)}</span>`, esc(rule.note), `<button class="btn sm ghost danger" data-remove-rule="${index}" title="删除规则">${icon("trash", 14)}</button>`)).join("")
      + `<details class="set-row set-details"><summary>内置列表页规则 · ${D.builtinRules.length} 条（只读）</summary><ul>${D.builtinRules.map((rule) => `<li>${rule}</li>`).join("")}</ul></details>`,
      `<button class="btn sm" data-action="add-rule">＋ 添加规则</button>`,
      "命中规则的页面不会被采集，也不会计入学习时长");
}

function settingsAI() {
  const percent = Math.round((D.usage.todayTokens / D.usage.limitTokens) * 100);
  const provider = (entry) => {
    const open = state.provider === entry.id;
    const used = D.tasks.filter((task) => task.provider === entry.name).length;
    return `<div class="set-row provider-row ${open ? "open" : ""}" data-provider="${entry.id}">
        <div class="provider-logo" style="background:${entry.color}">${entry.logo}</div>
        <div class="grow"><div class="set-label">${entry.name}</div><div class="set-desc">${entry.status === "ok" ? `<span class="dot"></span>已连接${used ? ` · 用于 ${used} 项任务` : ""}` : `<span class="dot off"></span>未配置`}</div></div>
        <span class="faint">${icon(open ? "down" : "right")}</span></div>
      ${open ? `<div class="provider-form">
        <label class="field">Base URL<input class="input" value="${entry.baseUrl}"></label>
        <div class="form-grid"><label class="field">API Key<input class="input" value="${entry.key}" placeholder="sk-..."></label><label class="field">默认模型<input class="input" value="${entry.model}"></label></div>
        <div class="row"><span class="small muted">Key 以掩码显示，不会出现在日志与导出包中</span><div class="grow"></div><button class="btn sm" data-action="test-provider">测试连接</button><button class="btn sm primary" data-action="save-provider">保存</button></div>
      </div>` : ""}`;
  };
  const choices = D.providers.filter((entry) => entry.status === "ok");
  const taskSelect = (task) => `<select class="input" style="width:240px" data-task="${task.id}">${choices.map((entry) => `<option value="${entry.name}" ${entry.name === task.provider ? "selected" : ""}>${entry.name} · ${entry.name === task.provider ? task.model : entry.model}</option>`).join("")}</select>`;
  const taskRow = (task) => setRow(`${task.step ? `<span class="step-no">${task.step}</span>` : ""}${task.name} <span class="faint small" style="font-weight:400">${task.en}</span>`, task.desc, taskSelect(task));
  const taskOf = (id) => D.tasks.find((task) => task.id === id);
  const flow = D.pipeline.map((step) => {
    const task = step.task && taskOf(step.task);
    const model = step.kind === "llm" ? task.model : task ? `${task.model}` : "本地规则";
    return `<div class="flow-step ${step.kind}" title="${step.en}"><div><span class="step-no">${step.step}</span>${step.name}</div><div class="small ${step.kind === "llm" ? "" : "faint"}">${esc(model)}</div></div>`;
  }).join(`<span class="flow-arrow">→</span>`);
  return `<div class="usage-strip">
      <div class="grow"><div class="set-desc" style="margin:0 0 4px">今日用量</div><div><b style="font-size:18px">${(D.usage.todayTokens / 1000).toFixed(1)}k</b> <span class="muted">/ ${D.usage.limitTokens / 1000}k tokens · ${D.usage.calls} 次调用</span></div>
        <div class="progress"><div style="width:${percent}%;background:var(--purple)"></div></div></div>
      <label class="field" style="width:160px">每日上限<input class="input" value="${D.usage.limitTokens}"></label>
    </div>`
    + setGroup("模型服务商", D.providers.map(provider).join(""), `<button class="btn sm" data-action="add-provider">＋ 添加服务商</button>`, "点击服务商展开配置；达到每日上限后自动整理会暂停")
    + `<section class="set-group"><div class="set-group-head"><h3>整理流水线</h3><div class="grow"></div><span class="small muted">紫色为调用模型的阶段</span></div><div class="flow">${flow}</div></section>`
    + setGroup("整理阶段模型", D.tasks.filter((task) => task.group === "organize").map(taskRow).join(""), "",
      "学习判定只读行为摘要（搜索词、标题、提问、时长），调用最频繁，适合本地小模型；知识判定和抽取需要读正文，建议用效果更好的模型")
    + setGroup("对话与检索", D.tasks.filter((task) => task.group === "other").map(taskRow).join(""), "",
      "更换 Embedding 模型后需要在「数据与隐私」中重建索引");
}

function settingsProfile() {
  const { role, focus } = D.profile;
  return setGroup("角色", setRow("你的角色", "帮助判断哪些内容和你的工作相关", `<input class="input" id="profile-role" value="${esc(role)}" placeholder="例如：产品经理" style="width:220px">`)
      + `<div class="set-row"><div class="chips">${ROLE_CHIPS.map((text) => `<button class="chip ${text === role ? "active" : ""}" data-role-chip="${text}">${text}</button>`).join("")}</div></div>`)
    + setGroup("近期学习方向",
      (focus.map((entry, index) => setRow(esc(entry.topic), `${entry.expires} 到期，到期后不再参与整理`, `<button class="btn sm" data-renew-focus="${index}">续期 30 天</button><button class="btn sm ghost danger" data-remove-focus="${index}" title="移除">${icon("trash", 14)}</button>`)).join("") || setRow("还没有学习方向", "添加后，相关内容在整理时更容易入库"))
      + `<div class="set-row"><input class="input" id="profile-focus-new" placeholder="例如：LangGraph、Agent 架构"><select class="input" id="profile-focus-days" style="width:110px"><option value="7">7 天</option><option value="30" selected>30 天</option><option value="90">90 天</option></select><button class="btn" data-action="profile-add-focus">添加</button></div>`,
      `<span class="small muted">${focus.length} 个</span>`,
      "也可以在首页对话里直接说「我最近在学 AI 相关知识」「我是产品经理」，会自动记录到这里")
    + setGroup("如何使用", setRow("只加分，不减分", "整理时作为「学习判定」和「知识判定」的参考：和档案相关的内容更容易被判定为学习并入库；档案以外的内容只要你在主动搜索、追问、记笔记，照样会入库"));
}

function settingsOrganize() {
  const o = D.organize;
  const trigger = (label, desc, control) => setRow(label, desc, control, `sub ${o.auto ? "" : "disabled-block"}`);
  return setGroup("自动整理",
      setRow("自动整理", o.auto ? "按下方条件自动整理，可同时开启多个" : "已关闭，只在你手动点击「整理」时运行", switchBtn(o.auto, 'data-action="toggle-auto"'))
      + trigger("每天定时整理", "整理当天新增的未整理内容", `<input class="input" type="time" value="${o.schedule.time}" style="width:110px" ${o.schedule.on ? "" : "disabled"}>${switchBtn(o.schedule.on, 'data-organize="schedule"')}`)
      + trigger("攒够数量后整理", "未整理内容达到数量即跑一批", `<input class="input" type="number" value="${o.batch.count}" style="width:72px" ${o.batch.on ? "" : "disabled"}><span class="small muted">条</span>${switchBtn(o.batch.on, 'data-organize="batch"')}`)
      + trigger("入箱即整理", "收集后立刻整理，消耗最高", switchBtn(o.onCapture.on, 'data-organize="onCapture"')),
      `<span class="small muted">上次 ${o.lastRun} · 下次 ${o.auto && o.schedule.on ? o.nextRun : "—"} · 待整理 ${o.pendingCount} 条</span>`,
      "已整理且内容没变的记录不会重复整理；服务未运行时错过的定时任务会在下次启动时补跑")
    + setGroup("输出", setRow("整理语言", "摘要、要点和知识库正文的语言", `<select class="input" style="width:120px"><option>中文</option><option>跟随原文</option></select>`))
    + setGroup("整理记录", setRow(`最近一次：${D.runs[0]?.at ?? "—"}`, `共 ${D.runs.length} 次整理`, `<a class="btn sm" href="#/runs">查看整理记录 →</a>`));
}

/* ---------- Organize runs: one page, newest first ---------- */
const DECISION_LABEL = [["new", "新知识", "green"], ["supplement", "补充", "teal"], ["duplicate", "重复（挂来源）", "blue"], ["reject", "不入库", "orange"], ["notLearning", "非学习片段", ""]];
function runs() {
  const o = D.organize;
  const sum = (key) => D.runs.reduce((total, run) => total + run[key], 0);
  const tokens = D.runs.reduce((total, run) => total + run.tokens, 0);
  const card = (run) => {
    const e = run.episodes;
    const episodeText = e.learning + e.notLearning + e.deferred ? `学习 ${e.learning} · 非学习 ${e.notLearning}${e.deferred ? ` · 推迟 ${e.deferred}` : ""}` : "未切分";
    return `<div class="card run-card">
      <div class="row"><b>${run.at}</b><span class="tag">${run.trigger}</span>${run.failed ? `<span class="tag red">失败 ${run.failed}</span>` : ""}<span class="small faint">耗时 ${run.duration}</span><div class="grow"></div>${run.failed ? `<button class="btn sm" data-action="retry-run">重试失败项</button>` : ""}</div>
      <div class="run-stats">
        <div><div class="small muted">处理条目</div><b>${run.items}</b></div>
        <div><div class="small muted">活动片段</div><b class="small-b">${episodeText}</b></div>
        <div><div class="small muted">已入库</div><b style="color:var(--green)">${run.ingested}</b></div>
        <div><div class="small muted">未采纳</div><b style="color:var(--orange)">${run.rejected}</b></div>
        <div><div class="small muted">知识库变化</div><b class="small-b">${run.kb}</b></div>
      </div>
      <div class="chips">${DECISION_LABEL.filter(([key]) => run.decisions[key]).map(([key, label, color]) => `<span class="tag ${color}">${label} ${run.decisions[key]}</span>`).join("")}</div>
      ${run.skipped ? `<div class="small muted" style="margin-top:8px">${run.skipped}</div>` : ""}
      ${run.error ? `<div class="small" style="margin-top:8px;color:var(--red)">${run.error}</div>` : ""}
      <details class="run-steps"><summary class="small muted">各阶段消耗 · ${(run.tokens / 1000).toFixed(1)}k tokens</summary>
        <div class="stack" style="gap:4px;margin-top:8px">${run.steps.map(([name, calls, used]) => {
          const task = D.tasks.find((entry) => entry.name === name);
          return `<div class="row small"><span style="width:96px">${name}</span><span class="faint" style="width:150px">${task ? `${task.provider} · ${task.model}` : ""}</span><span class="muted">${calls} 次调用</span><div class="grow"></div><span class="muted">${(used / 1000).toFixed(1)}k</span></div>`;
        }).join("")}</div></details>
    </div>`;
  };
  return `${header("整理记录", `共 ${D.runs.length} 次 · 每次整理的判定结果、知识库变化和消耗`, `<a class="btn" href="#/settings/organize">整理规则</a>`)}
    <div class="run-summary">
      <div class="card"><div class="small muted">自动整理</div><b>${o.auto ? "已开启" : "已关闭"}</b><div class="small faint">上次 ${o.lastRun} · 下次 ${o.auto && o.schedule.on ? o.nextRun : "—"}</div></div>
      <div class="card"><div class="small muted">待整理</div><b style="color:var(--purple)">${o.pendingCount}</b><div class="small faint">条收集内容</div></div>
      <div class="card"><div class="small muted">近 ${D.runs.length} 次 已入库 / 未采纳</div><b><span style="color:var(--green)">${sum("ingested")}</span> / <span style="color:var(--orange)">${sum("rejected")}</span></b><div class="small faint">失败 ${sum("failed")} 条</div></div>
      <div class="card"><div class="small muted">近 ${D.runs.length} 次消耗</div><b>${(tokens / 1000).toFixed(1)}k</b><div class="small faint">tokens</div></div>
    </div>
    <div class="stack" style="gap:12px">${D.runs.map(card).join("")}</div>`;
}

function settingsData() {
  const c = D.connection;
  return setGroup("本地数据",
      setRow("本地服务", "127.0.0.1:43118 · 运行中", `<span class="tag green">正常</span>`)
      + setRow("数据目录", `${c.dataDir} · ${c.size} · ${c.items} 条内容`, `<button class="btn sm" data-action="reveal">打开目录</button>`)
      + setRow("导出备份", "打包收集内容、时间线和整理结果为 zip，不含 API Key", `<button class="btn sm" data-action="export">导出</button>`)
      + setRow("重建索引", "从原始文件重新生成搜索与统计索引，不会修改内容", `<button class="btn sm" data-action="rebuild">重建</button>`))
    + setGroup("隐私", setRow("数据只保存在本机", "收集内容、笔记和知识库都存放在数据目录；只有整理和对话时，相关内容会发送给你配置的模型服务商"))
    + `<section class="set-group danger-zone"><div class="set-group-head"><h3>危险操作</h3></div><div class="set-card">
      ${setRow("重置配对令牌", "旧令牌立即失效，需要在浏览器扩展中重新配对", `<button class="btn sm danger" data-action="reset-token">重置</button>`)}
      ${setRow("清空所有数据", "删除全部收集内容、时间线、笔记和知识库，无法恢复", `<button class="btn sm danger" data-action="wipe-data">清空</button>`)}
    </div></section>`;
}

/* ---------- Router ---------- */
/* #/home · #/study · #/reader/:id · #/wiki · #/wiki/:entry · #/progress · #/inbox · #/item/:id · #/runs · #/settings/:section */
const ROUTES = { home, study, reader, wiki: (id) => id ? wikiEntry(id) : wiki(), progress, inbox, item: detail, runs, settings };
let lastHash = "";
function currentRoute() {
  const [path = "home", raw] = location.hash.replace(/^#\/?/, "").split("/");
  return [ROUTES[path] ? path : "home", raw && decodeURIComponent(raw)];
}

function render() {
  const [route, param] = currentRoute();
  const view = ROUTES[route];
  const hashChanged = location.hash !== lastHash;
  if (hashChanged) state.scrollMemory[lastHash] = window.scrollY;
  state.lastRoute[MODULE_OF[route] ?? route] = location.hash || "#/home";
  renderNav(route);
  $main.classList.toggle("wide", route === "wiki" && !param);
  $main.classList.toggle("fit", (route === "wiki" || route === "inbox") && !param);
  $main.innerHTML = view(param);
  $main.querySelectorAll("[data-partial]").forEach((box) => { box.indeterminate = true; });
  renderDock(route, param);
  if (hashChanged) window.scrollTo(0, state.scrollMemory[location.hash] ?? 0);
  lastHash = location.hash;
  if (route === "home") document.getElementById("chat-input")?.focus();
}

/* ---------- Floating assistant: page-aware questions ---------- */
function dockContext(route, param) {
  if (route === "study") return { key: "study", label: "学习区", suggestions: ["我有哪些文档没读完？", "Attention 这篇论文讲了什么？"] };
  if (route === "reader") return { key: `reader/${param}`, label: item(param)?.title, item: param, suggestions: ["这篇文章讲了什么？", "这一页的重点是什么？", "帮我解释 Scaled Dot-Product Attention"] };
  if (route === "item") return { key: `item/${param}`, label: item(param)?.title, item: param, suggestions: ["这篇讲了什么？", "它和我学过的哪些知识相关？"] };
  if (route === "inbox") return { key: "inbox", label: "收集箱", suggestions: ["哪些内容还没整理？", "最近收的内容里哪篇最值得读？"] };
  if (route === "progress") return { key: "progress", label: "学习进度", suggestions: ["我今天学了什么？", "这周比上周学得多吗？"] };
  if (route === "wiki" && param) {
    const contrast = D.graph.edges.find(([a, b, type]) => type === "contrasts" && (a === param || b === param));
    return { key: `wiki/${param}`, label: `词条 · ${param}`, entry: param, suggestions: ["这个知识点讲解是否完整？", `用一个例子解释「${param}」`, ...(contrast ? [`它和「${contrast[0] === param ? contrast[1] : contrast[0]}」有什么区别？`] : [])] };
  }
  if (route === "wiki") {
    const selected = state.graphSelected;
    const label = selected.startsWith("cat:") ? D.wiki.categories.find((category) => category.id === selected.slice(4))?.name : selected;
    return { key: "wiki", label: `知识库 · ${label}`, selected, suggestions: [`「${label}」我掌握得怎么样？`, "这个分类还缺哪些知识？"] };
  }
  return null;
}

function renderDock(route, param) {
  let host = document.getElementById("dock");
  if (!host) { host = document.createElement("div"); host.id = "dock"; document.body.append(host); }
  const ctx = dockContext(route, param);
  state.dock.ctx = ctx;
  if (!ctx) { host.innerHTML = ""; return; }
  if (!state.dock.open) { host.innerHTML = `<button class="dock-fab" data-action="dock-open" title="问问" aria-label="问问">${icon("chat", 22)}</button>`; return; }
  const thread = state.chat;
  const suggestions = [...ctx.suggestions, ...(ctx.item || ctx.entry ? ["帮我整理该页知识点"] : ["帮我整理"])];
  host.innerHTML = `<div class="dock-panel">
    <div class="dock-head"><div class="grow" style="min-width:0"><div style="font-weight:600">✧ 问问 <span class="small faint" style="font-weight:400">与首页对话同步</span></div><div class="small muted dock-ctx">当前：${esc(ctx.label ?? "")}</div></div><button class="btn sm ghost" data-action="new-chat" title="开始新对话">新对话</button><button class="btn sm ghost" data-action="dock-close">✕</button></div>
    <div class="dock-list" id="dock-list">${thread.length ? thread.map((message) => chatMessage(message, ctx.label)).join("") : `
      <div class="small muted" style="padding:6px 2px">基于当前页面和你的知识库回答，试试：</div><div class="stack" style="gap:6px">${suggestions.map((text) => `<button class="chip dock-suggest" data-dock-ask="${esc(text)}">${esc(text)}</button>`).join("")}</div>`}</div>
    <div class="dock-input"><textarea id="dock-input" rows="1" placeholder="针对当前页面提问…"></textarea><button class="btn primary sm" data-action="dock-send">发送</button></div>
  </div>`;
  const list = document.getElementById("dock-list");
  list.scrollTop = list.scrollHeight;
}

function dockAsk(question) {
  if (state.dock.ctx) ask(question, state.dock.ctx);
}

function dockAnswer(question, ctx) {
  const doc = ctx.item && item(ctx.item);
  if (doc && /讲了什么|总结|概括/.test(question)) return {
    html: `<p>${esc(doc.summary ?? (doc.body ?? doc.answer).find(([kind]) => kind === "p")?.[1] ?? "")}</p>
      ${doc.points ? `<ul>${doc.points.map((point) => `<li>${esc(point)}</li>`).join("")}</ul>` : ""}
      ${doc.concepts.length ? `<p>涉及知识点：</p><div class="chips">${doc.concepts.map(conceptChip).join("")}</div>` : ""}
      ${doc.pages ? `<p style="margin-top:8px">你已读到第 ${doc.readPages}/${doc.pages} 页，累计 ${fmtDuration(doc.reading.total)}。</p>` : ""}`,
    basis: `依据：${doc.organized ? "AI 整理摘要" : "正文"} · ${esc(doc.title)}`
  };
  if (doc && /这一页|本页/.test(question)) return {
    html: `<p>第 ${state.docPage} 页介绍 <b>Scaled Dot-Product Attention</b>：用查询与键的点积衡量相关性，除以 √dₖ 后做 softmax，再对值加权求和。</p><p>你在这页的高亮和备注正是「为什么要除以 √dₖ」——防止点积过大导致 softmax 梯度消失。</p>`,
    basis: `依据：当前页正文 · 你的高亮与备注`
  };
  if (doc && /解释/.test(question)) return {
    html: `<p>可以把它理解为「按相关性加权的查表」：每个词拿自己的查询向量 Q 去和所有词的键向量 K 算相似度，得到权重，再用权重把对应的值向量 V 加起来。</p><p>除以 √dₖ 是因为维度越大点积越大，softmax 会变得极端、梯度接近 0。</p><div class="chips">${conceptChip("注意力机制")}${conceptChip("Transformer")}</div>`,
    basis: "依据：词条「注意力机制」· 当前文档"
  };
  if (doc && /相关/.test(question)) return {
    html: `<p>这篇内容关联到你知识库中的：</p><div class="chips">${doc.concepts.map(conceptChip).join("") || "<span class='small faint'>还没整理，整理后会关联知识点</span>"}</div>`,
    basis: "依据：知识库关联关系"
  };
  if (ctx.entry && /完整/.test(question)) {
    const check = D.wiki.completeness[ctx.entry] ?? { covered: (D.wiki.content[ctx.entry] ?? []).filter(([kind]) => kind === "h").map(([, text]) => text), missing: ["具体应用示例", "常见误区与注意事项"] };
    const count = sourcesOf(ctx.entry).length;
    return {
      html: `<p>「${ctx.entry}」目前覆盖了：</p><ul>${(check.covered.length ? check.covered : ["定义"]).map((text) => `<li>✓ ${esc(text)}</li>`).join("")}</ul>
        <p>还缺少：</p><ul>${check.missing.map((text) => `<li>✗ ${esc(text)}</li>`).join("")}</ul>
        ${count < 2 ? `<p>另外，这个词条只有 ${count} 条来源，观点可能不够全面。</p>` : ""}
        <div class="row" style="margin-top:8px"><button class="btn sm" data-organize-scope="entry" data-organize-id="${esc(ctx.entry)}" data-organize-prefill="补全缺少的部分：${esc(check.missing.join("；"))}">让 AI 补全并标注来源</button></div>`,
      basis: `依据：词条正文 · ${count} 条来源`
    };
  }
  if (ctx.entry && /例子/.test(question)) return {
    html: ctx.entry === "交叉编码器"
      ? `<p>假设用户搜「苹果手机电池不耐用怎么办」，召回了 100 篇文档。双塔模型可能把「苹果种植技术」也排得较高，因为向量里「苹果」占比大；交叉编码器同时看到查询和文档的每个词，能识别「手机」「电池」的匹配，把真正相关的文章排到前面。</p>`
      : `<p>（原型）这里会结合你的学习记录，给出一个「${ctx.entry}」的具体例子，并引用来源中的片段。</p>`,
    basis: `依据：词条「${ctx.entry}」· 模型补充示例`
  };
  if (ctx.entry && /区别/.test(question)) {
    const other = D.graph.edges.filter(([a, b, type]) => type === "contrasts" && (a === ctx.entry || b === ctx.entry)).map(([a, b]) => a === ctx.entry ? b : a)[0];
    return {
      html: `<p><b>${ctx.entry}</b>：${esc(graphNode(ctx.entry).desc)}</p><p><b>${other}</b>：${esc(graphNode(other).desc)}</p><p>一句话：双塔快、可离线，用于召回；交叉编码器准、不能离线，用于重排。</p>`,
      basis: `依据：词条「${ctx.entry}」「${other}」`
    };
  }
  if (ctx.selected && /掌握/.test(question)) {
    const ids = ctx.selected.startsWith("cat:") ? Object.keys(D.wiki.entries).filter((id) => D.wiki.entries[id].category === ctx.selected.slice(4) && graphNode(id)) : [ctx.selected];
    return {
      html: `<div class="chips">${ids.map(conceptChip).join("")}</div><p style="margin-top:8px">${ids.length > 1 ? `平均掌握 ${Math.round(ids.reduce((sum, id) => sum + graphNode(id).mastery, 0) / ids.length * 100)}%，` : ""}最需要补的是「${[...ids].sort((a, b) => graphNode(a).mastery - graphNode(b).mastery)[0]}」。</p>`,
      basis: "依据：知识点掌握度"
    };
  }
  if (/缺哪些/.test(question)) return {
    html: `<p>对照你学过的内容，这个方向还缺：</p><ul><li>文档切块策略</li><li>Prompt 拼接与引用溯源</li><li>效果评估（召回率、忠实度）</li></ul>`,
    basis: "依据：分类下词条与关联关系"
  };
  if (/没读完/.test(question)) {
    const docs = D.items.filter((entry) => entry.pages && entry.readPages < entry.pages);
    return { html: `<ul>${docs.map((entry) => `<li>${esc(entry.title)}：${entry.readPages}/${entry.pages} 页</li>`).join("")}</ul>`, basis: `依据：学习区阅读进度　${docs.map(sourceChip).join("")}` };
  }
  if (/没整理/.test(question)) {
    const list = D.items.filter((entry) => !entry.organized);
    return { html: `<p>${list.length} 条还没整理：</p><div class="stack" style="gap:4px">${list.map(sourceChip).join("")}</div><div class="row" style="margin-top:8px"><button class="btn sm" data-organize-scope="batch">✦ 整理全部</button></div>`, basis: "依据：收集箱状态" };
  }
  if (/值得读/.test(question)) return {
    html: `<p>推荐先读 <b>从零实现 HNSW</b>：它对应你最薄弱的知识点「HNSW」（20%），而且还没读完。</p>`,
    basis: `依据：未读内容 × 知识点掌握度　${sourceChip(item("p1"))}`
  };
  if (/上周/.test(question)) return { html: `<p>本周学习 <b>8h 1m</b>，上周 6h 20m，多了 1h 41m（+27%）。周三学得最多（2h 10m）。</p>`, basis: "依据：近 14 天学习时长" };
  return answer(question);
}

/* ---------- Interactions ---------- */
document.addEventListener("click", (event) => {
  const target = event.target;
  const data = (name) => target.closest(`[data-${name}]`)?.dataset[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())];

  document.querySelectorAll("details.more-menu[open]").forEach((menu) => { if (!menu.contains(target) || target.closest(".menu-pop")) menu.open = false; });
  if (state.dock.open && target.isConnected && !target.closest("#dock, .modal-mask")) {
    state.dock.open = false;
    renderDock(...currentRoute());
  }
  if (target.matches("[data-select-all]")) {
    const ids = inboxPage().rows.map((row) => row.key);
    const all = state.selectAllKey === inboxFilterKey() && ids.every((itemId) => state.selected.has(itemId));
    ids.forEach((itemId) => all ? state.selected.delete(itemId) : state.selected.add(itemId));
    state.selectAllKey = all ? null : inboxFilterKey();
    return render();
  }
  if (target.matches("[data-check-node]")) {
    const nodeId = target.dataset.checkNode;
    state.wikiChecked.has(nodeId) ? state.wikiChecked.delete(nodeId) : state.wikiChecked.add(nodeId);
    return render();
  }
  if (target.matches("[data-check-cat]")) {
    const inCategory = Object.keys(D.wiki.entries).filter((entryId) => graphNode(entryId) && D.wiki.entries[entryId].category === target.dataset.checkCat);
    const all = inCategory.every((entryId) => state.wikiChecked.has(entryId));
    inCategory.forEach((entryId) => all ? state.wikiChecked.delete(entryId) : state.wikiChecked.add(entryId));
    return render();
  }
  if (target.matches("[data-select]")) {
    event.stopPropagation();
    const id = target.dataset.select;
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    return render();
  }
  if (data("open") && !target.closest("a, button, input, label")) return void (location.hash = `#/item/${data("open")}`);
  if (data("reader")) return void (location.hash = `#/reader/${data("reader")}`);
  if (data("inbox-tab")) { state.inboxTab = data("inbox-tab"); state.inboxPage = 1; return render(); }
  if (data("inbox-status")) { state.inboxStatus = data("inbox-status"); state.inboxPage = 1; return render(); }
  if (data("collapse-day")) { const key = data("collapse-day"); state.collapsedDays.has(key) ? state.collapsedDays.delete(key) : state.collapsedDays.add(key); return render(); }
  if (data("inbox-page")) { state.inboxPage = Number(data("inbox-page")); return render(); }
  if (data("tl-type")) {
    const type = data("tl-type");
    if (type === "all") state.timelineTypes.clear();
    else state.timelineTypes.has(type) ? state.timelineTypes.delete(type) : state.timelineTypes.add(type);
    return render();
  }
  if (data("ask")) return ask(data("ask"));
  if (data("delete-node")) return deleteKnowledge(data("delete-node"));
  if (data("delete-fuzzy")) return deleteFuzzyNote(data("delete-fuzzy"));
  if (data("organize-scope")) {
    if (state.organizing) return toast(`正在整理（${state.organizing.done}/${state.organizing.total}），完成后再试`);
    const trigger = target.closest("[data-organize-scope]").dataset;
    return organizeModal(trigger.organizeScope, trigger.organizeId, trigger.organizePrefill, trigger.organizeRanges);
  }
  if (data("dock-ask")) return dockAsk(data("dock-ask"));
  if (data("wiki-cat")) { state.graphSelected = `cat:${data("wiki-cat")}`; return; }
  if (data("toggle-cat")) { const key = data("toggle-cat"); state.treeCollapsed.has(key) ? state.treeCollapsed.delete(key) : state.treeCollapsed.add(key); return render(); }
  if (data("tree-open") && !target.closest("button, input, label")) return void (location.hash = wikiHref(data("tree-open")));
  if (data("node") && !target.closest("a")) { state.graphSelected = data("node"); return render(); }
  if (data("graph-focus")) { state.graphSelected = data("graph-focus"); return; }
  if (data("relation")) { state.graphRelation = data("relation"); return render(); }
  if (data("provider") && !target.closest(".provider-form")) { state.provider = state.provider === data("provider") ? null : data("provider"); return render(); }
  if (data("preset")) {
    state.preset = data("preset");
    state.threshold = state.preset === "dev" ? { minActiveSeconds: 5, minScrollDepth: 0, minRevisitSeconds: 3 } : { minActiveSeconds: 90, minScrollDepth: 35, minRevisitSeconds: 60 };
    toast(state.preset === "dev" ? "已切换为调试门槛，扩展将在几秒内同步" : "已切换为正式门槛");
    return render();
  }
  if (data("platform")) { const key = data("platform"); state.platforms[key] = !state.platforms[key]; return render(); }
  if (data("organize")) { const key = data("organize"); D.organize[key].on = !D.organize[key].on; return render(); }
  if (data("restore")) return restoreFromTrash(Number(data("restore")));
  if (data("purge")) { D.trash.splice(Number(data("purge")), 1); toast("已彻底删除，原始文件与整理结果均已清除"); return render(); }
  if (data("page")) { state.docPage = Math.max(1, state.docPage + Number(data("page"))); return render(); }
  if (data("goto")) { state.docPage = Number(data("goto")); return render(); }
  if (data("remove-rule")) { D.rules.splice(Number(data("remove-rule")), 1); toast("规则已删除"); return render(); }
  if (data("role-chip")) { D.profile.role = data("role-chip"); return refreshProfile(`角色已设为「${D.profile.role}」`); }
  if (data("remove-focus")) { const [removed] = D.profile.focus.splice(Number(data("remove-focus")), 1); return refreshProfile(`已移除「${removed.topic}」`); }
  if (data("renew-focus")) { const entry = D.profile.focus[Number(data("renew-focus"))]; entry.expires = expiryOf(30); return refreshProfile(`「${entry.topic}」已续期到 ${entry.expires}`); }

  const action = data("action");
  if (!action) return;
  if (target.closest("a[href='#']")) event.preventDefault();
  const id = target.closest("[data-id]")?.dataset.id;
  const noteBox = target.closest("[data-note-scope]");
  const noteScope = noteBox && { scope: noteBox.dataset.noteScope, id: noteBox.dataset.noteId };
  const noteIndex = Number(target.closest("[data-note]")?.dataset.note);
  const handlers = {
    "filter-unorganized": () => { state.inboxStatus = "unorganized"; },
    "open-profile": () => profileModal(),
    "profile-add-focus": () => {
      const input = document.getElementById("profile-focus-new");
      const topic = normalizeTopic(input.value.trim());
      if (!topic) return toast("先写一个学习方向");
      const days = Number(document.getElementById("profile-focus-days").value);
      refreshProfile(addFocus(topic, days) ? `已添加「${topic}」，${days} 天后到期` : `「${topic}」已在档案中`);
    },
    send: () => ask(document.getElementById("chat-input").value),
    "dock-open": () => { state.dock.open = true; render(); document.getElementById("dock-input")?.focus(); },
    "dock-close": () => { state.dock.open = false; render(); },
    "dock-send": () => dockAsk(document.getElementById("dock-input").value),
    "toggle-auto": () => { D.organize.auto = !D.organize.auto; toast(D.organize.auto ? "已开启自动整理" : "已关闭自动整理，仅手动触发"); render(); },
    "reset-mastery": () => { const node = graphNode(currentEntry()); node.mastery = node.autoMastery; node.masteryManual = false; toast("已恢复自动计算"); render(); },
    "add-note": () => {
      const text = document.getElementById("note-new").value.trim();
      if (!text) return toast("先写点内容");
      notesOf(noteScope.scope, noteScope.id).push({ text, from: "工作台添加 · 刚刚", used: false });
      toast("备注已添加，不会自动触发整理");
      render();
    },
    "edit-note": () => { state.editingNote = `${noteScope.scope}:${noteScope.id}:${noteIndex}`; render(); document.getElementById("note-edit")?.focus(); },
    "cancel-note": () => { state.editingNote = null; render(); },
    "save-note-edit": () => {
      const note = notesOf(noteScope.scope, noteScope.id)[noteIndex];
      const text = document.getElementById("note-edit").value.trim();
      if (text && text !== note.text) { note.text = text; note.from = `${note.from.split(" · ")[0]} · 已编辑`; note.used = false; }
      state.editingNote = null;
      render();
    },
    "delete-note": () => { notesOf(noteScope.scope, noteScope.id).splice(noteIndex, 1); toast("备注已删除"); render(); },
    "edit-item": () => { state.editingItem = id; render(); },
    "cancel-edit-item": () => { state.editingItem = null; render(); },
    "save-item": () => {
      const entry = item(state.editingItem);
      entry.title = document.getElementById("edit-title").value.trim() || entry.title;
      entry[entry.type === "conversation" ? "answer" : "body"] = fromText(document.getElementById("edit-body").value);
      entry.edited = true;
      state.editingItem = null;
      toast("已保存，不会自动触发整理");
      render();
    },
    "edit-entry": () => { state.editingEntry = currentEntry(); render(); },
    "cancel-edit-entry": () => { state.editingEntry = null; render(); },
    "save-entry": () => {
      const id = currentEntry();
      graphNode(id).desc = document.getElementById("edit-desc").value.trim() || graphNode(id).desc;
      D.wiki.content[id] = fromText(document.getElementById("edit-content").value);
      graphNode(id).userEdited = true;
      D.wiki.entries[id].edited = true;
      state.editingEntry = null;
      toast("已保存，不会自动触发整理");
      render();
    },
    "new-chat": () => { state.chat = []; render(); },
    "general-answer": () => toast("（原型）由模型直接回答，并标注「非学习记录」"),
    "add-provider": () => toast("（原型）选择服务商类型：OpenAI 兼容 / Anthropic / Ollama"),
    "retry-run": () => toast("已重新提交 1 条失败项（将先切块再整理）"),
    "batch-read": () => { selectedItems().forEach((entry) => { entry.status = "read"; }); state.selected.clear(); toast("已标记为已读"); render(); },
    "batch-delete": () => selectedItems().length ? confirmDelete(selectedItems().map((entry) => entry.id), selectedNotes()) : deleteNotes(selectedNotes()),
    "batch-clear": () => { state.selected.clear(); render(); },
    "delete-checked": () => deleteKnowledge([...state.wikiChecked]),
    "clear-checked": () => { state.wikiChecked.clear(); render(); },
    delete: () => confirmDelete([id]),
    "add-tag": () => toast("（原型）弹出标签选择器"),
    "save-note": () => toast("备注已保存，并写入时间线"),
    upload: () => toast("（原型）打开文件选择器"),
    "delete-node": () => deleteKnowledge(state.graphSelected),
    "save-provider": () => toast("已保存"),
    "test-provider": () => toast("连接成功 · 延迟 420ms"),
    "copy-token": () => toast("令牌已复制"),
    "reset-token": () => dangerConfirm("重置配对令牌？", "旧令牌立即失效，浏览器扩展需要重新填写新令牌才能继续采集。", "重置", () => toast("已生成新令牌，请在扩展中重新配对")),
    "wipe-data": () => dangerConfirm("清空所有数据？", "将删除全部收集内容、时间线、笔记和知识库，无法恢复。建议先导出备份。", "清空", () => toast("（原型）不会真的清空")),
    "add-rule": () => addRule(),
    reveal: () => toast("（原型）在访达中打开"),
    export: () => toast("正在导出 study-studio-2026-10-02.zip"),
    rebuild: () => toast("索引重建完成：128 条内容")
  };
  handlers[action]?.();
});

document.addEventListener("change", (event) => {
  if (event.target.id === "wiki-kind") { state.wikiKind = event.target.value; return render(); }
  if (event.target.id === "inbox-page-size") { state.inboxPageSize = Number(event.target.value); state.inboxPage = 1; return render(); }
  if (event.target.id === "profile-focus-new" || event.target.id === "profile-focus-days") return;
  if (event.target.id === "profile-role") { D.profile.role = event.target.value.trim(); return refreshProfile("角色已保存"); }
  if (event.target.dataset.task) {
    const task = D.tasks.find((entry) => entry.id === event.target.dataset.task);
    const provider = D.providers.find((entry) => entry.name === event.target.value);
    Object.assign(task, { provider: provider.name, model: provider.model });
    toast(`「${task.name}」改用 ${provider.name} · ${provider.model}`);
    return render();
  }
  if (event.target.closest(".settings-body")) toast("已保存 ✓");
  const id = event.target.dataset.mastery;
  if (!id) return;
  const node = graphNode(id);
  if (!node.masteryManual) node.autoMastery = node.mastery;
  node.mastery = Number(event.target.value) / 100;
  node.masteryManual = true;
  toast(`已将「${id}」的掌握程度设为 ${event.target.value}%`);
  render();
});

document.addEventListener("input", (event) => {
  if (event.target.dataset.mastery) {
    const value = Number(event.target.value) / 100;
    const label = document.getElementById("mastery-label");
    label.textContent = `${masteryLabel(value)} ${event.target.value}%`;
    label.style.color = masteryColor(value);
  }
  const key = event.target.dataset.range;
  if (key) {
    state.threshold[key] = Number(event.target.value);
    state.preset = "custom";
    event.target.nextElementSibling.textContent = `${event.target.value}${key === "minScrollDepth" ? "%" : " 秒"}`;
  }
  if (event.target.id === "wiki-search") {
    state.wikiQuery = event.target.value;
    render();
    const input = document.getElementById("wiki-search");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
});

document.addEventListener("keydown", (event) => {
  const mask = [...document.querySelectorAll(".modal-mask")].at(-1);
  if (event.key === "Escape") {
    if (mask) return mask.remove();
    document.querySelectorAll("details.more-menu[open]").forEach((menu) => { menu.open = false; });
    if (state.dock.open) { state.dock.open = false; renderDock(...currentRoute()); }
    return;
  }
  if (mask && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    return mask.querySelector(".btn.primary")?.click();
  }
  if (event.target.id === "dock-input" && event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); dockAsk(event.target.value); }
  if (event.target.id === "profile-focus-new" && event.key === "Enter" && !event.isComposing) { event.preventDefault(); document.querySelector("[data-action='profile-add-focus']")?.click(); }
  if (event.target.id === "chat-input" && event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); ask(event.target.value); }
});

/* ---------- Delete flows: impact preview, inbox trash, knowledge deletion ---------- */
/** What removing these items does to the knowledge base, derived from each node's source items. */
function kbImpact(ids) {
  const removed = ids.map(item);
  const summaries = removed.filter((entry) => entry.organized).length;
  const concepts = [...new Set(removed.flatMap((entry) => entry.concepts))].filter((id) => D.graph.nodes.some((node) => node.id === id));
  const others = (concept) => D.items.filter((entry) => !ids.includes(entry.id) && entry.concepts.includes(concept));
  const orphaned = concepts.filter((concept) => others(concept).length === 0);
  const deleteNodes = orphaned.filter((concept) => !D.graph.nodes.find((node) => node.id === concept).userEdited);
  const protectedNodes = orphaned.filter((concept) => !deleteNodes.includes(concept));
  const staleNodes = concepts.filter((concept) => others(concept).length > 0);
  const deleteEdges = D.graph.edges.filter(([a, b]) => deleteNodes.includes(a) || deleteNodes.includes(b));
  return { summaries, deleteNodes, protectedNodes, staleNodes, deleteEdges };
}

function confirmDelete(ids, notes = []) {
  const entry = item(ids[0]);
  let host = "";
  try { host = new URL(entry.url).host; } catch { host = ""; }
  const impact = kbImpact(ids);
  const hasKb = impact.summaries || impact.deleteNodes.length || impact.staleNodes.length || impact.protectedNodes.length;
  const line = (icon, text) => `<div class="row" style="align-items:flex-start"><span>${icon}</span><span>${text}</span></div>`;
  const preview = hasKb ? `
    <div class="card" style="padding:12px;background:var(--bg);box-shadow:none" id="kb-preview">
      <label class="row" style="font-weight:600;margin-bottom:8px"><input type="checkbox" id="kb-remove" checked> 同时从知识库移除</label>
      <div class="stack small" style="gap:6px">
        ${impact.summaries ? line(icon("trash", 14), `删除 ${impact.summaries} 份摘要`) : ""}
        ${impact.deleteNodes.length ? line(icon("trash", 14), `删除知识点 <b>${impact.deleteNodes.join("、")}</b>（没有其他来源）及 ${impact.deleteEdges.length} 条关系`) : ""}
        ${impact.staleNodes.length ? line("↻", `<b>${impact.staleNodes.join("、")}</b> 移除这条来源，描述将在下次整理时用剩余来源重新生成`) : ""}
        ${impact.protectedNodes.length ? line("✎", `<b>${impact.protectedNodes.join("、")}</b> 你手动编辑过，保留并标记为「无来源」，由你决定是否删除`) : ""}
      </div>
    </div>` : `<div class="small faint">这条内容还没整理，知识库不受影响。</div>`;
  const mask = modal(`
    <h3>删除 ${ids.length > 1 ? `${ids.length} 条内容` : `「${esc(entry.title)}」`}${notes.length ? ` 和 ${notes.length} 条模糊备注` : ""}</h3>
    ${preview}
    <div class="muted small">以后是否还收集这类页面？</div>
    <div class="stack" style="gap:8px">
      <label class="radio-row active"><input type="radio" name="rule" checked> <div><div>仅删除</div><div class="small muted">下次达到学习条件仍会收集</div></div></label>
      ${host ? `<label class="radio-row"><input type="radio" name="rule"> <div><div>删除并不再收集此页面</div><div class="small muted code" style="margin-top:4px">${esc(entry.url)}</div></div></label>
      <label class="radio-row"><input type="radio" name="rule"> <div><div>删除并不再收集该网站</div><div class="small muted code" style="margin-top:4px">${esc(host)}</div></div></label>` : ""}
    </div>
    <div class="small faint">删除的内容进入回收站，30 天内可撤销（含知识库变更）。</div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>取消</button><button class="btn primary danger-fill" id="confirm-delete">删除</button></div>`);
  const rows = [...mask.querySelectorAll(".radio-row")];
  rows.forEach((row) => row.addEventListener("click", () => rows.forEach((other) => other.classList.toggle("active", other === row))));
  mask.querySelector("#confirm-delete").addEventListener("click", () => {
    const ruleIndex = rows.findIndex((row) => row.classList.contains("active"));
    const removeFromKB = mask.querySelector("#kb-remove")?.checked ?? false;
    let removedNodes = [];
    let removedEdges = [];
    if (removeFromKB) {
      removedNodes = D.graph.nodes.filter((node) => impact.deleteNodes.includes(node.id));
      removedEdges = impact.deleteEdges;
      D.graph.nodes = D.graph.nodes.filter((node) => !impact.deleteNodes.includes(node.id));
      D.graph.edges = D.graph.edges.filter((edge) => !removedEdges.includes(edge));
      D.graph.nodes.forEach((node) => {
        if (impact.staleNodes.includes(node.id)) node.stale = true;
        if (impact.protectedNodes.includes(node.id)) node.orphan = true;
      });
      if (!D.graph.nodes.some((node) => node.id === state.graphSelected)) state.graphSelected = D.graph.nodes[0].id;
    }
    ids.forEach((id, index) => D.trash.unshift({ item: item(id), deletedAt: "刚刚", removeFromKB, removedNodes: index === 0 ? removedNodes : [], removedEdges: index === 0 ? removedEdges : [] }));
    D.items = D.items.filter((candidate) => !ids.includes(candidate.id));
    removeNotes(notes);
    if (ruleIndex === 1) D.rules.push({ kind: "URL", value: entry.url, note: "从收集箱删除时添加" });
    if (ruleIndex === 2) D.rules.push({ kind: "域名", value: host, note: "从收集箱删除时添加" });
    state.selected.clear();
    mask.remove();
    toast(`已移到回收站${removeFromKB ? "，知识库已同步" : ""}${ruleIndex > 0 ? "，并添加排除规则" : ""}`);
    location.hash = "#/inbox";
    render();
  });
}

/** Deleting knowledge never touches source items; children of a deleted node move up to its nearest surviving ancestor. */
function deleteKnowledge(idOrIds) {
  const ids = [idOrIds].flat().filter(graphNode);
  if (!ids.length) return;
  const removing = new Set(ids);
  const survivingParent = (id) => { let parent = parentOf(id); while (parent && removing.has(parent)) parent = parentOf(parent); return parent; };
  const moves = ids.flatMap((id) => D.graph.edges.filter(([child, b, type]) => b === id && type === "part_of" && !removing.has(child)).map(([child]) => [child, survivingParent(id)]));
  const edgeCount = D.graph.edges.filter(([a, b]) => removing.has(a) || removing.has(b)).length;
  const sourceCount = new Set(ids.flatMap((id) => sourcesOf(id).map((entry) => entry.id))).size;
  const name = ids.length === 1 ? `知识点「${esc(ids[0])}」` : ` ${ids.length} 个知识点`;
  const mask = modal(`
    <h3>删除${name}</h3>
    ${ids.length > 1 ? `<div class="chips">${ids.map((id) => `<span class="chip">${esc(id)}</span>`).join("")}</div>` : ""}
    <div class="stack small" style="gap:6px">
      <div class="row" style="align-items:flex-start"><span>${icon("trash", 14)}</span><span>删除词条正文、笔记与 ${edgeCount} 条关系</span></div>
      ${moves.length ? `<div class="row" style="align-items:flex-start"><span>↑</span><span>${moves.map(([child, parent]) => `<b>${esc(child)}</b> 移到${parent ? `「${esc(parent)}」下` : "分类根目录"}`).join("；")}</span></div>` : ""}
      <div class="row" style="align-items:flex-start"><span>✓</span><span>${sourceCount} 条来源学习记录保留在收集箱，不受影响</span></div>
    </div>
    <label class="row small"><input type="checkbox" id="kb-ignore" checked> 以后整理时不再自动生成${ids.length > 1 ? "这些" : "这个"}知识点</label>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>取消</button><button class="btn primary danger-fill" id="confirm-kb-delete">删除</button></div>`);
  mask.querySelector("#confirm-kb-delete").addEventListener("click", () => {
    const fallback = survivingParent(ids[0]);
    D.graph.nodes = D.graph.nodes.filter((candidate) => !removing.has(candidate.id));
    D.graph.edges = D.graph.edges.filter(([a, b]) => !removing.has(a) && !removing.has(b));
    moves.forEach(([child, parent]) => { if (parent) D.graph.edges.push([child, parent, "part_of"]); });
    ids.forEach((id) => { delete D.wiki.entries[id]; state.wikiChecked.delete(id); });
    D.items.forEach((entry) => { entry.concepts = entry.concepts.filter((concept) => !removing.has(concept)); });
    if (removing.has(state.graphSelected)) state.graphSelected = fallback ?? `cat:${D.wiki.categories[0].id}`;
    mask.remove();
    toast(`已删除${ids.length === 1 ? `「${ids[0]}」` : ` ${ids.length} 个知识点`}${mask.querySelector("#kb-ignore").checked ? "，并加入整理忽略列表" : ""}`);
    if (location.hash.startsWith("#/wiki/")) location.hash = "#/wiki";
    else render();
  });
}

function restoreFromTrash(index) {
  const [entry] = D.trash.splice(index, 1);
  D.items.unshift(entry.item);
  D.graph.nodes.push(...entry.removedNodes);
  D.graph.edges.push(...entry.removedEdges);
  D.graph.nodes.forEach((node) => {
    if (entry.item.concepts.includes(node.id)) { node.stale = false; node.orphan = false; }
  });
  toast(entry.removeFromKB ? "已恢复，知识库中的对应知识点一并恢复" : "已恢复");
  render();
}

function addRule() {
  const mask = modal(`
    <h3>添加排除规则</h3>
    <label class="field">类型<select class="input" id="rule-kind"><option>域名</option><option>URL 前缀</option><option>列表页规则</option></select></label>
    <label class="field">规则<input class="input" id="rule-value" placeholder="例如 news.example.com 或 /tag/*"></label>
    <label class="field">说明<input class="input" id="rule-note" placeholder="可选"></label>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>取消</button><button class="btn primary" id="rule-save">添加</button></div>`);
  mask.querySelector("#rule-save").addEventListener("click", () => {
    const value = mask.querySelector("#rule-value").value.trim();
    if (!value) return toast("请填写规则");
    D.rules.push({ kind: mask.querySelector("#rule-kind").value, value, note: mask.querySelector("#rule-note").value || "手动添加" });
    mask.remove();
    toast("规则已添加，扩展将自动同步");
    render();
  });
}

/* ---------- Organize flows: requirement modal, progress, mock result ---------- */
const REQUIREMENT_CHIPS = ["上次整理的不对，请重新理解", "重点突出原理和适用场景", "多举具体例子", "更简洁，只保留核心", "和相关知识点做对比"];

/**
 * Every manual organize asks for an optional requirement, stored as a note of the matching kind before running.
 * Scopes: item / entry (one page), selected (inbox selection), entries (checked knowledge points), batch (pending), all (full rebuild).
 * `ranges` lists the scopes offered as options; the first available one is preselected.
 */
function organizeModal(scope, id, prefill = "", ranges = "") {
  const pending = () => D.items.filter((entry) => !entry.organized);
  const batchOf = (kind) => kind === "selected" ? (selectedItems().length ? selectedItems() : pending()) : kind === "all" ? [...D.items] : kind === "batch" ? D.items.filter((entry) => !entry.organized) : [];
  const entriesOf = (kind) => kind === "entries" ? [...state.wikiChecked].filter(graphNode) : [];
  const options = (ranges ? ranges.split(",") : scope === "batch" || scope === "all" ? ["batch", "all"] : [])
    .filter((kind) => kind === "selected" ? state.selected.size : kind === "entries" ? entriesOf("entries").length : true);
  let range = options.length && !options.includes(scope) ? options[0] : scope;
  const titleOf = (kind) => ({
    item: `整理「${esc(item(id)?.title ?? "")}」`,
    entry: `重新整理知识点「${esc(id)}」`,
    batch: `批量整理 ${batchOf("batch").length} 条待整理内容`,
    all: `全量重新整理 ${batchOf("all").length} 条内容`,
    selected: selectedItems().length ? `整理已选的 ${selectedItems().length} 条内容` : `按已选备注整理 ${batchOf("selected").length} 条待整理内容`,
    entries: `重新整理已选的 ${entriesOf("entries").length} 个知识点`
  }[kind]);
  const optionLabel = { selected: ["刚才已选的", `${state.selected.size} 项`], entries: ["已选知识点", `${state.wikiChecked.size} 个`], batch: ["待整理", `${batchOf("batch").length} 条`], all: ["全量", `${D.items.length} 条`] };
  const hintOf = (kind) => ({
    selected: `已选：${[...selectedItems().map((entry) => esc(entry.title)), ...selectedNotes().map((note) => `备注「${esc(noteText(note.event))}」`)].slice(0, 3).join("、")}${state.selected.size > 3 ? ` 等 ${state.selected.size} 项` : ""}`,
    entries: `已选：${entriesOf("entries").slice(0, 5).join("、")}${state.wikiChecked.size > 5 ? ` 等 ${state.wikiChecked.size} 个` : ""}`,
    batch: "只整理还没整理过的内容",
    all: "重新整理全部内容并重建知识库关系，耗时和 token 较多；手动编辑过的知识点只补充不覆盖"
  }[kind]);
  const fuzzy = fuzzyNotes().length;
  const signalsOf = (kind) => {
    if (kind === "item" || kind === "entry") {
      const notes = notesOf(kind, id);
      const edited = kind === "item" ? item(id).edited : D.wiki.entries[id].edited;
      return `本次会使用 ${notes.length} 条${kind === "item" ? "收集点" : "知识点"}备注${notes.some((note) => !note.used) ? `（其中 ${notes.filter((note) => !note.used).length} 条是新加的）` : ""}${edited ? "，以及你编辑后的内容" : ""}${kind === "entry" && graphNode(id).userEdited ? "。你手动编辑过的内容会保留，只补充不覆盖" : ""}`;
    }
    if (kind === "entries") return `本次会使用所选知识点各自的知识点备注和来源内容，手动编辑过的内容只补充不覆盖`;
    if (kind === "selected" && selectedNotes().length) return `本次会重点参考已选的 ${selectedNotes().length} 条模糊备注，以及每条内容各自的收集点备注`;
    return `本次会参考时间线上的 ${fuzzy} 条模糊备注，以及每条内容各自的收集点备注`;
  };
  const targetOf = (kind) => ({ item: "这条内容的「收集点备注」", entry: "这个知识点的「知识点备注」", entries: "所选每个知识点的「知识点备注」" }[kind] ?? "时间线上的「模糊备注」，整理时按语义匹配到相关内容");
  const rangeOptions = options.length > 1 ? `<div class="field">整理范围<div class="segmented">
      ${options.map((kind) => `<label><input type="radio" name="org-range" value="${kind}" ${kind === range ? "checked" : ""}> ${optionLabel[kind][0]} <span class="faint">${optionLabel[kind][1]}</span></label>`).join("")}</div>
      <div class="small faint" id="org-range-hint">${hintOf(range)}</div></div>` : "";
  const mask = modal(`
    <h3 id="org-title">${titleOf(range)}</h3>
    ${rangeOptions}
    <div class="small muted" style="line-height:1.7" id="org-signals">${signalsOf(range)}。</div>
    <label class="field">整理要求（可选）<textarea class="input" id="org-req" rows="4" placeholder="例如：上次整理的不对，重点突出它和双塔模型的区别，多举例子">${esc(prefill)}</textarea></label>
    <div class="chips">${REQUIREMENT_CHIPS.map((text) => `<button class="chip" data-req="${text}">${text}</button>`).join("")}</div>
    <div class="small faint" style="line-height:1.6">填写的要求会保存为<span id="org-target">${targetOf(range)}</span>，作为本次及以后整理的意图信号。</div>
    <div class="row" style="justify-content:flex-end"><span class="kbd-hint">⌘ Enter 开始 · Esc 取消</span><button class="btn" data-close>取消</button><button class="btn primary" id="org-confirm">开始整理</button></div>`);
  const input = mask.querySelector("#org-req");
  input.focus();
  mask.querySelectorAll("[data-req]").forEach((chip) => chip.addEventListener("click", () => {
    input.value = input.value ? `${input.value}；${chip.dataset.req}` : chip.dataset.req;
    input.focus();
  }));
  mask.querySelectorAll("[name=org-range]").forEach((radio) => radio.addEventListener("change", () => {
    range = radio.value;
    mask.querySelector("#org-title").innerHTML = titleOf(range);
    mask.querySelector("#org-range-hint").innerHTML = hintOf(range);
    mask.querySelector("#org-signals").innerHTML = `${signalsOf(range)}。`;
    mask.querySelector("#org-target").innerHTML = targetOf(range);
  }));
  mask.querySelector("#org-confirm").addEventListener("click", () => {
    const text = input.value.trim();
    const batch = range === "entries" ? entriesOf(range) : batchOf(range);
    if (text) {
      const note = () => ({ text, from: "整理要求 · 刚刚", used: false });
      if (range === "item" || range === "entry") notesOf(range, id).push(note());
      else if (range === "entries") batch.forEach((entryId) => entryNotes(entryId).push(note()));
      else D.timeline[0].events.push({ time: "刚刚", type: "user_note", text: `备注 · ${text}`, source: range === "selected" ? `整理已选的 ${batch.length} 条` : range === "all" ? "全量整理要求" : "批量整理要求" });
    }
    mask.remove();
    runOrganize(range, id, batch, Boolean(text));
  });
}

/** Organizing takes time in reality: show progress in the sidebar and block new runs until it finishes. */
function runOrganize(scope, id, batch, withRequirement) {
  const total = scope === "item" || scope === "entry" ? 1 : Math.max(batch.length, 1);
  state.organizing = { done: 0, total };
  document.body.classList.add("is-organizing");
  renderNav(currentRoute()[0]);
  const timer = setInterval(() => {
    state.organizing.done += 1;
    if (state.organizing.done < total) return renderNav(currentRoute()[0]);
    clearInterval(timer);
    state.organizing = null;
    document.body.classList.remove("is-organizing");
    applyOrganize(scope, id, batch, withRequirement);
  }, total === 1 ? 900 : 380);
}

function applyOrganize(scope, id, batch, withRequirement) {
  const organizeItem = (entry) => {
    entry.organized = true;
    entry.summary ??= "（演示）AI 生成的摘要：概括核心观点，并结合你的备注突出重点。";
    entry.points ??= ["要点一", "要点二", "要点三"];
    itemNotes(entry).forEach((note) => { note.used = true; });
    entry.edited = false;
  };
  if (scope === "item") {
    const used = itemNotes(item(id)).length;
    organizeItem(item(id));
    toast(`整理完成${used ? `，使用了 ${used} 条收集点备注` : ""}${withRequirement ? "（含本次要求）" : ""}`);
  } else if (scope === "entry") {
    const notes = entryNotes(id);
    notes.forEach((note) => { note.used = true; });
    D.wiki.entries[id].edited = false;
    D.wiki.entries[id].updatedAt = "刚刚";
    graphNode(id).stale = false;
    toast(`「${id}」已重新整理，使用了 ${notes.length} 条知识点备注`);
  } else if (scope === "entries") {
    batch.forEach((entryId) => {
      entryNotes(entryId).forEach((note) => { note.used = true; });
      Object.assign(D.wiki.entries[entryId], { edited: false, updatedAt: "刚刚" });
      graphNode(entryId).stale = false;
    });
    state.wikiChecked.clear();
    toast(`已重新整理 ${batch.length} 个知识点${withRequirement ? "，整理要求已记入各知识点备注" : ""}`);
  } else {
    batch.forEach(organizeItem);
    if (scope === "all") Object.keys(D.wiki.entries).filter(graphNode).forEach((entryId) => {
      entryNotes(entryId).forEach((note) => { note.used = true; });
      D.wiki.entries[entryId].edited = false;
      graphNode(entryId).stale = false;
    });
    const manualPick = scope === "selected";
    const rejected = manualPick ? 0 : Math.floor(batch.length / 3);
    D.runs.unshift({
      id: `r${D.runs.length + 1}`, at: "刚刚", trigger: `${scope === "all" ? "全量" : manualPick ? "手动 · 已选" : "手动"}${withRequirement ? " · 带要求" : ""}`, duration: "1 分 06 秒",
      items: batch.length, episodes: manualPick ? { learning: 0, notLearning: 0, deferred: 0 } : { learning: Math.max(1, Math.ceil(batch.length / 3)), notLearning: rejected ? 1 : 0, deferred: 0 },
      ingested: batch.length - rejected, rejected, failed: 0,
      decisions: { new: Math.ceil((batch.length - rejected) / 2), supplement: Math.floor((batch.length - rejected) / 2), duplicate: 0, reject: rejected ? rejected - 1 : 0, notLearning: rejected ? 1 : 0 },
      kb: "+2 知识点 · +3 关系 · 更新 1 个描述", tokens: 15800,
      ...(manualPick ? { skipped: "手动整理所选条目，跳过片段切分与学习判定" } : {}),
      steps: [...(manualPick ? [] : [["学习判定", 2, 1600]]), ["知识判定", 2, 4800], ["知识抽取", batch.length, 7400], ["词条正文重写", 3, 2000]]
    });
    D.organize.pendingCount = D.items.filter((entry) => !entry.organized).length;
    D.organize.lastRun = "刚刚";
    state.selected.clear();
    toast(`已整理 ${batch.length} 条内容${withRequirement ? "，整理要求已记入时间线" : ""}`);
  }
  render();
}

/* ---------- Boot ---------- */
window.addEventListener("hashchange", render);
setInterval(() => {
  state.liveSeconds += 1;
  const timer = document.getElementById("live-timer");
  if (timer) timer.textContent = fmtDuration(state.liveSeconds);
}, 1000);

render();
