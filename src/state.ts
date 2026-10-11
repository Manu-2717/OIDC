import { Redis } from "@upstash/redis";

/**
 * Short-lived state: sessions, codes, tokens, sign-in attempts, rate limit counters and small caches. All of it expires on its own, and none
 * of it is precious: if it is lost, people sign in again. (What must survive lives in Postgres.)
 *
 * One small interface with two implementations, so the code that uses it (the provider's storage adapter, the rate limiter, the GitHub sign-in
 * bookkeeping) is the same code in production and in tests.
 */

export type Op =
  | { t: "hset"; key: string; fields: Record<string, string> }
  | { t: "expire"; key: string; seconds: number; mode?: "NX" | "GT" }
  | { t: "sadd"; key: string; member: string }
  | { t: "set"; key: string; value: string; ex: number }
  | { t: "del"; key: string };

export interface StateBackend {
  /** Applies the operations together (as one transaction on Redis). */
  exec(ops: Op[]): Promise<void>;
  hgetall(key: string): Promise<Record<string, string> | null>;
  get(key: string): Promise<string | null>;
  /** Several values in one request, in the order asked for. */
  mget(keys: string[]): Promise<(string | null)[]>;
  /** Reads and removes in one step, so a value can be used exactly once. */
  getdel(key: string): Promise<string | null>;
  smembers(key: string): Promise<string[]>;
  /** Counts one more in a fixed window that starts with the first count, and returns the count so far. */
  incrWindow(key: string, windowSeconds: number): Promise<number>;
  ping(): Promise<boolean>;
}

/* ------------------------------------------------------------------------------------------------ Upstash */

export class UpstashState implements StateBackend {
  private readonly redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({
      url,
      token,
      // Everything is stored and read back as the exact string that was written. (The client would otherwise try to guess JSON.)
      automaticDeserialization: false,
      retry: { retries: 2, backoff: (attempt) => 60 * 2 ** attempt },
      signal: () => AbortSignal.timeout(4_000),
    });
  }

  async exec(ops: Op[]): Promise<void> {
    if (ops.length === 0) return;
    const tx = this.redis.multi();
    for (const op of ops) {
      switch (op.t) {
        case "hset":
          tx.hset(op.key, op.fields);
          break;
        case "expire":
          if (op.mode) tx.expire(op.key, op.seconds, op.mode);
          else tx.expire(op.key, op.seconds);
          break;
        case "sadd":
          tx.sadd(op.key, op.member);
          break;
        case "set":
          tx.set(op.key, op.value, { ex: op.ex });
          break;
        case "del":
          tx.del(op.key);
          break;
      }
    }
    await tx.exec();
  }

  async hgetall(key: string) {
    // With automatic deserialization off the client hands back what Redis sent, which for a hash is a flat list of field, value, field,
    // value. Turn it into an object here. (An object is also accepted, in case a later version of the client does that itself.)
    const out = (await this.redis.hgetall(key)) as unknown;
    if (Array.isArray(out)) {
      const hash: Record<string, string> = {};
      for (let i = 0; i + 1 < out.length; i += 2) hash[String(out[i])] = String(out[i + 1]);
      return Object.keys(hash).length > 0 ? hash : null;
    }
    if (out && typeof out === "object") {
      const entries = Object.entries(out as Record<string, unknown>).map(([k, v]) => [k, String(v)] as const);
      return entries.length > 0 ? Object.fromEntries(entries) : null;
    }
    return null;
  }

  async get(key: string) {
    return (await this.redis.get<string>(key)) ?? null;
  }

  async mget(keys: string[]) {
    if (keys.length === 0) return [];
    const out = (await this.redis.mget(...keys)) as unknown[];
    return out.map((v) => (v === null || v === undefined ? null : String(v)));
  }

  async getdel(key: string) {
    return (await this.redis.getdel<string>(key)) ?? null;
  }

  async smembers(key: string) {
    return this.redis.smembers(key);
  }

  async incrWindow(key: string, windowSeconds: number) {
    const count = await this.redis.incr(key);
    // One command per request in the usual case: the lifetime is set when a window starts. (NX, and again every so often, so a key whose
    // first expire was lost to a crash still gets one.)
    if (count === 1 || count % 50 === 0) await this.redis.expire(key, windowSeconds, "NX");
    return count;
  }

  async ping() {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------------------------------------ memory */

type Entry = { kind: "str"; value: string } | { kind: "hash"; value: Record<string, string> } | { kind: "set"; value: Set<string> };

/** For tests and for running the service on a laptop with no Redis. Everything is lost when the process ends, which is fine for both. */
export class MemoryState implements StateBackend {
  private readonly data = new Map<string, { entry: Entry; expiresAt: number | null }>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const item = this.data.get(key);
    if (!item) return undefined;
    if (item.expiresAt !== null && item.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return item;
  }

  async exec(ops: Op[]) {
    for (const op of ops) {
      switch (op.t) {
        case "hset": {
          const item = this.live(op.key);
          if (item && item.entry.kind === "hash") Object.assign(item.entry.value, op.fields);
          else this.data.set(op.key, { entry: { kind: "hash", value: { ...op.fields } }, expiresAt: null });
          break;
        }
        case "expire": {
          const item = this.live(op.key);
          if (!item) break;
          const next = this.now() + op.seconds * 1000;
          if (op.mode === "NX" && item.expiresAt !== null) break;
          // A key with no lifetime counts as an infinite one for GT, as on Redis.
          if (op.mode === "GT" && (item.expiresAt === null || next <= item.expiresAt)) break;
          item.expiresAt = next;
          break;
        }
        case "sadd": {
          const item = this.live(op.key);
          if (item && item.entry.kind === "set") item.entry.value.add(op.member);
          else this.data.set(op.key, { entry: { kind: "set", value: new Set([op.member]) }, expiresAt: null });
          break;
        }
        case "set":
          this.data.set(op.key, { entry: { kind: "str", value: op.value }, expiresAt: this.now() + op.ex * 1000 });
          break;
        case "del":
          this.data.delete(op.key);
          break;
      }
    }
  }

  async hgetall(key: string) {
    const item = this.live(key);
    return item && item.entry.kind === "hash" ? { ...item.entry.value } : null;
  }

  async get(key: string) {
    const item = this.live(key);
    return item && item.entry.kind === "str" ? item.entry.value : null;
  }

  async mget(keys: string[]) {
    return Promise.all(keys.map((k) => this.get(k)));
  }

  async getdel(key: string) {
    const value = await this.get(key);
    this.data.delete(key);
    return value;
  }

  async smembers(key: string) {
    const item = this.live(key);
    return item && item.entry.kind === "set" ? [...item.entry.value] : [];
  }

  async incrWindow(key: string, windowSeconds: number) {
    const item = this.live(key);
    if (item && item.entry.kind === "str") {
      const count = Number(item.entry.value) + 1;
      item.entry.value = String(count);
      return count;
    }
    this.data.set(key, { entry: { kind: "str", value: "1" }, expiresAt: this.now() + windowSeconds * 1000 });
    return 1;
  }

  async ping() {
    return true;
  }

  /** How many keys are alive, for tests. */
  size() {
    let n = 0;
    for (const key of [...this.data.keys()]) if (this.live(key)) n++;
    return n;
  }
}
