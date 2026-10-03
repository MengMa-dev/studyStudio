import type { AnchorHTMLAttributes, ReactNode } from "react";
import { vi } from "vitest";

export const navigateMock = vi.fn();

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; params?: Record<string, string>; search?: unknown; children?: ReactNode };

export function Link({ to, params, search: _search, children, ...rest }: LinkProps) {
  void _search;
  const href = (to ?? "").replace(/\$(\w+)/g, (_, key: string) => params?.[key] ?? key);
  return (
    <a href={`#${href}`} {...rest}>
      {children}
    </a>
  );
}

export function useNavigate() {
  return navigateMock;
}
