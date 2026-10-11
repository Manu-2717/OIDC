import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadClients, secretVariable } from "../src/clients.js";
import { ConfigError, loadConfig } from "../src/config.js";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" });
const jwks = JSON.stringify({ keys: [{ ...key, kid: "k1", use: "sig", alg: "RS256" }] });

const good = {
  ISSUER: "https://oidc.fossclub.tech",
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://x",
  UPSTASH_REDIS_REST_URL: "https://redis.example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "t",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  OIDC_JWKS: jwks,
  COOKIE_KEYS: "a".repeat(40),
  CSRF_SECRET: "c".repeat(40),
};

describe("configuration", () => {
  it("accepts a complete, strong configuration", () => {
    const c = loadConfig({ ...good, CLIENT_SECRET_QUIZ: "q".repeat(40) });
    expect(c.issuer).toBe("https://oidc.fossclub.tech");
    expect(c.secureCookies).toBe(true);
    expect(c.clientSecrets).toEqual({ QUIZ: "q".repeat(40) });
  });

  it("removes a trailing slash from the issuer, so it is the same string everywhere", () => {
    expect(loadConfig({ ...good, ISSUER: "https://oidc.fossclub.tech/" }).issuer).toBe("https://oidc.fossclub.tech");
  });

  it.each([
    ["an http issuer", { ISSUER: "http://oidc.fossclub.tech" }, /https/],
    ["an issuer with a path", { ISSUER: "https://oidc.fossclub.tech/oidc" }, /bare origin/],
    ["localhost in production", { ISSUER: "http://localhost:3000" }, /localhost/],
    ["a short cookie key", { COOKIE_KEYS: "short" }, /COOKIE_KEYS/],
    ["one short key among several", { COOKIE_KEYS: `${"a".repeat(40)},short` }, /COOKIE_KEYS/],
    ["a short CSRF secret", { CSRF_SECRET: "short" }, /CSRF_SECRET/],
    ["no signing key", { OIDC_JWKS: "" }, /OIDC_JWKS/],
    ["a signing key that is not JSON", { OIDC_JWKS: "nope" }, /JSON/],
    ["a public key only", { OIDC_JWKS: JSON.stringify({ keys: [{ kty: "RSA", kid: "k", n: "x", e: "AQAB" }] }) }, /private/],
    ["a key without a kid", { OIDC_JWKS: JSON.stringify({ keys: [{ ...key, use: "sig" }] }) }, /kid/],
    ["an elliptic key (only RS256 is used)", { OIDC_JWKS: JSON.stringify({ keys: [{ kty: "EC", kid: "k", d: "x" }] }) }, /RSA/],
  ])("refuses %s", (_label, change, message) => {
    expect(() => loadConfig({ ...good, ...change })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, ...change })).toThrow(message);
  });

  it("allows http for localhost outside production, with plain cookie names", () => {
    const c = loadConfig({ ...good, NODE_ENV: "development", ISSUER: "http://localhost:3000" });
    expect(c.secureCookies).toBe(false);
  });
});

describe("the list of apps", () => {
  const secrets = { QUIZ: "q".repeat(40) };
  const app = { client_id: "quiz", client_name: "Quiz", redirect_uris: ["https://quiz.fossclub.tech/cb"] };

  it("registers a valid app with its secret", () => {
    const r = loadClients([app], secrets);
    expect(r.errors).toEqual([]);
    expect(r.metadata[0]).toMatchObject({
      client_id: "quiz",
      client_secret: "q".repeat(40),
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(r.policies.get("quiz")).toMatchObject({ trusted: true, requireMember: false });
  });

  it("registers a public app with no secret and no client authentication", () => {
    const r = loadClients([{ ...app, client_id: "spa", type: "public" }], {});
    expect(r.errors).toEqual([]);
    expect(r.metadata[0]).toMatchObject({ token_endpoint_auth_method: "none" });
    expect(r.metadata[0]).not.toHaveProperty("client_secret");
  });

  it.each([
    ["a wildcard", ["https://*.fossclub.tech/cb"]],
    ["plain http on a real host", ["http://quiz.fossclub.tech/cb"]],
    ["a fragment", ["https://quiz.fossclub.tech/cb#x"]],
    ["a relative address", ["/cb"]],
    ["a javascript address", ["javascript:alert(1)"]],
    ["nothing", []],
  ])("refuses an app with %s as its redirect address", (_label, redirect_uris) => {
    const r = loadClients([{ ...app, redirect_uris }], secrets);
    expect(r.metadata).toHaveLength(0);
    expect(r.errors[0]).toMatch(/quiz/);
  });

  it("allows http for localhost, for developing an app", () => {
    expect(loadClients([{ ...app, redirect_uris: ["http://localhost:3000/cb", "http://127.0.0.1:3000/cb"] }], secrets).errors).toEqual([]);
  });

  it("does not register a confidential app that has no secret, or a weak one", () => {
    expect(loadClients([app], {}).errors[0]).toMatch(new RegExp(secretVariable("quiz")));
    expect(loadClients([app], { QUIZ: "short" }).errors[0]).toMatch(/shorter than 32/);
  });

  it("refuses duplicates and bad ids, and keeps the good ones", () => {
    const r = loadClients([app, app, { ...app, client_id: "Bad Id!" }, { ...app, client_id: "forums" }], {
      ...secrets,
      FORUMS: "f".repeat(40),
    });
    expect(r.metadata.map((m) => m.client_id)).toEqual(["quiz", "forums"]);
    expect(r.errors).toHaveLength(2);
  });

  it("turns a client id into the name of its secret variable", () => {
    expect(secretVariable("staff-room")).toBe("CLIENT_SECRET_STAFF_ROOM");
  });
});
