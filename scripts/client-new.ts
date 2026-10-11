/**
 * Adds an app to `clients.json` and makes its secret, so registering an app is one command.
 *
 *   npm run client:new -- monkeytype --redirect https://monkeytype.fossclub.tech/auth/callback --members-only
 *
 * Options:
 *   --redirect <address>    where the app receives the sign in code (repeat for more than one). Required.
 *   --logout <address>      where people land after signing out (default: the home page of the first redirect address's site)
 *   --name "<text>"         shown on the sign in pages (default: made from the id)
 *   --members-only          only club members may use it
 *   --public                an app with no server that can keep a secret (PKCE only): no secret is made
 *   --untrusted             not one of the club's own apps: people are asked to approve it
 *
 * It changes only `clients.json`. The secret is printed once and is not stored by this script: it goes into the environment of the service.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import prettier from "prettier";
import { loadClients, newClientEntry, secretVariable } from "../src/clients.js";

const FILE = new URL("../clients.json", import.meta.url);
const ISSUER = process.env.ISSUER ?? "https://oidc.fossclub.tech";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    redirect: { type: "string", multiple: true },
    logout: { type: "string", multiple: true },
    name: { type: "string" },
    "members-only": { type: "boolean" },
    public: { type: "boolean" },
    untrusted: { type: "boolean" },
  },
});

const id = positionals[0];
if (!id || !values.redirect?.length) {
  console.error(
    "usage: npm run client:new -- <id> --redirect <address> [--logout <address>] [--name <text>] [--members-only] [--public] [--untrusted]",
  );
  process.exit(2);
}

const existing = JSON.parse(await readFile(FILE, "utf8")) as { client_id?: string }[];
if (existing.some((c) => c.client_id === id)) {
  console.error(`There is already an app called "${id}" in clients.json.`);
  process.exit(1);
}

const entry = newClientEntry({
  id,
  redirects: values.redirect,
  logout: values.logout,
  name: values.name,
  membersOnly: values["members-only"],
  publicApp: values.public,
  untrusted: values.untrusted,
});

// Held to the rules the running service applies, with a stand-in secret so the check is about everything else.
const secret = entry.type === "confidential" ? randomBytes(48).toString("base64url") : null;
const variable = secretVariable(id);
const check = loadClients([entry], secret ? { [variable.replace(/^CLIENT_SECRET_/, "")]: secret } : {});
if (check.errors.length) {
  console.error("Not added:\n  " + check.errors.join("\n  "));
  process.exit(1);
}

const options = (await prettier.resolveConfig(FILE.pathname)) ?? {};
await writeFile(FILE, await prettier.format(JSON.stringify([...existing, entry], null, 2), { ...options, parser: "json" }));

console.log(`Added "${id}" to clients.json.\n`);
console.log("1. Give the sign in service its secret (Vercel, the OIDC project, Production, Sensitive), then push and let it deploy:\n");
console.log(secret ? `   ${variable}=${secret}\n` : "   (nothing: this is a public app, it has no secret)\n");
console.log("2. Give the app these settings:\n");
console.log(`   Issuer          ${ISSUER}`);
console.log(`   Client id       ${id}`);
if (secret) console.log(`   Client secret   ${secret}`);
console.log("   Scopes          openid profile email club");
console.log("   PKCE            on (S256)");
console.log(`   Callback        ${entry.redirect_uris.join(", ")}`);
if (secret) console.log("\nThe secret is shown only now. If it is lost, make a new one and replace it in both places.");
