import { Pool } from "pg";
import type { StateBackend } from "./state.js";
import { log } from "./log.js";

/**
 * "Is this person a member of the club, and what is their role?" The answer belongs to the main website's database. This service never
 * writes there: it reads one view, `oidc_members_v`, through a login that can read that view and nothing else.
 *
 * Reading is made fast and safe in three ways:
 *  - the answer is kept for 10 minutes (30 seconds when it is "not a member", so someone who has just joined is not kept waiting), so most sign ins and token calls never reach the main database (which may be asleep),
 *  - if the main database cannot be reached the last known answer is used, so sign in keeps working through an outage there,
 *  - after a failure the main database is left alone for 30 seconds instead of being retried by every request.
 */

export interface MemberStatus {
  member: boolean;
  role: string | null;
}

export interface MemberSource {
  /** Throws if the main database cannot be reached. A person who is simply not in it is `{ member: false }`. */
  lookup(githubId: string): Promise<MemberStatus>;
}

export class PgMemberSource implements MemberSource {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 4_000,
      // A database that has been asleep takes a few seconds to wake, and nothing here is worth waiting longer than that for.
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    // A dropped idle connection must not take the process down.
    this.pool.on("error", (error) => log("warn", "member source connection error", { error: error.message }));
  }

  async lookup(githubId: string): Promise<MemberStatus> {
    const { rows } = await this.pool.query<{ role: string | null }>(`select role from oidc_members_v where github_id = $1 limit 1`, [
      githubId,
    ]);
    const row = rows[0];
    return row ? { member: true, role: row.role } : { member: false, role: null };
  }

  async close() {
    await this.pool.end();
  }
}

export interface ResolvedMembership extends MemberStatus {
  /** False when this is the last known answer and not a current one. */
  fresh: boolean;
}

const CACHE_TTL = 600;
/** "Not a member" is remembered only briefly: the usual reason is someone who has just joined and is coming back from the website. */
const NEGATIVE_TTL = 30;
const BREAKER_TTL = 30;
const cacheKey = (githubId: string) => `oidc:member:${githubId}`;
const BREAKER_KEY = "oidc:member:down";

export class MemberDirectory {
  constructor(
    private readonly source: MemberSource | null,
    private readonly state: StateBackend,
  ) {}

  async resolve(githubId: string, lastKnown: MemberStatus): Promise<ResolvedMembership> {
    // With no main database configured nobody is a member, which is the safe answer.
    if (!this.source) return { member: false, role: null, fresh: true };

    const cached = await this.state.get(cacheKey(githubId)).catch(() => null);
    if (cached) return { ...(JSON.parse(cached) as MemberStatus), fresh: true };

    if (await this.state.get(BREAKER_KEY).catch(() => null)) return { ...lastKnown, fresh: false };

    try {
      const status = await this.source.lookup(githubId);
      await this.state
        .exec([{ t: "set", key: cacheKey(githubId), value: JSON.stringify(status), ex: status.member ? CACHE_TTL : NEGATIVE_TTL }])
        .catch(() => undefined);
      return { ...status, fresh: true };
    } catch (error) {
      log("warn", "member lookup failed, using the last known answer", { error: error instanceof Error ? error.message : String(error) });
      await this.state.exec([{ t: "set", key: BREAKER_KEY, value: "1", ex: BREAKER_TTL }]).catch(() => undefined);
      return { ...lastKnown, fresh: false };
    }
  }
}
