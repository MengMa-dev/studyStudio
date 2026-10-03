import type { AnchorHTMLAttributes, ReactNode } from "react";
import { vi } from "vitest";
import { create } from "zustand";

export const navigateMock = vi.fn();

const useMockLocation = create<{ pathname: string }>(() => ({ pathname: "/home" }));

/** Drives `useRouterState` for components that derive state from the current path. */
export function setMockPathname(pathname: string): void {
  useMockLocation.setState({ pathname });
}

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

export function useRouterState<T>({ select }: { select: (state: { location: { pathname: string } }) => T }): T {
  const pathname = useMockLocation((state) => state.pathname);
  return select({ location: { pathname } });
}
