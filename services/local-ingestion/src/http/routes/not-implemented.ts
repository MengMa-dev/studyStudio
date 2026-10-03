import type { Context } from "hono";

export function notImplemented(c: Context) {
  return c.json({ error: "not_implemented" }, 501);
}
