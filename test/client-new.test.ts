import { describe, expect, it } from "vitest";
import { loadClients, newClientEntry, secretVariable } from "../src/clients.js";

const secret = "s".repeat(48);

describe("the entry the helper script makes for a new app", () => {
  it("is accepted by the service's own rules, with sensible defaults", () => {
    const entry = newClientEntry({ id: "monkeytype", redirects: ["https://monkeytype.fossclub.tech/auth/callback"] });
    expect(entry).toEqual({
      client_id: "monkeytype",
      client_name: "FOSS Club Monkeytype",
      redirect_uris: ["https://monkeytype.fossclub.tech/auth/callback"],
      post_logout_redirect_uris: ["https://monkeytype.fossclub.tech/"],
      type: "confidential",
      trusted: true,
      require_member: false,
    });
    const loaded = loadClients([entry], { MONKEYTYPE: secret });
    expect(loaded.errors).toEqual([]);
    expect(loaded.policies.get("monkeytype")).toMatchObject({ trusted: true, requireMember: false });
  });

  it("carries the options through", () => {
    const entry = newClientEntry({
      id: "staff-room",
      name: "Staff Room",
      redirects: ["https://staff.fossclub.tech/cb"],
      logout: ["https://staff.fossclub.tech/bye"],
      membersOnly: true,
      untrusted: true,
    });
    expect(entry).toMatchObject({
      client_name: "Staff Room",
      post_logout_redirect_uris: ["https://staff.fossclub.tech/bye"],
      require_member: true,
      trusted: false,
    });
    expect(secretVariable("staff-room")).toBe("CLIENT_SECRET_STAFF_ROOM");
  });

  it("makes a public app that needs no secret", () => {
    const loaded = loadClients([newClientEntry({ id: "spa", redirects: ["https://spa.fossclub.tech/cb"], publicApp: true })], {});
    expect(loaded.errors).toEqual([]);
  });

  it("is refused when the address or the id is not allowed", () => {
    const wildcard = newClientEntry({ id: "bad", redirects: ["https://*.fossclub.tech/cb"] });
    expect(loadClients([wildcard], { BAD: secret }).errors.join(" ")).toMatch(/redirect_uris/);

    const http = newClientEntry({ id: "bad", redirects: ["http://example.com/cb"] });
    expect(loadClients([http], { BAD: secret }).errors.join(" ")).toMatch(/redirect_uris/);

    const badId = newClientEntry({ id: "Bad_Id", redirects: ["https://x.fossclub.tech/cb"] });
    expect(loadClients([badId], { BAD_ID: secret }).errors.join(" ")).toMatch(/client_id/);
  });
});
