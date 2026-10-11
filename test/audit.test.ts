import { beforeEach, describe, expect, it, vi } from "vitest";

const waitUntil = vi.fn();
let platformFails = false;
vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    if (platformFails) throw new Error("no request context");
    return waitUntil(p);
  },
}));

const { PgAuditLog } = await import("../src/audit.js");

const pool = (query: (sql: string, params?: unknown[]) => Promise<unknown>) => ({ query }) as never;

describe("writing the audit log", () => {
  beforeEach(() => {
    waitUntil.mockReset();
    platformFails = false;
  });

  it("hands the write to the platform, so it is finished even if nobody waits for it", async () => {
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => (finish = resolve));
    const log = new PgAuditLog(pool(() => slow));

    const written = log.record({ event: "logout", clientId: "quiz" });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0]![0]).toBeInstanceOf(Promise);

    finish();
    await expect(written).resolves.toBeUndefined();
  });

  it("never fails the caller when the database is down", async () => {
    const log = new PgAuditLog(pool(() => Promise.reject(new Error("db down"))));
    await expect(log.record({ event: "login.success" })).resolves.toBeUndefined();
    // and the platform was still given a promise that settles, rather than one that would raise an unhandled rejection
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
  });

  it("carries on when the platform call itself throws", async () => {
    platformFails = true;
    const log = new PgAuditLog(pool(() => Promise.resolve({ rows: [] })));
    await expect(log.record({ event: "logout" })).resolves.toBeUndefined();
  });
});
