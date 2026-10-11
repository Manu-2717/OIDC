import { waitUntil } from "@vercel/functions";
import type { Pool } from "pg";
import { log } from "./log.js";

/**
 * A record of who signed in to what, and who was turned away. It is for answering "what happened to this account?" after the fact, so it
 * holds identifiers and outcomes and nothing that could be used to sign in as someone.
 */

export type AuditEvent =
  | "login.success"
  | "login.denied_blocked"
  | "login.denied_state"
  | "login.denied_upstream"
  | "login.cancelled"
  | "access.denied_not_member"
  | "consent.granted"
  | "app.signin"
  | "consent.declined"
  | "logout"
  | "account.blocked"
  | "account.unblocked"
  | "account.seeded";

export interface AuditEntry {
  event: AuditEvent;
  accountId?: string | undefined;
  clientId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

/** How long entries are kept. Old sign ins have no use, and less personal data held is less to lose. */
export const AUDIT_RETENTION_DAYS = 180;

export class PgAuditLog implements AuditLog {
  constructor(private readonly pool: Pool) {}

  /**
   * Most callers do not wait for this, so that writing a log line can never hold up a sign in. On Vercel a promise that nobody waits for
   * can be cut off the moment the response has gone out, so the write is also handed to the platform (`waitUntil`), which keeps the
   * instance alive until it has finished. Anywhere else `waitUntil` does nothing and the process simply carries on.
   */
  record(entry: AuditEntry): Promise<void> {
    const written = this.write(entry);
    try {
      waitUntil(written);
    } catch (error) {
      log("warn", "could not hand an audit write to the platform", { error: error instanceof Error ? error.message : String(error) });
    }
    return written;
  }

  /** Never rejects: failing to record must never stop a person from signing in, but it must be loud. */
  private async write(entry: AuditEntry) {
    try {
      await this.pool.query(
        `insert into audit_log (event, account_id, client_id, ip, user_agent, detail) values ($1, $2, $3, $4, $5, $6)`,
        [
          entry.event,
          entry.accountId ?? null,
          entry.clientId ?? null,
          entry.ip ?? null,
          entry.userAgent?.slice(0, 300) ?? null,
          entry.detail ? JSON.stringify(entry.detail) : null,
        ],
      );
      // Tidying as we go, one write in two hundred, so no separate schedule is needed.
      if (Math.random() < 0.005) {
        await this.pool.query(`delete from audit_log where at < now() - make_interval(days => $1)`, [AUDIT_RETENTION_DAYS]);
      }
    } catch (error) {
      log("error", "could not write an audit entry", { event: entry.event, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export class MemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry) {
    this.entries.push(entry);
  }
}
