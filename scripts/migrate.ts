/**
 * Applies db/migrations/*.sql in order, each in its own transaction, and records what has been applied.
 *
 *   DATABASE_URL=<the OWNER's direct address> npm run db:migrate
 *
 * Use the owner login (not oidc_app), and the direct address (not the -pooler one).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL to the owner's direct address.");

const dir = join(import.meta.dirname, "..", "db", "migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await client.query<{ name: string }>(`select name from schema_migrations`)).rows.map((r) => r.name));

  for (const file of files) {
    if (done.has(file)) {
      console.log(`  skip   ${file}`);
      continue;
    }
    await client.query("begin");
    try {
      await client.query(readFileSync(join(dir, file), "utf8"));
      await client.query(`insert into schema_migrations (name) values ($1)`, [file]);
      await client.query("commit");
      console.log(`  apply  ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  console.log("Up to date.");
} finally {
  await client.end();
}
