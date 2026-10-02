import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";

export const WORKBENCH_COOKIE = "ss_session";

export type AuthState = {
  pairingToken: string;
  port: number;
  /** One-time login codes → expiry ms. */
  loginCodes: Map<string, number>;
  /** Active workbench session tokens. */
  sessions: Set<string>;
};

export function createAuthState(pairingToken: string, port: number): AuthState {
  return { pairingToken, port, loginCodes: new Map(), sessions: new Set() };
}

export function issueLoginCode(auth: AuthState, ttlMs = 5 * 60 * 1000): string {
  const code = randomBytes(24).toString("base64url");
  auth.loginCodes.set(code, Date.now() + ttlMs);
  return code;
}

export function consumeLoginCode(auth: AuthState, code: string): boolean {
  const expires = auth.loginCodes.get(code);
  auth.loginCodes.delete(code);
  return Boolean(expires && expires > Date.now());
}

export function createSession(auth: AuthState): string {
  const token = randomBytes(32).toString("base64url");
  auth.sessions.add(token);
  return token;
}

export function hostGuard(getPort: () => number): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const host = c.req.header("host") ?? "";
    const port = getPort();
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!allowed.has(host)) {
      return c.json({ error: "invalid_host" }, 400);
    }
    await next();
  };
}

function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export function requirePairingToken(auth: AuthState): MiddlewareHandler {
  return async (c, next) => {
    const token = bearerToken(c);
    if (token !== auth.pairingToken) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}

export function requireWorkbenchSession(auth: AuthState): MiddlewareHandler {
  return async (c, next) => {
    const cookie = getCookie(c, WORKBENCH_COOKIE);
    if (!cookie || !auth.sessions.has(cookie)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}

/** Capture APIs accept pairing token; workbench APIs accept session cookie. */
export function requireCaptureOrWorkbench(auth: AuthState): MiddlewareHandler {
  return async (c, next) => {
    const token = bearerToken(c);
    if (token === auth.pairingToken) {
      await next();
      return;
    }
    const cookie = getCookie(c, WORKBENCH_COOKIE);
    if (cookie && auth.sessions.has(cookie)) {
      await next();
      return;
    }
    return c.json({ error: "unauthorized" }, 401);
  };
}

export function requireSameOrigin(getPort: () => number): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
      await next();
      return;
    }
    const origin = c.req.header("origin");
    if (!origin) {
      // Non-browser clients (extension) typically omit Origin; Bearer auth already applied.
      if (bearerToken(c)) {
        await next();
        return;
      }
      return c.json({ error: "missing_origin" }, 403);
    }
    const port = getPort();
    const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
    if (!allowed.has(origin)) return c.json({ error: "invalid_origin" }, 403);
    await next();
  };
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, WORKBENCH_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    secure: false
  });
}
