import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountService, PgAccountRepo } from "../src/accounts.js";
import { PgAuditLog } from "../src/audit.js";
import { MemberDirectory } from "../src/members.js";
import { MemoryState } from "../src/state.js";

/**
 * Runs the real SQL (the migration and the role grants) against a real Postgres. Skipped unless TEST_DATABASE_URL is set to a superuser
 * address of a throwaway server:
 *
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres npm run test:postgres
 *
 * It creates its own database and drops it afterwards.
 */
const admin = process.env.TEST_DATABASE_URL;
const root = join(import.meta.dirname, "..");

describe.skipIf(!admin)("against a real Postgres", () => {
  const name = `oidc_test_${Math.random().toString(36).slice(2, 10)}`;
  const withDb = (user: string, password: string | null) => {
    const url = new URL(admin!);
    url.pathname = `/${name}`;
    url.username = user;
    if (password) url.password = password;
    return url.toString();
  };
  let pool: Pool;
  let ownerPool: Pool;

  beforeAll(async () => {
    const c = new Client({ connectionString: admin });
    await c.connect();
    await c.query(`create database ${name}`);
    await c.end();

    const owner = new Client({ connectionString: withDb("postgres", null) });
    await owner.connect();
    await owner.query(readFileSync(join(root, "db/migrations/0001_init.sql"), "utf8"));
    const roles = readFileSync(join(root, "db/roles.sql"), "utf8")
      .replace("REPLACE_ME_OIDC_APP_PASSWORD", "apppw1234567890")
      .replace("REPLACE_ME_OIDC_BACKUP_PASSWORD", "bkppw1234567890");
    await owner.query(roles);
    await owner.end();

    ownerPool = new Pool({ connectionString: withDb("postgres", null), max: 2 });
    pool = new Pool({ connectionString: withDb("oidc_app", "apppw1234567890"), max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
    await ownerPool?.end();
    const c = new Client({ connectionString: admin });
    await c.connect();
    await c.query(`drop database if exists ${name} with (force)`);
    await c.query("drop role if exists oidc_app");
    await c.query("drop role if exists oidc_backup");
    await c.end();
  });

  const profile = (id: string, login: string) => ({
    id,
    login,
    name: `${login} N`,
    email: `${login}@example.com`,
    emailVerified: true,
    picture: null,
  });

  it("creates an account on first sign in and refreshes it on the next, keeping the same sub", async () => {
    const repo = new PgAccountRepo(pool);
    const first = await repo.upsertFromGitHub(profile("9007199254740993", "asha"));
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.githubId).toBe("9007199254740993"); // beyond 2^53: it must survive as text
    expect(first.status).toBe("active");

    const second = await repo.upsertFromGitHub({ ...profile("9007199254740993", "asha-renamed"), name: "New Name" });
    expect(second.id).toBe(first.id);
    expect(second.login).toBe("asha-renamed");
    expect(second.name).toBe("New Name");
  });

  it("never lets a sign in undo a block", async () => {
    const repo = new PgAccountRepo(pool);
    const a = await repo.upsertFromGitHub(profile("2001", "blockme"));
    await repo.setStatus(a.id, "blocked");
    const again = await repo.upsertFromGitHub(profile("2001", "blockme"));
    expect(again.status).toBe("blocked");
  });

  it("finds a person by username, ignoring case", async () => {
    const repo = new PgAccountRepo(pool);
    await repo.upsertFromGitHub(profile("2002", "MixedCase"));
    expect((await repo.getByLogin("mixedcase"))?.githubId).toBe("2002");
    expect(await repo.getByLogin("nobody-here")).toBeNull();
  });

  it("works through the service, with membership kept as the last known answer", async () => {
    const repo = new PgAccountRepo(pool);
    const state = new MemoryState();
    const source = { lookup: async () => ({ member: true, role: "ADMIN" }) };
    const service = new AccountService(repo, state, new MemberDirectory(source, state));
    const snap = await service.signIn(profile("2003", "svc"));
    expect(snap).toMatchObject({ member: true, role: "ADMIN", status: "active" });
    const row = await repo.getById(snap.id);
    expect(row).toMatchObject({ member: true, role: "ADMIN" });
    expect(row?.membershipCheckedAt).toBeInstanceOf(Date);
  });

  it("refuses values the table should never hold", async () => {
    await expect(ownerPool.query(`insert into accounts (github_id, login, status) values (3001, 'x', 'maybe')`)).rejects.toThrow(/check/);
    await ownerPool.query(`insert into accounts (github_id, login) values (3002, 'dup')`);
    await expect(ownerPool.query(`insert into accounts (github_id, login) values (3002, 'dup2')`)).rejects.toThrow(/unique/);
  });

  it("writes audit entries, and a failure to write never throws", async () => {
    const audit = new PgAuditLog(pool);
    await audit.record({
      event: "login.success",
      accountId: "00000000-0000-4000-8000-000000000001",
      clientId: "quiz",
      ip: "1.2.3.4",
      detail: { a: 1 },
    });
    const { rows } = await ownerPool.query(`select event, client_id, detail from audit_log order by id desc limit 1`);
    expect(rows[0]).toMatchObject({ event: "login.success", client_id: "quiz", detail: { a: 1 } });

    // Not a uuid: the insert fails, and the call still returns normally.
    await expect(audit.record({ event: "login.success", accountId: "not-a-uuid" })).resolves.toBeUndefined();
  });

  describe("the restricted login", () => {
    it("can read and write rows", async () => {
      await expect(pool.query(`select count(*) from accounts`)).resolves.toBeTruthy();
      await expect(pool.query(`update accounts set updated_at = now() where github_id = 2003`)).resolves.toBeTruthy();
    });

    it("cannot empty, drop or change the tables, or make new ones", async () => {
      await expect(pool.query(`truncate accounts`)).rejects.toThrow(/permission denied/);
      await expect(pool.query(`drop table audit_log`)).rejects.toThrow(/must be owner|permission denied/);
      await expect(pool.query(`alter table accounts add column x int`)).rejects.toThrow(/must be owner|permission denied/);
      await expect(pool.query(`create table sneaky (id int)`)).rejects.toThrow(/permission denied/);
      await expect(pool.query(`create role evil login`)).rejects.toThrow(/permission denied/);
    });

    it("has a time limit on every statement", async () => {
      const { rows } = await pool.query(`show statement_timeout`);
      expect(rows[0].statement_timeout).toBe("15s");
    });

    it("keeps its access to tables made by a later migration", async () => {
      await ownerPool.query(`create table later_table (id int)`);
      await expect(pool.query(`insert into later_table values (1)`)).resolves.toBeTruthy();
      await expect(pool.query(`truncate later_table`)).rejects.toThrow(/permission denied/);
    });
  });

  describe("the backup login", () => {
    it("can read everything and change nothing", async () => {
      const backup = new Pool({ connectionString: withDb("oidc_backup", "bkppw1234567890"), max: 1 });
      try {
        await expect(backup.query(`select count(*) from accounts`)).resolves.toBeTruthy();
        await expect(backup.query(`select count(*) from audit_log`)).resolves.toBeTruthy();
        await expect(backup.query(`insert into audit_log (event) values ('x')`)).rejects.toThrow(/permission denied/);
        await expect(backup.query(`delete from accounts`)).rejects.toThrow(/permission denied/);
      } finally {
        await backup.end();
      }
    });
  });
});
