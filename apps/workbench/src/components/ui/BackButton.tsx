import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

type Props = {
  to: string;
  label?: string;
  children?: ReactNode;
};

function splitHref(href: string): { pathname: string; search?: Record<string, string> } {
  const [pathname, query = ""] = href.split("?");
  if (!query) return { pathname: pathname || "/home" };
  return { pathname: pathname || "/home", search: Object.fromEntries(new URLSearchParams(query).entries()) };
}

export function BackButton({ to, label = "返回", children }: Props) {
  const link = splitHref(to);
  return (
    <div className="row back-row">
      <Link to={link.pathname} search={link.search} className="btn ghost back-btn">
        <svg
          className="i"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m15 6-6 6 6 6" />
        </svg>
        {label}
      </Link>
      {children ? (
        <>
          <div className="grow" />
          {children}
        </>
      ) : null}
    </div>
  );
}
