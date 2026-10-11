import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapter } from "../src/adapter.js";
import { GRANT_INDEX_TTL, LIFETIMES } from "../src/lifetimes.js";
import { MemoryState, UpstashState, type StateBackend } from "../src/state.js";
import { FakeRedis, installFakeRedis } from "./fake-redis.js";

const redis = new FakeRedis();
let uninstall: () => void;
beforeAll(() => {
  uninstall = installFakeRedis(redis);
});
afterAll(() => uninstall());

const backends: [string, () => StateBackend][] = [
  ["memory", () => new MemoryState()],
  ["upstash (over HTTP, against a fake server)", () => new UpstashState("https://redis.test", "token")],
];

describe.each(backends)("the state store: %s", (_name, make) => {
  const prefix = () => `t:${Math.random().toString(36).slice(2)}:`;

  it("stores and removes values, and a value can be taken exactly once", async () => {
    const s = make();
    const p = prefix();
    await s.exec([{ t: "set", key: `${p}a`, value: "one", ex: 60 }]);
    expect(await s.get(`${p}a`)).toBe("one");
    expect(await s.getdel(`${p}a`)).toBe("one");
    expect(await s.getdel(`${p}a`)).toBeNull();
    expect(await s.get(`${p}a`)).toBeNull();
  });

  it("returns exactly the string that was written, even when it looks like JSON", async () => {
    const s = make();
    const p = prefix();
    for (const value of ['{"a":1}', "123", "true", "null", '"quoted"', "[1,2]"]) {
      await s.exec([{ t: "set", key: `${p}v`, value, ex: 60 }]);
      expect(await s.get(`${p}v`)).toBe(value);
    }
    await s.exec([{ t: "hset", key: `${p}h`, fields: { p: '{"x":[1,2,3]}', c: "17" } }]);
    expect(await s.hgetall(`${p}h`)).toEqual({ p: '{"x":[1,2,3]}', c: "17" });
  });

  it("counts requests in a window", async () => {
    const s = make();
    const key = `${prefix()}rl`;
    expect(await s.incrWindow(key, 60)).toBe(1);
    expect(await s.incrWindow(key, 60)).toBe(2);
    expect(await s.incrWindow(key, 60)).toBe(3);
  });

  it("answers ping", async () => {
    expect(await make().ping()).toBe(true);
  });
});

describe.each(backends)("the provider's storage adapter on %s", (_name, make) => {
  const setup = () => {
    const state = make();
    const Adapter = createAdapter(state);
    return { state, Adapter };
  };
  const id = () => `id-${Math.random().toString(36).slice(2)}`;

  it("saves and finds a record, and consuming it is visible", async () => {
    const { Adapter } = setup();
    const codes = new Adapter("AuthorizationCode");
    const key = id();
    await codes.upsert(key, { accountId: "acc", clientId: "quiz", grantId: "g1" } as never, 60);
    expect(await codes.find(key)).toMatchObject({ accountId: "acc", clientId: "quiz", grantId: "g1" });
    expect((await codes.find(key))?.consumed).toBeUndefined();
    await codes.consume(key);
    expect((await codes.find(key))?.consumed).toBeGreaterThan(0);
    // The payload is still there after being consumed: the provider uses that to notice a replayed code.
    expect(await codes.find(key)).toMatchObject({ accountId: "acc" });
  });

  it("finds a session by its uid", async () => {
    const { Adapter } = setup();
    const sessions = new Adapter("Session");
    const key = id();
    const uid = id();
    await sessions.upsert(key, { uid, accountId: "acc" } as never, 600);
    expect(await sessions.findByUid(uid)).toMatchObject({ accountId: "acc", uid });
    expect(await sessions.findByUid("nope")).toBeUndefined();
  });

  it("destroys a record", async () => {
    const { Adapter } = setup();
    const tokens = new Adapter("AccessToken");
    const key = id();
    await tokens.upsert(key, { accountId: "acc" } as never, 600);
    await tokens.destroy(key);
    expect(await tokens.find(key)).toBeUndefined();
  });

  it("removes everything that belongs to a grant at once", async () => {
    const { Adapter } = setup();
    const grant = id();
    const access = new Adapter("AccessToken");
    const codes = new Adapter("AuthorizationCode");
    const other = new Adapter("AccessToken");
    const [a, c, o] = [id(), id(), id()];
    await access.upsert(a, { grantId: grant, accountId: "acc" } as never, 600);
    await codes.upsert(c, { grantId: grant, accountId: "acc" } as never, 60);
    await other.upsert(o, { grantId: "another-grant", accountId: "acc" } as never, 600);

    await access.revokeByGrantId(grant);

    expect(await access.find(a)).toBeUndefined();
    expect(await codes.find(c)).toBeUndefined();
    expect(await other.find(o)).toMatchObject({ grantId: "another-grant" });
  });

  it("refuses to store something with no lifetime", async () => {
    const { Adapter } = setup();
    await expect(new Adapter("Session").upsert(id(), { accountId: "x" } as never, undefined)).rejects.toThrow(/lifetime/);
    await expect(new Adapter("Session").upsert(id(), { accountId: "x" } as never, 0)).rejects.toThrow(/lifetime/);
  });

  it("does not spend a call looking up apps (they are registered in code)", async () => {
    const { Adapter } = setup();
    expect(await new Adapter("Client").find("anything")).toBeUndefined();
  });
});

describe("on Redis itself", () => {
  const state = new UpstashState("https://redis.test", "token");
  const Adapter = createAdapter(state);

  it("gives every record a lifetime, and the grant's index one that is never shorter than its members", async () => {
    const grant = `grant-${Math.random().toString(36).slice(2)}`;
    const access = new Adapter("AccessToken");
    const interaction = new Adapter("Interaction");
    await access.upsert("short", { grantId: grant } as never, 60);
    await interaction.upsert("long", { grantId: grant } as never, 900);
    await access.upsert("short2", { grantId: grant } as never, 30);

    expect(redis.ttl("oidc:AccessToken:short")).toBeGreaterThan(0);
    expect(redis.ttl("oidc:Interaction:long")).toBeGreaterThan(0);
    // The index lives at least as long as the longest record that can be in it (thirty minutes), whatever order they were written in.
    expect(redis.ttl(`oidc:grant:${grant}`)).toBeGreaterThanOrEqual(GRANT_INDEX_TTL - 5);
  });

  it("never leaves a key without a lifetime", async () => {
    const before = redis.keys();
    const s = new Adapter("Session");
    await s.upsert("a", { uid: "uid-a", grantId: "gg" } as never, 100);
    await s.consume("a");
    await s.consume("gone"); // a record that is already gone must not come back immortal
    for (const key of redis.keys().filter((k) => !before.includes(k))) expect(redis.ttl(key), key).toBeGreaterThan(0);
  });

  it("uses one transaction per write", async () => {
    redis.commands.length = 0;
    await new Adapter("AccessToken").upsert("tx", { grantId: "gtx", uid: undefined } as never, 60);
    // A MULTI/EXEC is a single request: the commands inside it are the only things recorded, with no stray reads.
    expect(redis.commands).not.toContain("GET");
    expect(redis.commands).toEqual(["SET", "SADD", "EXPIRE"]);
  });
});

describe("lifetimes", () => {
  it("keep the grant index longer than every record that can be in it", () => {
    for (const model of ["AccessToken", "AuthorizationCode", "Interaction"] as const) {
      expect(LIFETIMES[model], model).toBeLessThanOrEqual(GRANT_INDEX_TTL);
    }
  });

  it("are short for anything an app holds, and never zero", () => {
    expect(LIFETIMES.AccessToken).toBeLessThanOrEqual(15 * 60);
    expect(LIFETIMES.IdToken).toBeLessThanOrEqual(15 * 60);
    expect(LIFETIMES.AuthorizationCode).toBeLessThanOrEqual(60);
    for (const [name, seconds] of Object.entries(LIFETIMES)) expect(seconds, name).toBeGreaterThan(0);
  });
});
