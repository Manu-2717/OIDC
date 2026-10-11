/**
 * One JSON object per line on stdout, which is what Vercel (and any log shipper) wants.
 *
 * Nothing secret goes through here: callers pass only identifiers and outcomes (an account id, a client id, an event name), never a token,
 * a code, a cookie, a client secret or a person's email address.
 */

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level | undefined) ?? "info"] ?? order.info;

export function log(level: Level, message: string, fields: Record<string, unknown> = {}) {
  if (order[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: message, ...fields });
  // eslint-disable-next-line no-console
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}
