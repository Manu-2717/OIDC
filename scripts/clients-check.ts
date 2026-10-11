/**
 * Checks clients.json the way the service will read it, and fails if any app would not be registered. CI runs it, so a broken redirect
 * address or a missing secret is caught before it is deployed.
 *
 *   npm run clients:check              checks the file (secrets are only required when CLIENT_SECRET_* are set, see below)
 *   CHECK_SECRETS=1 npm run clients:check   also requires every confidential app's secret to be present (what a deployment must have)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadClients, secretVariable } from "../src/clients.js";

const raw = JSON.parse(readFileSync(join(import.meta.dirname, "..", "clients.json"), "utf8")) as unknown;
const secrets: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) {
  const m = /^CLIENT_SECRET_([A-Z0-9_]+)$/.exec(name);
  if (m?.[1] && value) secrets[m[1]] = value;
}

const result = loadClients(raw, secrets);
const requireSecrets = process.env.CHECK_SECRETS === "1";
const problems = result.errors.filter((e) => requireSecrets || !/no secret|shorter than 32/.test(e));

for (const meta of result.metadata) console.log(`  ok     ${meta.client_id}`);
for (const problem of problems) console.error(`  FAIL   ${problem}`);
if (!requireSecrets) {
  const waiting = result.errors.length - problems.length;
  if (waiting > 0)
    console.log(`  (${waiting} app(s) are waiting for a secret: set ${secretVariable("<id>")} and run with CHECK_SECRETS=1)`);
}
if (problems.length > 0) process.exit(1);
console.log(`${result.metadata.length} app(s) registered.`);
