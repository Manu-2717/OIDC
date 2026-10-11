/**
 * Checks the service's database is ready, without changing anything:
 *
 *   DATABASE_URL="<the oidc_app address>" npm run db:check
 *
 * It reports who it connected as, whether the tables exist, and (from the database's own permission records, not by trying) that this login
 * can read and write rows but cannot empty, drop or alter them.
 */
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to the address you want to check.");
  process.exit(2);
}

const host = new URL(url).hostname;
const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
let problems = 0;
const line = (ok: boolean, text: string) => {
  if (!ok) problems++;
  console.log(`${ok ? "ok    " : "FIX   "} ${text}`);
};

try {
  const started = Date.now();
  await client.connect();
  const who = (await client.query<{ u: string; d: string }>("select current_user u, current_database() d")).rows[0]!;
  console.log(`connected to ${host} as ${who.u} (${Date.now() - started} ms, database ${who.d})`);
  line(
    host.includes("-pooler"),
    host.includes("-pooler")
      ? "using the pooled address"
      : "this is the direct address: the running service should use the pooled one (host with -pooler)",
  );

  for (const table of ["accounts", "audit_log"]) {
    const exists = (await client.query<{ e: boolean }>("select to_regclass($1) is not null as e", [`public.${table}`])).rows[0]!.e;
    line(
      exists,
      exists ? `table ${table} exists` : `table ${table} is missing: run \`npm run db:migrate\` with the owner's direct address`,
    );
    if (!exists) continue;
    const p = (
      await client.query<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }>(
        `select has_table_privilege(current_user, $1, 'SELECT') s, has_table_privilege(current_user, $1, 'INSERT') i,
                has_table_privilege(current_user, $1, 'UPDATE') u, has_table_privilege(current_user, $1, 'DELETE') d,
                has_table_privilege(current_user, $1, 'TRUNCATE') t`,
        [`public.${table}`],
      )
    ).rows[0]!;
    const rw = p.s && p.i && p.u && p.d;
    line(rw, rw ? `  can read and write ${table}` : `  cannot read and write ${table}: run db/roles.sql as the owner`);
    line(
      !p.t,
      !p.t ? `  cannot empty ${table}` : `  CAN empty ${table}: this login is too powerful for the running service (use oidc_app)`,
    );
  }

  const owner = (
    await client.query<{ o: string }>("select tableowner o from pg_tables where schemaname = 'public' and tablename = 'accounts'")
  ).rows[0]?.o;
  if (owner)
    line(
      owner !== who.u,
      owner !== who.u
        ? `  the tables belong to ${owner}, not to this login (it cannot drop them)`
        : "  this login OWNS the tables, so it can drop them. Use oidc_app for the running service",
    );

  const migrations = await client.query<{ name: string }>("select name from schema_migrations order by name").catch(() => null);
  line(
    !!migrations && migrations.rows.length > 0,
    migrations
      ? `migrations applied: ${migrations.rows.map((r) => r.name).join(", ")}`
      : "no migration record yet: run `npm run db:migrate`",
  );
} catch (error) {
  console.error(`could not check: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}

console.log(problems === 0 ? "\nAll good." : `\n${problems} thing(s) to fix, listed above.`);
process.exit(problems === 0 ? 0 : 1);
