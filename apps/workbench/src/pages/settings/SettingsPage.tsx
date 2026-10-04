import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SettingsAgent } from "./SettingsAgent";
import { SettingsAi } from "./SettingsAi";
import { SettingsCollect } from "./SettingsCollect";
import { SettingsData } from "./SettingsData";
import { SettingsOrganize } from "./SettingsOrganize";
import { SettingsProfile } from "./SettingsProfile";
const SECTIONS = [
  ["collect", "采集", "浏览器扩展、正文采集规则和排除规则"],
  ["ai", "AI 模型", "模型服务商、按任务选模型和每日用量"],
  ["organize", "整理规则", "自动整理触发器和输出语言"],
  ["agent", "Agent 接入", "在 Cursor / Claude Code / Codex 中通过 MCP 整理收件箱"],
  ["profile", "学习者档案", "角色和近期学习方向"],
  ["data", "数据与隐私", "本地数据、备份和危险操作"]
] as const;

type Section = (typeof SECTIONS)[number][0];

type Props = { section: Section };

export function SettingsPage({ section }: Props) {
  const current = SECTIONS.find(([id]) => id === section) ?? SECTIONS[0];
  let body: ReactNode;
  switch (current[0]) {
    case "collect":
      body = <SettingsCollect />;
      break;
    case "profile":
      body = <SettingsProfile />;
      break;
    case "data":
      body = <SettingsData />;
      break;
    case "ai":
      body = <SettingsAi />;
      break;
    case "organize":
      body = <SettingsOrganize />;
      break;
    case "agent":
      body = <SettingsAgent />;
      break;
  }

  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        <div className="settings-nav-title">设置</div>
        {SECTIONS.map(([id, label]) => (
          <Link key={id} to="/settings/$section" params={{ section: id }} className={`settings-link ${id === current[0] ? "active" : ""}`}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="settings-body">
        <div className="settings-head">
          <h1>{current[1]}</h1>
          <div className="muted">{current[2]}</div>
        </div>
        {body}
      </div>
    </div>
  );
}

export function setGroup(title: string, rows: ReactNode, extra?: ReactNode, foot?: string) {
  return (
    <section className="set-group">
      <div className="set-group-head">
        <h3>{title}</h3>
        <div className="grow" />
        {extra}
      </div>
      <div className="set-card">{rows}</div>
      {foot ? <div className="set-foot">{foot}</div> : null}
    </section>
  );
}

export function setRow(label: ReactNode, desc: ReactNode, control?: ReactNode, className = "") {
  return (
    <div className={`set-row ${className}`}>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="set-label">{label}</div>
        {desc ? <div className="set-desc">{desc}</div> : null}
      </div>
      {control ? <div className="set-control">{control}</div> : null}
    </div>
  );
}
