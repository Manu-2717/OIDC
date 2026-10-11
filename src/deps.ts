import { Pool } from "pg";
import { AccountService, PgAccountRepo } from "./accounts.js";
import type { AppDeps } from "./app.js";
import { PgAuditLog } from "./audit.js";
import { loadClients } from "./clients.js";
import type { Config } from "./config.js";
import { HttpGitHubClient } from "./github.js";
import { MemberDirectory, PgMemberSource } from "./members.js";
import { UpstashState } from "./state.js";

/** Wires the real thing: Postgres, Upstash Redis, GitHub, and the main website's database (read only). */
export function buildDeps(config: Config, clientDefinitions: unknown): AppDeps {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    // Every serverless instance has its own pool, so this stays small. Neon's pooled address does the real sharing.
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 8_000,
  });
  pool.on("error", () => undefined);

  const state = new UpstashState(config.redisUrl, config.redisToken);
  const source = config.mainDbUrl ? new PgMemberSource(config.mainDbUrl) : null;
  const accounts = new AccountService(new PgAccountRepo(pool), state, new MemberDirectory(source, state));
  const clients = loadClients(clientDefinitions, config.clientSecrets);

  return {
    config,
    state,
    accounts,
    audit: new PgAuditLog(pool),
    github: new HttpGitHubClient(config.github.clientId, config.github.clientSecret),
    clients,
    readiness: {
      state: () => state.ping(),
      database: async () => {
        await pool.query("select 1");
        return true;
      },
    },
  };
}
