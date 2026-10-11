import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountService, MemoryAccountRepo } from "../src/accounts.js";
import { createApp } from "../src/create-app.js";
import { MemoryAuditLog } from "../src/audit.js";
import { loadClients } from "../src/clients.js";
import type { Config } from "../src/config.js";
import { MemberDirectory } from "../src/members.js";
import { UpstashState } from "../src/state.js";
import { FakeRedis, installFakeRedis } from "./fake-redis.js";
import { Browser, FakeGitHub, FakeMemberSource, SECRETS, TEST_CLIENTS, exchangeCode, signInTo, type Harness } from "./helpers.js";

/**
 * Every Redis command is a network round trip (and each one inside a transaction counts), so how many a sign in uses decides how quick it
 * is and how much load it puts on Redis. This pins that number, so a change that quietly doubles it fails here.
 *
 * The limits are the measured number plus a little room. If one is exceeded on purpose, raise it and say why in the commit.
 */
describe("how many Redis commands a sign in uses", () => {
  const redis = new FakeRedis();
  let undo: () => void;
  let h: Harness;
  let close: () => Promise<void>;

  beforeAll(async () => {
    undo = installFakeRedis(redis);
    const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
    const jwk = await exportJWK(privateKey);
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const state = new UpstashState("https://redis.test", "t");
    const github = new FakeGitHub();
    const members = new FakeMemberSource();
    github.addPerson("meter");
    members.members.set(github.people.get("meter")!.id, { member: true, role: null });
    const config: Config = {
      issuer,
      production: false,
      secureCookies: false,
      databaseUrl: "",
      mainDbUrl: null,
      redisUrl: "",
      redisToken: "",
      github: { clientId: "a", clientSecret: "b" },
      jwks: { keys: [{ ...jwk, kid: "k", use: "sig", alg: "RS256" } as never] },
      cookieKeys: ["k".repeat(40)],
      csrfSecret: "c".repeat(40),
      membershipInfoUrl: "https://example.test",
      clientSecrets: SECRETS,
    };
    const accounts = new AccountService(new MemoryAccountRepo(), state, new MemberDirectory(members, state));
    server.on(
      "request",
      createApp({
        config,
        state,
        accounts,
        audit: new MemoryAuditLog(),
        github,
        clients: loadClients(TEST_CLIENTS, SECRETS),
        readiness: {},
      }),
    );
    h = { issuer, github } as unknown as Harness;
    close = () => new Promise<void>((r) => server.close(() => r()));
  });

  afterAll(async () => {
    undo();
    await close();
  });

  const used = async (fn: () => Promise<void>) => {
    const before = redis.commands.length;
    await fn();
    return redis.commands.length - before;
  };

  it("stays within budget, and takes fewer once someone is signed in", async () => {
    const browser = new Browser();

    const first = await used(async () => {
      const r = await signInTo(h, browser, { clientId: "quiz", githubLogin: "meter" });
      await exchangeCode(h, { clientId: "quiz", code: r.code!, verifier: r.verifier });
    });
    const second = await used(async () => {
      const r = await signInTo(h, browser, { clientId: "forums" });
      await exchangeCode(h, { clientId: "forums", code: r.code!, verifier: r.verifier });
    });
    const quiet = await used(async () => {
      await signInTo(h, browser, { clientId: "quiz", prompt: "none" });
    });

    console.log(`redis commands: first sign in ${first}, another app ${second}, quiet check ${quiet}`);

    expect(first).toBeLessThanOrEqual(48);
    expect(second).toBeLessThanOrEqual(23);
    expect(quiet).toBeLessThanOrEqual(12);
    expect(second).toBeLessThan(first);
  });

  it("leaves nothing behind without a lifetime", () => {
    for (const key of redis.keys()) expect(redis.ttl(key), key).toBeGreaterThan(0);
  });
});
