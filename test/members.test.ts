import { describe, expect, it } from "vitest";
import { MemberDirectory } from "../src/members.js";
import { MemoryState } from "../src/state.js";
import { FakeMemberSource } from "./helpers.js";

describe("how long a membership answer is remembered", () => {
  const make = () => {
    let now = 1_000_000;
    const state = new MemoryState(() => now);
    const source = new FakeMemberSource();
    const directory = new MemberDirectory(source, state);
    return { source, directory, advance: (seconds: number) => (now += seconds * 1000) };
  };
  const unknown = { member: false, role: null };

  it("remembers a member for ten minutes", async () => {
    const { source, directory, advance } = make();
    source.members.set("1", { member: true, role: "MAINTAINER" });
    await directory.resolve("1", unknown);
    advance(300);
    await directory.resolve("1", unknown);
    expect(source.lookups).toBe(1);
    advance(400);
    await directory.resolve("1", unknown);
    expect(source.lookups).toBe(2);
  });

  it("asks again within half a minute about someone who is not a member, so a person who has just joined gets in", async () => {
    const { source, directory, advance } = make();
    expect((await directory.resolve("2", unknown)).member).toBe(false);
    expect((await directory.resolve("2", unknown)).member).toBe(false);
    expect(source.lookups).toBe(1);

    source.members.set("2", { member: true, role: "MAINTAINER" });
    advance(31);
    expect((await directory.resolve("2", unknown)).member).toBe(true);
    expect(source.lookups).toBe(2);
  });
});
