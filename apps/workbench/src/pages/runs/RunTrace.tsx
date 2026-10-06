import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { OrganizeDecision, OrganizeRunDetail, OrganizeStage, OrganizeTraceStep } from "@study-studio/shared";
import { api } from "@/api";
import { DECISION_TEXT, formatTokens, STAGE_LABEL } from "@/lib/kb";

const NODES: OrganizeStage[] = ["context", "episode", "learning_judge", "retrieve", "knowledge_processing", "integration", "entry_rewrite"];

const NODE_HINT: Partial<Record<OrganizeStage, string>> = {
  context: "加载待整理条目、行为日志窗口、学习者档案",
  episode: "按时间与跳转关系把行为切成活动片段（规则）",
  learning_judge: "只看行为判断是否在学习、在意哪些条目",
  retrieve: "检索相关已有词条，规则判掉重复 / 低信息",
  knowledge_processing: "抽取原文片段 → 对齐词条",
  integration: "写库：新建 / 补充词条、挂来源、建关系",
  entry_rewrite: "按全部来源重写词条正文"
};

const STEP_LABEL: Record<string, string> = {
  context: "上下文",
  episodes: "切分结果",
  learning_judge: "学习判定 · LLM",
  judge_cached: "学习判定 · 沿用缓存",
  judge_verdict: "判定结论",
  retrieve: "检索与预过滤",
  knowledge_extract: "知识抽取 · LLM",
  knowledge_align: "对齐词条 · LLM",
  processing_result: "知识处理结果",
  integration: "入库结果",
  skipped: "跳过",
  agent_submit: "Agent 提交",
  entry_rewrite: "词条重写 · LLM"
};

const EPISODE_STATUS: Record<string, [string, string]> = {
  ready: ["送学习判定", "blue"],
  open: ["进行中，推迟", ""],
  prefiltered: ["规则判为非学习", "orange"]
};

const VERDICT_ACTION: Record<string, [string, string]> = {
  proceed: ["进入后续处理", "green"],
  proceed_uncertain: ["进入后续（不确定，门槛从严）", "teal"],
  reject_episode: ["整段不采纳", "orange"]
};

const CHANGE_TEXT: Record<string, string> = { created: "新增", supplemented: "补充", duplicate: "挂来源", rewritten: "重写" };

// Trace payloads are free-form JSON written by the service; read fields loosely.
type Loose = Record<string, any>;

const time = (iso: string | undefined) => (iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "—");
const score = (value: unknown) => (typeof value === "number" ? value.toFixed(2) : "—");

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row small" style={{ alignItems: "flex-start" }}>
      <span className="muted" style={{ width: 72, flexShrink: 0 }}>
        {label}
      </span>
      <div className="grow">{children}</div>
    </div>
  );
}

function ItemChips({ ids, titleOf }: { ids: string[] | undefined; titleOf: (id: string) => string }) {
  if (!ids?.length) return <span className="faint">无</span>;
  return (
    <div className="chips">
      {ids.map((id) => (
        <Link key={id} to="/item/$itemId" params={{ itemId: id }} className="chip">
          {titleOf(id)}
        </Link>
      ))}
    </div>
  );
}

function StepSummary({ step, titleOf }: { step: OrganizeTraceStep; titleOf: (id: string) => string }) {
  const input = (step.input ?? {}) as Loose;
  const output = (step.output ?? {}) as Loose;
  if (output.error) return <div style={{ color: "var(--red)" }}>调用失败：{String(output.error)}</div>;
  switch (step.step) {
    case "context":
      return (
        <>
          <Field label="待整理">{input.anchor_item_ids?.length ?? 0} 条</Field>
          <Field label="行为窗口">
            {output.timeline_units ?? 0} 个行为单元 · {output.window_items?.length ?? 0} 个收集条目
          </Field>
          <Field label="档案">{output.learner_profile?.role || "未填写"}</Field>
          <Field label="近期主题">{output.recent_kb_topics?.join("、") || "无"}</Field>
        </>
      );
    case "episodes": {
      const episodes = Array.isArray(step.output) ? (step.output as Loose[]) : [];
      if (!episodes.length) return <div className="faint">没有切出片段</div>;
      return (
        <div className="stack" style={{ gap: 8 }}>
          {episodes.map((episode, index) => {
            const [label, tone] = EPISODE_STATUS[episode.status] ?? [episode.status, ""];
            return (
              <div key={episode.episode_id} className="trace-sub">
                <div className="row small wrap">
                  <b>片段 {index + 1}</b>
                  <span className="muted">
                    {time(episode.started_at)}–{time(episode.ended_at)} · 有效 {Math.round((episode.active_seconds ?? 0) / 60)} 分钟 · 行为{" "}
                    {episode.judge_input?.timeline?.length ?? 0} 条
                  </span>
                  <span className={`tag ${tone}`}>
                    {label}
                    {episode.prefilter_reason ? `（${episode.prefilter_reason}）` : ""}
                  </span>
                  {episode.flags?.length ? <span className="tag">{episode.flags.join(",")}</span> : null}
                  <span className="faint mono small">{episode.episode_id}</span>
                </div>
                <ItemChips ids={episode.anchor_item_ids} titleOf={titleOf} />
              </div>
            );
          })}
        </div>
      );
    }
    case "learning_judge":
    case "judge_cached":
      return (
        <>
          <Field label="结论">
            <span className={`tag ${output.is_learning ? "green" : "orange"}`}>{output.is_learning ? "学习" : "非学习"}</span> 置信度{" "}
            {score(output.confidence)} · {output.worth_extracting ? "值得抽取" : "不值得抽取"}
          </Field>
          <Field label="主题">{output.topic || "—"}</Field>
          <Field label="学习目标">{output.learning_goal || "—"}</Field>
          <Field label="理由">{output.reason || "—"}</Field>
          {output.segment_suggestion && output.segment_suggestion.action !== "keep" ? (
            <Field label="切分建议">
              {output.segment_suggestion.action} {output.segment_suggestion.at ?? ""}
            </Field>
          ) : null}
        </>
      );
    case "judge_verdict": {
      const [label, tone] = VERDICT_ACTION[output.action] ?? [output.action, ""];
      return (
        <>
          <Field label="处理">
            <span className={`tag ${tone}`}>{label}</span>
          </Field>
          <Field label="候选条目">
            <ItemChips ids={output.candidate_item_ids} titleOf={titleOf} />
          </Field>
          <Field label="未采纳">
            <ItemChips ids={output.rejected_item_ids} titleOf={titleOf} />
          </Field>
          {output.forced_item_ids?.length ? (
            <Field label="强制纳入">
              <ItemChips ids={output.forced_item_ids} titleOf={titleOf} />
            </Field>
          ) : null}
        </>
      );
    }
    case "retrieve": {
      const prefilter = (output.prefilter ?? {}) as Loose;
      return (
        <>
          <Field label="相关词条">
            {output.candidates?.length ? (
              <div className="chips">
                {(output.candidates as Loose[]).map((candidate) => (
                  <Link key={candidate.entry_id} to="/wiki/$entryId" params={{ entryId: candidate.entry_id }} className="chip">
                    {candidate.name} · {score(candidate.similarity)}
                  </Link>
                ))}
              </div>
            ) : (
              <span className="faint">无（知识库中没有相似词条）</span>
            )}
          </Field>
          <Field label="预过滤">
            {prefilter.route === "llm" ? (
              <span className="tag blue">未命中规则，进入知识处理</span>
            ) : (
              <span className="tag orange">
                命中 {prefilter.route} → {prefilter.decision === "duplicate" ? "重复" : "不入库"}
                {prefilter.reject_reason ? `（${prefilter.reject_reason}）` : ""}
              </span>
            )}
          </Field>
        </>
      );
    }
    case "knowledge_extract":
      return (
        <>
          {input.input?.feedback?.length ? <Field label="重试反馈">{input.input.feedback.join("；")}</Field> : null}
          <Field label="原文片段">
            {output.fragments?.length ? (
              <ol className="trace-list">
                {(output.fragments as Loose[]).map((fragment, index) => (
                  <li key={index}>
                    <b>{fragment.concept}</b> · {fragment.heading}
                    {fragment.summarized ? <span className="tag orange"> 摘要</span> : null}
                    {fragment.source_section ? <span className="muted"> ← {fragment.source_section}</span> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <span className="faint">未抽到</span>
            )}
          </Field>
          {output.removed?.length ? (
            <Field label="剔除">
              {(output.removed as Loose[]).map((removed) => `${removed.source_section ?? "（无标题）"}（${removed.reason === "instruction" ? "按备注" : "无关内容"}）`).join("、")}
            </Field>
          ) : null}
        </>
      );
    case "knowledge_align":
      return (
        <>
          {input.input?.feedback?.length ? <Field label="重试反馈">{input.input.feedback.join("；")}</Field> : null}
          <Field label="分配">
            <ol className="trace-list">
              {((output.assignments ?? []) as Loose[]).map((assignment, index) => {
                const entry = String(assignment.entry ?? "");
                const [label, tone] = entry.startsWith("new:") ? ["新建", "green"] : assignment.covered_by ? ["已覆盖", ""] : ["补充", "teal"];
                return (
                  <li key={index}>
                    <span className="muted">{assignment.fragment_id} → </span>
                    <span className={`tag ${tone}`}>{label}</span> <b>{entry.startsWith("new:") ? entry.slice(4) : entry}</b>
                    {assignment.covered_by ? <span className="muted"> · 章节 {assignment.covered_by}</span> : null}
                  </li>
                );
              })}
            </ol>
          </Field>
          {output.relations?.length ? (
            <Field label="关系">{(output.relations as Loose[]).map((relation) => `${relation.from} —${relation.type}→ ${relation.to}`).join("；")}</Field>
          ) : null}
        </>
      );
    case "processing_result": {
      const result = (output.output ?? {}) as Loose;
      const missing = (input.raw?.missing_sections ?? input.raw?.missing_after_retry ?? []) as string[];
      return (
        <>
          <Field label="决定">
            <span className="tag">{DECISION_TEXT[result.decision as OrganizeDecision] ?? result.decision}</span>
            {result.reject_reason ? ` · ${result.reject_reason}` : ""}
          </Field>
          {result.fragments ? <Field label="原文片段">{result.fragments.length} 个</Field> : null}
          {result.new_entries?.length ? <Field label="新词条">{result.new_entries.map((entry: Loose) => entry.name).join("、")}</Field> : null}
          {missing.length ? <Field label="仍遗漏">{missing.join(", ")}</Field> : null}
        </>
      );
    }
    case "integration":
      return (
        <>
          <Field label="结果">
            <span className={`tag ${output.status === "ingested" ? "green" : "orange"}`}>{output.status === "ingested" ? "已入库" : "未采纳"}</span>{" "}
            {DECISION_TEXT[input.decision as OrganizeDecision] ?? input.decision}
            {input.reject_reason ? `（${input.reject_reason}）` : ""}
          </Field>
          {output.entry_changes?.length ? (
            <Field label="词条变化">
              <div className="chips">
                {(output.entry_changes as Loose[]).map((change) => (
                  <Link key={`${change.entryId}-${change.change}`} to="/wiki/$entryId" params={{ entryId: change.entryId }} className="chip">
                    {CHANGE_TEXT[change.change] ?? change.change} {change.name}
                  </Link>
                ))}
              </div>
            </Field>
          ) : null}
          {output.edges_created ? <Field label="新关系">{output.edges_created} 条</Field> : null}
        </>
      );
    case "skipped":
      return <div className="muted small">{output.reason}</div>;
    case "agent_submit":
      return <Field label="决定">{input.decision}</Field>;
    case "entry_rewrite":
      return (
        <>
          <Field label="摘要">{output.summary || "—"}</Field>
          <Field label="覆盖">
            {output.covered_ids?.length ?? 0} 条来源写入正文，舍弃 {output.dropped?.length ?? 0} 条
          </Field>
        </>
      );
    default:
      return null;
  }
}

function TraceStepView({ step, titleOf }: { step: OrganizeTraceStep; titleOf: (id: string) => string }) {
  return (
    <div className="trace-step">
      <div className="row small wrap">
        <span className="faint mono">#{step.seq}</span>
        <b>{STEP_LABEL[step.step] ?? step.step}</b>
        {step.itemIds.length === 1 ? <span className="muted">{titleOf(step.itemIds[0]!)}</span> : null}
        {step.itemIds.length > 1 ? <span className="muted">{step.itemIds.length} 个条目</span> : null}
        {step.entryId ? (
          <Link to="/wiki/$entryId" params={{ entryId: step.entryId }}>
            {step.entryId}
          </Link>
        ) : null}
        <div className="grow" />
        {step.model ? <span className="faint">{step.model}</span> : null}
        {step.inputTokens + step.outputTokens ? (
          <span className="faint">
            输入 {formatTokens(step.inputTokens)} · 输出 {formatTokens(step.outputTokens)}
          </span>
        ) : null}
      </div>
      <div className="stack" style={{ gap: 4, marginTop: 6 }}>
        <StepSummary step={step} titleOf={titleOf} />
      </div>
      <details className="trace-json">
        <summary className="small muted">输入 JSON</summary>
        <pre className="code">{JSON.stringify(step.input, null, 2)}</pre>
      </details>
      <details className="trace-json">
        <summary className="small muted">输出 JSON</summary>
        <pre className="code">{JSON.stringify(step.output, null, 2)}</pre>
      </details>
    </div>
  );
}

export function RunTrace({ run, live }: { run: OrganizeRunDetail; live: boolean }) {
  const trace = useQuery({
    queryKey: ["organize-run-trace", run.id],
    queryFn: () => api.getOrganizeRunTrace(run.id),
    refetchInterval: live ? 2000 : false
  });
  const [picked, setPicked] = useState<OrganizeStage | null>(null);
  const [itemId, setItemId] = useState("");
  const steps = trace.data?.steps ?? [];
  const titles = new Map(run.items.map((item) => [item.itemId, item.title]));
  const titleOf = (id: string) => titles.get(id) ?? id;
  const byStage = (stage: OrganizeStage) => steps.filter((step) => step.stage === stage);
  const stage = picked ?? NODES.find((node) => byStage(node).length > 0) ?? null;
  const visible = stage ? byStage(stage).filter((step) => !itemId || step.itemIds.includes(itemId)) : [];

  return (
    <div className="card">
      <div className="card-title">
        流水线<span className="more muted">{steps.length} 条记录</span>
      </div>
      {trace.isLoading ? (
        <div className="small faint">加载中…</div>
      ) : steps.length === 0 ? (
        <div className="small faint">本次整理没有流水线记录（该功能上线前的整理不含追踪数据）</div>
      ) : (
        <>
          <div className="trace-pipeline">
            {NODES.map((node) => {
              const nodeSteps = byStage(node);
              const tokens = nodeSteps.reduce((sum, step) => sum + step.inputTokens + step.outputTokens, 0);
              return (
                <button
                  key={node}
                  type="button"
                  className={`trace-node${node === stage ? " active" : ""}`}
                  disabled={nodeSteps.length === 0}
                  title={NODE_HINT[node]}
                  onClick={() => setPicked(node)}
                >
                  <b>{STAGE_LABEL[node]}</b>
                  <span className="small muted">
                    {nodeSteps.length ? `${nodeSteps.length} 条` : "未执行"}
                    {tokens ? ` · ${formatTokens(tokens)}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
          {stage ? (
            <>
              <div className="row small" style={{ marginTop: 12 }}>
                <span className="muted">{NODE_HINT[stage]}</span>
                <div className="grow" />
                <select value={itemId} onChange={(event) => setItemId(event.target.value)} aria-label="按条目筛选">
                  <option value="">全部条目</option>
                  {run.items.map((item) => (
                    <option key={item.itemId} value={item.itemId}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </div>
              {visible.length ? (
                visible.map((step) => <TraceStepView key={step.seq} step={step} titleOf={titleOf} />)
              ) : (
                <div className="small faint" style={{ marginTop: 8 }}>
                  该条目在此阶段没有记录
                </div>
              )}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
