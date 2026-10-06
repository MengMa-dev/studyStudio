import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WORKBENCH_COOKIE = "ss_session";
const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 20;
const SESSION_MAX_AGE_S = 400 * 24 * 60 * 60;

export type AuthState = {
  pairingToken: string;
  /** Bearer token for `/mcp` (external agents); reset replaces it in place. */
  mcpToken: string;
  port: number;
  /** One-time login codes → expiry ms. */
  loginCodes: Map<string, number>;
  /** Active workbench session tokens. */
  sessions: Set<string>;
  /** Sessions persist to `<dataDir>/.sessions`; `.login-code` lets the CLI log in to a running server. */
  dataDir?: string;
};

export function createAuthState(pairingToken: string, port: number, mcpToken = randomBytes(32).toString("base64url"), dataDir?: string): AuthState {
  const file = dataDir && join(dataDir, ".sessions");
  const sessions = new Set(file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  return { pairingToken, mcpToken, port, loginCodes: new Map(), sessions, ...(dataDir ? { dataDir } : {}) };
}

export function issueLoginCode(auth: AuthState, ttlMs = LOGIN_CODE_TTL_MS): string {
  const code = randomBytes(24).toString("base64url");
  auth.loginCodes.set(code, Date.now() + ttlMs);
  return code;
}

/** Out-of-process login (`study-studio open`): whoever can write the data dir may log in. */
export function writeLoginCode(dataDir: string): string {
  const code = randomBytes(24).toString("base64url");
  writeFileSync(join(dataDir, ".login-code"), code, { mode: 0o600 });
  return code;
}

function consumeFileLoginCode(dataDir: string, code: string): boolean {
  const file = join(dataDir, ".login-code");
  if (!existsSync(file)) return false;
  const ok = readFileSync(file, "utf8").trim() === code && Date.now() - statSync(file).mtimeMs < LOGIN_CODE_TTL_MS;
  if (ok) rmSync(file, { force: true });
  return ok;
}

export function consumeLoginCode(auth: AuthState, code: string): boolean {
  const expires = auth.loginCodes.get(code);
  auth.loginCodes.delete(code);
  if (expires && expires > Date.now()) return true;
  return Boolean(auth.dataDir && consumeFileLoginCode(auth.dataDir, code));
}

export function createSession(auth: AuthState): string {
  const token = randomBytes(32).toString("base64url");
  auth.sessions.add(token);
  for (const old of [...auth.sessions].slice(0, -MAX_SESSIONS)) auth.sessions.delete(old);
  if (auth.dataDir) writeFileSync(join(auth.dataDir, ".sessions"), [...auth.sessions].join("\n"), { mode: 0o600 });
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

/** `/mcp` only: workbench cookies are not accepted so browsers cannot call it cross-site. */
export function requireMcpToken(auth: AuthState): MiddlewareHandler {
  return async (c, next) => {
    const token = bearerToken(c);
    if (!token || token !== auth.mcpToken) return c.json({ error: "unauthorized" }, 401);
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
    // Bearer requests (extension sends Origin: chrome-extension://…) are already token-checked and cannot be forged cross-site.
    if (bearerToken(c)) {
      await next();
      return;
    }
    const origin = c.req.header("origin");
    if (!origin) return c.json({ error: "missing_origin" }, 403);
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
    maxAge: SESSION_MAX_AGE_S,
    secure: false
  });
}
