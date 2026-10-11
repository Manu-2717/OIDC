/**
 * Creates an account for every current member of the club, before they have ever signed in here.
 *
 *   npm run accounts:seed              shows what it would do and changes nothing
 *   npm run accounts:seed -- --apply   does it
 *
 * Why: an account exists from the start, so it can be looked at and blocked before the person's first sign in, and the `sub` an app sees is
 * the same from the very first time. It is safe to run again: people who already have an account are left exactly as they are.
 *
 * Reads the member list through the read-only view (MAIN_DB_URL), looks each person up by GitHub id on GitHub's public API (no token is
 * needed; GITHUB_TOKEN raises the hourly limit if there are very many), and writes to this service's database (DATABASE_URL).
 */
import { Pool } from "pg";
import { PgAuditLog } from "../src/audit.js";

const apply = process.argv.includes("--apply");
const { DATABASE_URL, MAIN_DB_URL, GITHUB_TOKEN } = process.env;
if (!DATABASE_URL || !MAIN_DB_URL) {
  console.error("Set DATABASE_URL (this service's database) and MAIN_DB_URL (the read-only member view).");
  process.exit(2);
}

interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string | null;
}

const main = new Pool({ connectionString: MAIN_DB_URL, max: 1 });
const own = new Pool({ connectionString: DATABASE_URL, max: 1 });
const audit = new PgAuditLog(own);

async function lookup(githubId: string): Promise<GitHubUser | "gone" | "limit"> {
  const response = await fetch(`https://api.github.com/user/${encodeURIComponent(githubId)}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "usar-foss-oidc-seed",
      ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return "gone";
  if (response.status === 403 || response.status === 429) return "limit";
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for id ${githubId}`);
  return (await response.json()) as GitHubUser;
}

try {
  const { rows: members } = await main.query<{ github_id: string; role: string | null }>(
    `select github_id, role from oidc_members_v order by joined_at`,
  );
  const { rows: existing } = await own.query<{ github_id: string }>(`select github_id::text from accounts`);
  const have = new Set(existing.map((r) => r.github_id));

  const todo = members.filter((m) => !have.has(String(m.github_id)));
  console.log(`${members.length} members, ${members.length - todo.length} already have an account, ${todo.length} to create.`);

  let created = 0;
  const skipped: string[] = [];
  for (const member of todo) {
    const id = String(member.github_id);
    const found = await lookup(id);
    if (found === "limit") {
      console.error("GitHub's hourly limit for anonymous calls is used up. Wait an hour, or set GITHUB_TOKEN, and run again.");
      break;
    }
    if (found === "gone") {
      skipped.push(`${id} (no longer exists on GitHub)`);
      continue;
    }
    console.log(`${apply ? "create" : "would create"}: @${found.login} (${member.role ?? "no role"})`);
    if (!apply) continue;

    const { rows } = await own.query<{ id: string }>(
      `insert into accounts (github_id, login, name, picture, member, role, membership_checked_at)
       values ($1, $2, $3, $4, true, $5, now())
       on conflict (github_id) do nothing
       returning id`,
      [id, found.login, found.name, found.avatar_url, member.role],
    );
    const row = rows[0];
    if (row) {
      created++;
      await audit.record({ event: "account.seeded", accountId: row.id, detail: { by: "script" } });
    }
  }

  if (skipped.length) console.log(`Skipped: ${skipped.join(", ")}`);
  console.log(apply ? `Created ${created} account(s).` : "Nothing was changed. Run again with --apply to create them.");
} finally {
  await main.end();
  await own.end();
}
