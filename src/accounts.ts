import type { Pool } from "pg";
import type { MemberDirectory } from "./members.js";
import type { StateBackend } from "./state.js";

/**
 * Accounts: one row per person who has signed in, keyed by their GitHub id (which never changes, unlike a username). `id` is the `sub` that
 * every app sees, and it is ours alone: no app ever sees a GitHub token or a GitHub id.
 */

export interface GitHubProfile {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  picture: string | null;
}

export type AccountStatus = "active" | "blocked";

export interface AccountRow {
  id: string;
  githubId: string;
  login: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  picture: string | null;
  status: AccountStatus;
  member: boolean;
  role: string | null;
  membershipCheckedAt: Date | null;
  lastLoginAt: Date | null;
}

export interface AccountRepo {
  /** Creates the account on first sign in, and refreshes its profile on every later one. The status is never touched. */
  upsertFromGitHub(profile: GitHubProfile): Promise<AccountRow>;
  getById(id: string): Promise<AccountRow | null>;
  getByLogin(login: string): Promise<AccountRow | null>;
  setMembership(id: string, membership: { member: boolean; role: string | null }): Promise<void>;
  setStatus(id: string, status: AccountStatus): Promise<void>;
}

/* ------------------------------------------------------------------------------------------------ Postgres */

interface DbAccount {
  id: string;
  github_id: string;
  login: string;
  name: string | null;
  email: string | null;
  email_verified: boolean;
  picture: string | null;
  status: AccountStatus;
  member: boolean;
  role: string | null;
  membership_checked_at: Date | null;
  last_login_at: Date | null;
}

const toRow = (r: DbAccount): AccountRow => ({
  id: r.id,
  githubId: String(r.github_id),
  login: r.login,
  name: r.name,
  email: r.email,
  emailVerified: r.email_verified,
  picture: r.picture,
  status: r.status,
  member: r.member,
  role: r.role,
  membershipCheckedAt: r.membership_checked_at,
  lastLoginAt: r.last_login_at,
});

const COLUMNS = "id, github_id, login, name, email, email_verified, picture, status, member, role, membership_checked_at, last_login_at";

export class PgAccountRepo implements AccountRepo {
  constructor(private readonly pool: Pool) {}

  async upsertFromGitHub(p: GitHubProfile) {
    const { rows } = await this.pool.query<DbAccount>(
      `insert into accounts (github_id, login, name, email, email_verified, picture, last_login_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (github_id) do update
         set login = excluded.login, name = excluded.name, email = excluded.email, email_verified = excluded.email_verified,
             picture = excluded.picture, last_login_at = now(), updated_at = now()
       returning ${COLUMNS}`,
      [p.id, p.login, p.name, p.email, p.emailVerified, p.picture],
    );
    return toRow(rows[0]!);
  }

  async getById(id: string) {
    const { rows } = await this.pool.query<DbAccount>(`select ${COLUMNS} from accounts where id = $1`, [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async getByLogin(login: string) {
    const { rows } = await this.pool.query<DbAccount>(`select ${COLUMNS} from accounts where lower(login) = lower($1)`, [login]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async setMembership(id: string, m: { member: boolean; role: string | null }) {
    await this.pool.query(`update accounts set member = $2, role = $3, membership_checked_at = now(), updated_at = now() where id = $1`, [
      id,
      m.member,
      m.role,
    ]);
  }

  async setStatus(id: string, status: AccountStatus) {
    await this.pool.query(`update accounts set status = $2, updated_at = now() where id = $1`, [id, status]);
  }
}

/* ------------------------------------------------------------------------------------------------ memory */

export class MemoryAccountRepo implements AccountRepo {
  private readonly rows = new Map<string, AccountRow>();
  private seq = 0;

  async upsertFromGitHub(p: GitHubProfile) {
    const existing = [...this.rows.values()].find((r) => r.githubId === p.id);
    const row: AccountRow = {
      id: existing?.id ?? `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      githubId: p.id,
      login: p.login,
      name: p.name,
      email: p.email,
      emailVerified: p.emailVerified,
      picture: p.picture,
      status: existing?.status ?? "active",
      member: existing?.member ?? false,
      role: existing?.role ?? null,
      membershipCheckedAt: existing?.membershipCheckedAt ?? null,
      lastLoginAt: new Date(),
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async getById(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async getByLogin(login: string) {
    const row = [...this.rows.values()].find((r) => r.login.toLowerCase() === login.toLowerCase());
    return row ? { ...row } : null;
  }

  async setMembership(id: string, m: { member: boolean; role: string | null }) {
    const row = this.rows.get(id);
    if (row) Object.assign(row, { member: m.member, role: m.role, membershipCheckedAt: new Date() });
  }

  async setStatus(id: string, status: AccountStatus) {
    const row = this.rows.get(id);
    if (row) row.status = status;
  }
}

/* ------------------------------------------------------------------------------------------------ the service */

/** What the rest of the service needs to know about an account, small enough to keep in the state store for a few minutes. */
export interface AccountSnapshot {
  id: string;
  /** GitHub's numeric id. Only released to the apps allowed the `github` scope. (Missing in snapshots cached before it was added.) */
  githubId?: string;
  status: AccountStatus;
  login: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  picture: string | null;
  member: boolean;
  role: string | null;
  updatedAt: number;
}

const SNAPSHOT_TTL = 300;
const BLOCKED_SNAPSHOT_TTL = 60;
/** Someone who is not a member yet is looked at again soon: they are probably on their way to join. */
const NON_MEMBER_SNAPSHOT_TTL = 30;
const snapshotKey = (id: string) => `oidc:acct:${id}`;

export class AccountService {
  constructor(
    private readonly repo: AccountRepo,
    private readonly state: StateBackend,
    private readonly members: MemberDirectory,
  ) {}

  private async build(row: AccountRow): Promise<AccountSnapshot> {
    // A blocked account is never asked about membership: it cannot sign in, whatever it is.
    const m = row.status === "blocked" ? { member: false, role: null, fresh: true } : await this.members.resolve(row.githubId, row);
    if (m.fresh && (m.member !== row.member || m.role !== row.role || row.membershipCheckedAt === null)) {
      await this.repo.setMembership(row.id, { member: m.member, role: m.role });
    }
    return {
      id: row.id,
      githubId: row.githubId,
      status: row.status,
      login: row.login,
      name: row.name,
      email: row.email,
      emailVerified: row.emailVerified,
      picture: row.picture,
      member: m.member,
      role: m.role,
      updatedAt: Math.floor((row.lastLoginAt ?? new Date()).getTime() / 1000),
    };
  }

  private async remember(snapshot: AccountSnapshot) {
    await this.state.exec([
      {
        t: "set",
        key: snapshotKey(snapshot.id),
        value: JSON.stringify(snapshot),
        ex: snapshot.status === "blocked" ? BLOCKED_SNAPSHOT_TTL : snapshot.member ? SNAPSHOT_TTL : NON_MEMBER_SNAPSHOT_TTL,
      },
    ]);
  }

  /** The account as of a few minutes ago at most, or null if there is none. This is what runs on every token and every userinfo call. */
  async snapshot(id: string): Promise<AccountSnapshot | null> {
    const cached = await this.state.get(snapshotKey(id)).catch(() => null);
    if (cached) return JSON.parse(cached) as AccountSnapshot;

    const row = await this.repo.getById(id);
    if (!row) return null;
    const snapshot = await this.build(row);
    await this.remember(snapshot).catch(() => undefined);
    return snapshot;
  }

  /** Creates or refreshes the account for a GitHub sign in, with the membership looked up now. */
  async signIn(profile: GitHubProfile): Promise<AccountSnapshot> {
    const row = await this.repo.upsertFromGitHub(profile);
    const snapshot = await this.build(row);
    await this.remember(snapshot).catch(() => undefined);
    return snapshot;
  }

  async block(id: string) {
    await this.repo.setStatus(id, "blocked");
    await this.state.exec([{ t: "del", key: snapshotKey(id) }]);
  }

  async unblock(id: string) {
    await this.repo.setStatus(id, "active");
    await this.state.exec([{ t: "del", key: snapshotKey(id) }]);
  }
}
