import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { useModuleMemoryStore } from "@/stores/module-memory";
import type { ModuleId } from "@/lib/module-state";
import { ToastHost } from "@/components/ui/ToastHost";
import styles from "./AppShell.module.css";

const NAV: Array<{ id: ModuleId; label: string; icon: ReactNode; countKey?: "unread" }> = [
  {
    id: "home",
    label: "首页",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z" />
      </svg>
    )
  },
  {
    id: "wiki",
    label: "知识库",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="8" r="2.5" />
        <circle cx="9" cy="18" r="2.5" />
        <path d="m8.2 7.3 7.4 1.2M7 8.3l1.5 7.3m2.4.8 5.6-6.5" />
      </svg>
    )
  },
  {
    id: "progress",
    label: "学习进度",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M22 12h-4l-3 8L9 4l-3 8H2" />
      </svg>
    )
  },
  {
    id: "inbox",
    label: "收集箱",
    countKey: "unread",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" />
      </svg>
    )
  },
  {
    id: "runs",
    label: "整理记录",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5M12 7v5l3 2" />
      </svg>
    )
  }
];

function moduleLinkProps(href: string): { to: string; search?: Record<string, string> } {
  const [pathname, query = ""] = href.split("?");
  if (!query) return { to: pathname || "/home" };
  const search = Object.fromEntries(new URLSearchParams(query).entries());
  return { to: pathname || "/home", search };
}

type Props = {
  children: ReactNode;
  wide?: boolean;
  fit?: boolean;
};

export function AppShell({ children, wide, fit }: Props) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const remember = useModuleMemoryStore((state) => state.remember);
  const hrefFor = useModuleMemoryStore((state) => state.hrefFor);
  const saveScroll = useModuleMemoryStore((state) => state.saveScroll);
  const getScroll = useModuleMemoryStore((state) => state.getScroll);
  const mainRef = useRef<HTMLElement>(null);
  const prevRoute = useRef(`${pathname}${search}`);

  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api.getOverview() });
  const dataInfo = useQuery({ queryKey: ["data-info"], queryFn: () => api.getDataInfo() });

  useEffect(() => {
    remember(pathname, search);
  }, [pathname, search, remember]);

  useEffect(() => {
    const key = prevRoute.current;
    const el = mainRef.current;
    if (el) saveScroll(key, el.scrollTop);
    const next = `${pathname}${search}`;
    prevRoute.current = next;
    requestAnimationFrame(() => {
      if (mainRef.current) mainRef.current.scrollTop = getScroll(next);
    });
  }, [pathname, search, saveScroll, getScroll]);

  const currentModule = pathname.startsWith("/settings") ? "settings" : pathname.startsWith("/item") ? "inbox" : (pathname.split("/")[1] as ModuleId) || "home";

  return (
    <div className={`app ${styles.shell}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">S</div>Study Studio
        </div>
        <nav>
          {NAV.map((entry) => {
            const active = currentModule === entry.id;
            const href = active ? (entry.id === "settings" ? "/settings/collect" : `/${entry.id}`) : hrefFor(entry.id);
            const link = moduleLinkProps(href);
            const count = entry.countKey === "unread" ? overview.data?.pending.unread : undefined;
            return (
              <Link key={entry.id} to={link.to} search={link.search} className={`nav-item ${active ? "active" : ""}`}>
                <span className="icon">{entry.icon}</span>
                {entry.label}
                {count ? <span className="count">{count}</span> : null}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          {(() => {
            const link = moduleLinkProps(hrefFor("settings"));
            return (
              <Link to={link.to} search={link.search} className={`nav-item ${currentModule === "settings" ? "active" : ""}`}>
                <span className="icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
                  </svg>
                </span>
                设置
              </Link>
            );
          })()}
          <div className="sidebar-footer">
            <div>
              <span className="dot" />
              本地服务运行中
            </div>
            <div>
              <span className={`dot ${dataInfo.data?.extensionConnected ? "" : "off"}`} />
              扩展{dataInfo.data?.extensionConnected ? "已连接" : "未连接"}
            </div>
          </div>
        </div>
      </aside>
      <main ref={mainRef} className={`main ${wide ? "wide" : ""} ${fit ? "fit" : ""} ${styles.main}`}>
        {children}
      </main>
      <ToastHost />
    </div>
  );
}
