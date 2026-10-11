/**
 * Looks at, blocks or unblocks an account. Blocking takes effect within a minute everywhere: the person's sessions stop working and they
 * cannot sign in again.
 *
 *   npm run account -- show <github-username>
 *   npm run account -- block <github-username>
 *   npm run account -- unblock <github-username>
 *
 * Needs DATABASE_URL (the oidc_app login is enough) and the Redis settings (UPSTASH_REDIS_REST_URL and _TOKEN), so the change is seen at once.
 */
import { Pool } from "pg";
import { AccountService, PgAccountRepo } from "../src/accounts.js";
import { PgAuditLog } from "../src/audit.js";
import { MemberDirectory } from "../src/members.js";
import { UpstashState } from "../src/state.js";

const [command, login] = process.argv.slice(2);
if (!command || !login || !["show", "block", "unblock"].includes(command)) {
  console.error("usage: npm run account -- <show|block|unblock> <github-username>");
  process.exit(2);
}
const { DATABASE_URL, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("Set DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
  process.exit(2);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
const state = new UpstashState(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN);
const repo = new PgAccountRepo(pool);
const accounts = new AccountService(repo, state, new MemberDirectory(null, state));
const audit = new PgAuditLog(pool);

try {
  const account = await repo.getByLogin(login);
  if (!account) {
    console.error(`No account for ${login}. (An account exists once the person has signed in at least once.)`);
    process.exit(1);
  }
  if (command === "show") {
    console.log(JSON.stringify({ ...account, githubId: account.githubId }, null, 2));
  } else if (command === "block") {
    await accounts.block(account.id);
    await audit.record({ event: "account.blocked", accountId: account.id, detail: { by: "script" } });
    console.log(`Blocked ${account.login} (${account.id}). Their sessions stop working within a minute.`);
  } else {
    await accounts.unblock(account.id);
    await audit.record({ event: "account.unblocked", accountId: account.id, detail: { by: "script" } });
    console.log(`Unblocked ${account.login} (${account.id}).`);
  }
} finally {
  await pool.end();
}
