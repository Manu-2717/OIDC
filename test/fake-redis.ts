/**
 * A stand in for Upstash's REST API with the real semantics of the few commands this service uses, so UpstashState (and through it the
 * provider's adapter) runs against the actual client library over an actual HTTP request, without a Redis server.
 */

type Value = { kind: "str"; v: string } | { kind: "hash"; v: Map<string, string> } | { kind: "set"; v: Set<string> };

export class FakeRedis {
  private data = new Map<string, { value: Value; expiresAt: number | null }>();
  readonly commands: string[] = [];

  private live(key: string) {
    const item = this.data.get(key);
    if (item && item.expiresAt !== null && item.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return item;
  }

  ttl(key: string) {
    const item = this.live(key);
    return item ? (item.expiresAt === null ? -1 : Math.ceil((item.expiresAt - Date.now()) / 1000)) : -2;
  }

  size() {
    return [...this.data.keys()].filter((k) => this.live(k)).length;
  }

  keys() {
    return [...this.data.keys()].filter((k) => this.live(k));
  }

  private run(cmd: string[]): unknown {
    const [name, ...a] = cmd;
    const op = String(name).toUpperCase();
    this.commands.push(op);
    const key = a[0]!;
    switch (op) {
      case "PING":
        return "PONG";
      case "GET": {
        const item = this.live(key);
        return item && item.value.kind === "str" ? item.value.v : null;
      }
      case "MGET": {
        return a.map((k) => {
          const item = this.live(k);
          return item && item.value.kind === "str" ? item.value.v : null;
        });
      }
      case "GETDEL": {
        const item = this.live(key);
        this.data.delete(key);
        return item && item.value.kind === "str" ? item.value.v : null;
      }
      case "SET": {
        const exIndex = a.findIndex((x) => x.toUpperCase() === "EX");
        this.data.set(key, {
          value: { kind: "str", v: a[1]! },
          expiresAt: exIndex >= 0 ? Date.now() + Number(a[exIndex + 1]) * 1000 : null,
        });
        return "OK";
      }
      case "DEL": {
        let n = 0;
        for (const k of a) if (this.live(k)) n += this.data.delete(k) ? 1 : 0;
        return n;
      }
      case "INCR": {
        const item = this.live(key);
        const next = item && item.value.kind === "str" ? Number(item.value.v) + 1 : 1;
        this.data.set(key, { value: { kind: "str", v: String(next) }, expiresAt: item?.expiresAt ?? null });
        return next;
      }
      case "HSET": {
        let item = this.live(key);
        if (!item || item.value.kind !== "hash") {
          item = { value: { kind: "hash", v: new Map() }, expiresAt: null };
          this.data.set(key, item);
        }
        let added = 0;
        for (let i = 1; i < a.length; i += 2) {
          if (!(item.value as { v: Map<string, string> }).v.has(a[i]!)) added++;
          (item.value as { v: Map<string, string> }).v.set(a[i]!, a[i + 1]!);
        }
        return added;
      }
      case "HGETALL": {
        const item = this.live(key);
        return item && item.value.kind === "hash" ? [...item.value.v].flat() : [];
      }
      case "SADD": {
        let item = this.live(key);
        if (!item || item.value.kind !== "set") {
          item = { value: { kind: "set", v: new Set() }, expiresAt: null };
          this.data.set(key, item);
        }
        let added = 0;
        for (const m of a.slice(1)) {
          if (!(item.value as { v: Set<string> }).v.has(m)) added++;
          (item.value as { v: Set<string> }).v.add(m);
        }
        return added;
      }
      case "SMEMBERS": {
        const item = this.live(key);
        return item && item.value.kind === "set" ? [...item.value.v] : [];
      }
      case "EXPIRE": {
        const item = this.live(key);
        if (!item) return 0;
        const mode = a[2]?.toUpperCase();
        const next = Date.now() + Number(a[1]) * 1000;
        if (mode === "NX" && item.expiresAt !== null) return 0;
        // As on Redis: a key with no expiry counts as an infinite one, so GT never applies to it.
        if (mode === "GT" && (item.expiresAt === null || next <= item.expiresAt)) return 0;
        item.expiresAt = next;
        return 1;
      }
      default:
        throw new Error(`fake redis: unsupported command ${op}`);
    }
  }

  /** Handles one HTTP request the way Upstash does. */
  handle(path: string, body: string, base64: boolean) {
    const encode = (value: unknown): unknown =>
      typeof value === "string" && base64 ? Buffer.from(value).toString("base64") : Array.isArray(value) ? value.map(encode) : value;
    const one = (cmd: string[]) => {
      try {
        return { result: encode(this.run(cmd)) };
      } catch (error) {
        return { error: (error as Error).message };
      }
    };
    const payload = JSON.parse(body) as string[] | string[][];
    if (path.startsWith("/pipeline") || path.startsWith("/multi-exec")) return (payload as string[][]).map(one);
    return one(payload as string[]);
  }
}

/** Routes the Upstash client's requests to `redis` and lets everything else through. Returns a function that undoes it. */
export function installFakeRedis(redis: FakeRedis, host = "redis.test") {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== host) return real(input, init);
    const headers = new Headers(init?.headers);
    const out = redis.handle(url.pathname, String(init?.body ?? "[]"), headers.get("upstash-encoding") === "base64");
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}
