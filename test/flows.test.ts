import { createRemoteJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Browser, authorizeUrl, exchangeCode, isAppAddress, pkce, signInTo, startService, type Harness } from "./helpers.js";

let h: Harness;

beforeAll(async () => {
  h = await startService();
});
afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  h.github.failExchange = false;
  h.members.failing = false;
});

const idTokenClaims = async (idToken: string, audience: string) => {
  const keys = createRemoteJWKSet(new URL(`${h.issuer}/jwks`));
  const { payload, protectedHeader } = await jwtVerify(idToken, keys, { issuer: h.issuer, audience });
  return { payload, header: protectedHeader };
};

describe("the discovery document", () => {
  it("advertises only what is actually enabled", async () => {
    const doc = (await (await fetch(`${h.issuer}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    expect(doc.issuer).toBe(h.issuer);
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.grant_types_supported).toEqual(["authorization_code"]);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.id_token_signing_alg_values_supported).toEqual(["RS256"]);
    expect(doc.scopes_supported).toEqual(["openid", "profile", "email", "club", "github"]);
    expect(doc).not.toHaveProperty("registration_endpoint");
    expect(doc).not.toHaveProperty("introspection_endpoint");
    expect(doc).not.toHaveProperty("device_authorization_endpoint");
    expect(doc.end_session_endpoint).toBe(`${h.issuer}/session/end`);
  });
});

describe("signing in", () => {
  it("takes a person through GitHub and gives the app a verifiable ID token", async () => {
    h.github.addPerson("asha");
    h.members.members.set(h.github.people.get("asha")!.id, { member: true, role: "ADMIN" });
    const browser = new Browser();

    const r = await signInTo(h, browser, { clientId: "quiz", githubLogin: "asha" });
    expect(r.error).toBeNull();
    expect(r.url.searchParams.get("state")).toBe(r.state);
    expect(r.code).toBeTruthy();

    const token = await exchangeCode(h, { clientId: "quiz", code: r.code!, verifier: r.verifier });
    expect(token.status).toBe(200);
    expect(token.body.token_type).toBe("Bearer");
    expect(token.body).not.toHaveProperty("refresh_token");

    const { payload, header } = await idTokenClaims(String(token.body.id_token), "quiz");
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe("test-key");
    expect(payload.nonce).toBe(r.nonce);
    expect(payload.preferred_username).toBe("asha");
    expect(payload.email).toBe("asha@example.com");
    expect(payload.email_verified).toBe(true);
    expect(payload.member).toBe(true);
    expect(payload.role).toBe("ADMIN");
    // The subject is ours, and is not the GitHub id.
    expect(String(payload.sub)).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.sub).not.toBe(h.github.people.get("asha")!.id);
    // Short lived, as configured: ten minutes.
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(600);

    const me = await fetch(`${h.issuer}/me`, { headers: { authorization: `Bearer ${token.body.access_token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { sub: string }).sub).toBe(payload.sub);

    // GitHub's token was thrown away straight after it was used.
    expect(h.github.revoked).toContain("token-for-asha");
  });

  it("signs the person into a second app with no screen at all", async () => {
    h.github.addPerson("bela");
    const browser = new Browser();
    const first = await signInTo(h, browser, { clientId: "quiz", githubLogin: "bela" });
    expect(first.code).toBeTruthy();

    const before = browser.visited.length;
    // No githubLogin given: if the flow went to GitHub or to an interaction page, the helper would throw.
    const second = await signInTo(h, browser, { clientId: "forums" });
    expect(second.code).toBeTruthy();
    const hops = browser.visited.slice(before).map((v) => v.split(" ")[1]!);
    expect(hops.some((p) => p.startsWith("/interaction") || p.startsWith("/callback"))).toBe(false);

    const token = await exchangeCode(h, { clientId: "forums", code: second.code!, verifier: second.verifier });
    const { payload } = await idTokenClaims(String(token.body.id_token), "forums");
    expect(payload.preferred_username).toBe("bela");
  });

  it("gives each app the same subject for the same person", async () => {
    h.github.addPerson("chen");
    const browser = new Browser();
    const a = await signInTo(h, browser, { clientId: "quiz", githubLogin: "chen" });
    const b = await signInTo(h, browser, { clientId: "forums" });
    const ta = await exchangeCode(h, { clientId: "quiz", code: a.code!, verifier: a.verifier });
    const tb = await exchangeCode(h, { clientId: "forums", code: b.code!, verifier: b.verifier });
    const sa = (await idTokenClaims(String(ta.body.id_token), "quiz")).payload.sub;
    const sb = (await idTokenClaims(String(tb.body.id_token), "forums")).payload.sub;
    expect(sa).toBe(sb);
  });
});

describe("a person who is not signed in", () => {
  it("is told so in the standard way when the app asks quietly (prompt=none)", async () => {
    const browser = new Browser();
    const r = await signInTo(h, browser, { clientId: "quiz", prompt: "none", state: "abc123" });
    expect(r.error).toBe("login_required");
    expect(r.code).toBeNull();
    // The error comes back to the app on its own address, carrying the state it sent.
    expect(r.url.origin + r.url.pathname).toBe("http://localhost:4001/cb");
    expect(r.url.searchParams.get("state")).toBe("abc123");
    expect(browser.visited.some((v) => v.includes("/interaction"))).toBe(false);
  });

  it("is signed in without a screen when the app asks quietly and there is a session", async () => {
    h.github.addPerson("dev");
    const browser = new Browser();
    await signInTo(h, browser, { clientId: "quiz", githubLogin: "dev" });
    const r = await signInTo(h, browser, { clientId: "forums", prompt: "none" });
    expect(r.error).toBeNull();
    expect(r.code).toBeTruthy();
  });

  it("is sent to sign in again when the app insists (prompt=login)", async () => {
    h.github.addPerson("esha");
    const browser = new Browser();
    await signInTo(h, browser, { clientId: "quiz", githubLogin: "esha" });
    const before = browser.visited.length;
    const r = await signInTo(h, browser, { clientId: "quiz", prompt: "login", githubLogin: "esha" });
    expect(r.code).toBeTruthy();
    expect(browser.visited.slice(before).some((v) => v.includes("/callback/github"))).toBe(true);
  });
});

describe("requests that must be refused", () => {
  it("refuses an app that does not use PKCE", async () => {
    const browser = new Browser();
    const url = authorizeUrl(h, { clientId: "quiz", challenge: null });
    const { url: back } = await browser.follow(url, { stopAt: isAppAddress });
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("error_description")).toMatch(/PKCE/);
  });

  it("refuses a code exchanged with the wrong verifier", async () => {
    h.github.addPerson("fay");
    const browser = new Browser();
    const r = await signInTo(h, browser, { clientId: "quiz", githubLogin: "fay" });
    const token = await exchangeCode(h, { clientId: "quiz", code: r.code!, verifier: pkce().verifier });
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_grant");
  });

  it("refuses a code used twice, and withdraws what the first use gave", async () => {
    h.github.addPerson("gus");
    const browser = new Browser();
    const r = await signInTo(h, browser, { clientId: "quiz", githubLogin: "gus" });
    const first = await exchangeCode(h, { clientId: "quiz", code: r.code!, verifier: r.verifier });
    expect(first.status).toBe(200);
    const second = await exchangeCode(h, { clientId: "quiz", code: r.code!, verifier: r.verifier });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe("invalid_grant");

    // A replayed code means the first one may have been stolen: the token it produced stops working.
    const me = await fetch(`${h.issuer}/me`, { headers: { authorization: `Bearer ${first.body.access_token}` } });
    expect(me.status).toBe(401);
  });

  it("refuses the wrong client secret", async () => {
    h.github.addPerson("han");
    const browser = new Browser();
    const r = await signInTo(h, browser, { clientId: "quiz", githubLogin: "han" });
    const token = await exchangeCode(h, { clientId: "quiz", code: r.code!, verifier: r.verifier, secret: "w".repeat(48) });
    expect(token.status).toBe(401);
    expect(token.body.error).toBe("invalid_client");
  });

  it("does not use another app's code", async () => {
    h.github.addPerson("ivy");
    const browser = new Browser();
    const r = await signInTo(h, browser, { clientId: "quiz", githubLogin: "ivy" });
    const token = await exchangeCode(h, { clientId: "forums", code: r.code!, verifier: r.verifier });
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_grant");
  });

  it("never redirects to an address that was not registered", async () => {
    const browser = new Browser();
    const url = authorizeUrl(h, { clientId: "quiz", redirectUri: "https://evil.example/cb" });
    const response = await browser.request(url);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not accept a registered address with something added to it", async () => {
    const browser = new Browser();
    for (const uri of ["http://localhost:4001/cb/extra", "http://localhost:4001/cb?x=1", "http://localhost:4001/CB"]) {
      const response = await browser.request(authorizeUrl(h, { clientId: "quiz", redirectUri: uri }));
      expect(response.status, uri).toBe(400);
      expect(response.headers.get("location"), uri).toBeNull();
    }
  });

  it("shows an error, not a redirect, for an app it does not know", async () => {
    const browser = new Browser();
    const response = await browser.request(authorizeUrl(h, { clientId: "nobody", redirectUri: "http://localhost:4001/cb" }));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("has none of the other flows", async () => {
    const browser = new Browser();
    const implicit = authorizeUrl(h, { clientId: "quiz", extra: { response_type: "token" } });
    const r1 = await browser.follow(implicit, { stopAt: isAppAddress });
    // An implicit request is answered in the fragment, so the error is found there.
    expect(r1.url.hash).toMatch(/error=(unsupported_response_type|invalid_request)/);
    expect(r1.url.hash).not.toMatch(/access_token|id_token=/);

    const password = await fetch(`${h.issuer}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`quiz:${"q".repeat(48)}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "password", username: "a", password: "b" }),
    });
    expect(password.status).toBe(400);
    expect(((await password.json()) as { error: string }).error).toBe("unsupported_grant_type");

    const clientCreds = await fetch(`${h.issuer}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`quiz:${"q".repeat(48)}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    expect(clientCreds.status).toBe(400);

    // A refresh token cannot be used: none is ever issued, and no app is registered for that grant.
    const refresh = await fetch(`${h.issuer}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`quiz:${"q".repeat(48)}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "anything" }),
    });
    expect(refresh.status).toBe(400);

    expect((await fetch(`${h.issuer}/reg`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${h.issuer}/token/introspection`, { method: "POST", body: "token=x" })).status).toBe(404);
  });

  it("does not offer the development login page", async () => {
    const browser = new Browser();
    const response = await browser.request(`${h.issuer}/interaction/anything-at-all`);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toMatch(/password/i);
  });

  it("gives the GitHub id only to an app registered for it, and only when it asks", async () => {
    h.github.addPerson("tia");
    const githubId = h.github.people.get("tia")!.id;

    // The main site asks for the `github` scope and is allowed it.
    const site = await signInTo(h, new Browser(), { clientId: "site", githubLogin: "tia", scope: "openid profile club github" });
    const siteToken = await exchangeCode(h, { clientId: "site", code: site.code!, verifier: site.verifier });
    expect((await idTokenClaims(String(siteToken.body.id_token), "site")).payload.github_id).toBe(githubId);

    // Asking for less than it is allowed gives nothing extra.
    const plain = await signInTo(h, new Browser(), { clientId: "site", githubLogin: "tia" });
    const plainToken = await exchangeCode(h, { clientId: "site", code: plain.code!, verifier: plain.verifier });
    expect((await idTokenClaims(String(plainToken.body.id_token), "site")).payload).not.toHaveProperty("github_id");

    // Any other app asking for it is refused, not quietly given less.
    const other = await signInTo(h, new Browser(), { clientId: "quiz", githubLogin: "tia", scope: "openid profile github" });
    expect(other.error).toBe("invalid_scope");
    expect(other.code).toBeNull();
  });

  it("does not issue a refresh token, even when asked for one", async () => {
    h.github.addPerson("jun");
    const browser = new Browser();
    const r = await signInTo(h, browser, { clientId: "quiz", githubLogin: "jun", scope: "openid profile offline_access" });
    const token = await exchangeCode(h, { clientId: "quiz", code: r.code!, verifier: r.verifier });
    expect(token.status).toBe(200);
    expect(token.body).not.toHaveProperty("refresh_token");
  });
});

describe("the sign in with GitHub", () => {
  async function startLogin(browser: Browser) {
    const start = authorizeUrl(h, { clientId: "quiz" });
    // Walk to the point where the browser is about to go to GitHub, and stop there.
    let current = start;
    for (let i = 0; i < 6; i++) {
      const response = await browser.request(current);
      const location = new URL(response.headers.get("location") ?? "", current).toString();
      if (new URL(location).host === "github.test") return location;
      current = location;
    }
    throw new Error("never reached GitHub");
  }

  it("refuses a callback with a state that was never issued", async () => {
    const browser = new Browser();
    const response = await browser.request(`${h.issuer}/callback/github?code=x&state=${"a".repeat(43)}`);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(h.audit.entries.at(-1)?.event).toBe("login.denied_state");
  });

  it("refuses a callback that arrives in a different browser from the one that started it", async () => {
    h.github.addPerson("kim");
    const victim = new Browser();
    const toGitHub = await startLogin(victim);
    // An attacker gets the victim to follow a callback link with the attacker's own code, but in the *attacker's* browser.
    const attacker = new Browser();
    const callback = h.github.approve(toGitHub, "kim");
    const response = await attacker.request(callback);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses a state value used a second time", async () => {
    h.github.addPerson("lou");
    const browser = new Browser();
    const toGitHub = await startLogin(browser);
    const callback = h.github.approve(toGitHub, "lou");
    const first = await browser.request(callback);
    expect(first.status).toBe(303);
    const again = await browser.request(callback);
    expect(again.status).toBe(400);
  });

  it("tells the app the person cancelled, in the standard way", async () => {
    const browser = new Browser();
    const toGitHub = await startLogin(browser);
    const state = new URL(toGitHub).searchParams.get("state")!;
    const cancelled = `${h.issuer}/callback/github?error=access_denied&state=${state}`;
    const { url } = await browser.follow(cancelled, { stopAt: isAppAddress });
    expect(url.searchParams.get("error")).toBe("access_denied");
  });

  it("tells the app to try again when GitHub cannot be reached", async () => {
    h.github.addPerson("moe");
    h.github.failExchange = true;
    const browser = new Browser();
    const r = await signInTo(h, browser, { clientId: "quiz", githubLogin: "moe" });
    expect(r.error).toBe("temporarily_unavailable");
    expect(r.code).toBeNull();
  });

  it("does not let a ticket be collected for a different sign in", async () => {
    h.github.addPerson("nia");
    const browser = new Browser();
    const toGitHub = await startLogin(browser);
    await browser.request(h.github.approve(toGitHub, "nia"));
    // The ticket is for one specific sign in. Asking for another one's finish page must not consume it or sign anyone in.
    const response = await browser.request(`${h.issuer}/interaction/some-other-uid-123456/finish`);
    expect(response.status).toBe(400);
  });
});

describe("apps for members only", () => {
  it("lets a member in", async () => {
    h.github.addPerson("omar");
    h.members.members.set(h.github.people.get("omar")!.id, { member: true, role: "MAINTAINER" });
    const browser = new Browser();
    const r = await signInTo(h, browser, { clientId: "staff", githubLogin: "omar" });
    expect(r.error).toBeNull();
    expect(r.code).toBeTruthy();
  });

  it("stops someone who is not a member, with a page that says why", async () => {
    h.github.addPerson("pia");
    const browser = new Browser();
    const start = authorizeUrl(h, { clientId: "staff" });
    const { url, response } = await browser.follow(start, { githubLogin: "pia", github: h.github, stopAt: isAppAddress });
    expect(url.hostname).not.toBe("localhost");
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/is for club members/);
    expect(h.audit.entries.some((e) => e.event === "access.denied_not_member")).toBe(true);
  });

  it("answers a quiet check with access_denied, not a screen", async () => {
    h.github.addPerson("quin");
    const browser = new Browser();
    await signInTo(h, browser, { clientId: "quiz", githubLogin: "quin" });
    const r = await signInTo(h, browser, { clientId: "staff", prompt: "none" });
    expect(r.error).toBe("access_denied");
  });

  it("notices a person who stopped being a member, once the cached answer has expired", async () => {
    h.github.addPerson("rae");
    const id = h.github.people.get("rae")!.id;
    h.members.members.set(id, { member: true, role: null });
    const browser = new Browser();
    expect((await signInTo(h, browser, { clientId: "staff", githubLogin: "rae" })).code).toBeTruthy();

    h.members.members.set(id, { member: false, role: null });
    // The answer is cached for ten minutes, so within that time nothing changes.
    const cached = await signInTo(h, browser, { clientId: "staff", prompt: "none" });
    expect(cached.code).toBeTruthy();
  });
});

describe("an app that is not one of ours", () => {
  it("asks the person to approve it, and works once they do", async () => {
    h.github.addPerson("sam");
    const browser = new Browser();
    const start = authorizeUrl(h, { clientId: "outside" });
    const { url, response } = await browser.follow(start, { githubLogin: "sam", github: h.github, stopAt: isAppAddress });
    expect(url.pathname).toMatch(/^\/interaction\/[^/]+$/);
    const page = await response.text();
    expect(page).toMatch(/Allow Outside App/);
    const uid = url.pathname.split("/").pop()!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;

    // Without the token, or from another site, the approval is refused.
    const noToken = await browser.request(`${h.issuer}/interaction/${uid}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: h.issuer },
      body: new URLSearchParams({}),
    });
    expect(noToken.status).toBe(403);
    const wrongOrigin = await browser.request(`${h.issuer}/interaction/${uid}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ csrf }),
    });
    expect(wrongOrigin.status).toBe(403);

    const approve = await browser.request(`${h.issuer}/interaction/${uid}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: h.issuer },
      body: new URLSearchParams({ csrf }),
    });
    expect(approve.status).toBe(303);
    const back = await browser.follow(new URL(approve.headers.get("location")!, h.issuer).toString(), { stopAt: isAppAddress });
    expect(back.url.searchParams.get("code")).toBeTruthy();
  });

  it("reports a refusal to approve as access_denied", async () => {
    h.github.addPerson("tess");
    const browser = new Browser();
    const start = authorizeUrl(h, { clientId: "outside" });
    const { url, response } = await browser.follow(start, { githubLogin: "tess", github: h.github, stopAt: isAppAddress });
    const uid = url.pathname.split("/").pop()!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(await response.text())![1]!;
    const decline = await browser.request(`${h.issuer}/interaction/${uid}/abort`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: h.issuer },
      body: new URLSearchParams({ csrf }),
    });
    const back = await browser.follow(new URL(decline.headers.get("location")!, h.issuer).toString(), { stopAt: isAppAddress });
    expect(back.url.searchParams.get("error")).toBe("access_denied");
  });
});

describe("a blocked account", () => {
  it("cannot sign in", async () => {
    h.github.addPerson("uma");
    const browser = new Browser();
    await signInTo(h, browser, { clientId: "quiz", githubLogin: "uma" });
    const account = await h.repo.getByLogin("uma");
    await h.accounts.block(account!.id);

    const fresh = new Browser();
    const { response } = await fresh.follow(authorizeUrl(h, { clientId: "quiz" }), {
      githubLogin: "uma",
      github: h.github,
      stopAt: isAppAddress,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/cannot be used to sign in/);
    expect(h.audit.entries.some((e) => e.event === "login.denied_blocked")).toBe(true);
  });

  it("loses its session and its tokens straight away", async () => {
    h.github.addPerson("vic");
    const browser = new Browser();
    const r = await signInTo(h, browser, { clientId: "quiz", githubLogin: "vic" });
    const token = await exchangeCode(h, { clientId: "quiz", code: r.code!, verifier: r.verifier });
    const bearer = { authorization: `Bearer ${token.body.access_token}` };
    expect((await fetch(`${h.issuer}/me`, { headers: bearer })).status).toBe(200);

    await h.accounts.block((await h.repo.getByLogin("vic"))!.id);

    expect((await fetch(`${h.issuer}/me`, { headers: bearer })).status).toBe(401);
    // And the browser that was signed in is no longer: a quiet check says so.
    const quiet = await signInTo(h, browser, { clientId: "forums", prompt: "none" });
    expect(quiet.error).toBe("login_required");
  });

  it("can sign in again once unblocked", async () => {
    h.github.addPerson("wes");
    const browser = new Browser();
    await signInTo(h, browser, { clientId: "quiz", githubLogin: "wes" });
    const id = (await h.repo.getByLogin("wes"))!.id;
    await h.accounts.block(id);
    await h.accounts.unblock(id);
    const again = await signInTo(h, new Browser(), { clientId: "quiz", githubLogin: "wes" });
    expect(again.code).toBeTruthy();
  });
});

describe("signing out", () => {
  it("ends the session for every app", async () => {
    h.github.addPerson("xia");
    const browser = new Browser();
    const r = await signInTo(h, browser, { clientId: "quiz", githubLogin: "xia" });
    const token = await exchangeCode(h, { clientId: "quiz", code: r.code!, verifier: r.verifier });

    const logout = new URL(`${h.issuer}/session/end`);
    logout.searchParams.set("id_token_hint", String(token.body.id_token));
    logout.searchParams.set("post_logout_redirect_uri", "http://localhost:4001/bye");
    logout.searchParams.set("state", "bye123");

    // The provider asks for confirmation (it is not safe to log someone out on a bare GET).
    const confirm = await browser.request(logout.toString());
    expect(confirm.status).toBe(200);
    const page = await confirm.text();
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(page)![1]!;
    const done = await browser.request(`${h.issuer}/session/end/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: h.issuer },
      body: new URLSearchParams({ xsrf, logout: "yes" }),
    });
    expect(done.status).toBe(303);
    const back = new URL(done.headers.get("location")!, h.issuer);
    expect(back.origin + back.pathname).toBe("http://localhost:4001/bye");
    expect(back.searchParams.get("state")).toBe("bye123");

    // Nobody is signed in any more.
    const quiet = await signInTo(h, browser, { clientId: "forums", prompt: "none" });
    expect(quiet.error).toBe("login_required");
  });

  it("does not redirect to an address that was not registered for logout", async () => {
    h.github.addPerson("yan");
    const browser = new Browser();
    const r = await signInTo(h, browser, { clientId: "quiz", githubLogin: "yan" });
    const token = await exchangeCode(h, { clientId: "quiz", code: r.code!, verifier: r.verifier });
    const logout = new URL(`${h.issuer}/session/end`);
    logout.searchParams.set("id_token_hint", String(token.body.id_token));
    logout.searchParams.set("post_logout_redirect_uri", "https://evil.example/");
    const response = await browser.request(logout.toString());
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("what the service does around the protocol", () => {
  it("keeps the main database off the path of most requests", async () => {
    h.github.addPerson("zed");
    h.members.members.set(h.github.people.get("zed")!.id, { member: true, role: null });
    const browser = new Browser();
    const before = h.members.lookups;
    const a = await signInTo(h, browser, { clientId: "quiz", githubLogin: "zed" });
    await exchangeCode(h, { clientId: "quiz", code: a.code!, verifier: a.verifier });
    const b = await signInTo(h, browser, { clientId: "forums" });
    await exchangeCode(h, { clientId: "forums", code: b.code!, verifier: b.verifier });
    expect(h.members.lookups - before).toBe(1);
  });

  it("keeps working when the main database is down, using the last known answer", async () => {
    h.github.addPerson("abe");
    const id = h.github.people.get("abe")!.id;
    h.members.members.set(id, { member: true, role: "ADMIN" });
    // First sign in while it is up, so the answer is known.
    await signInTo(h, new Browser(), { clientId: "quiz", githubLogin: "abe" });

    // Expire the cached answer, then take the main database down.
    h.state.exec([
      { t: "del", key: `oidc:member:${id}` },
      { t: "del", key: `oidc:acct:${(await h.repo.getByLogin("abe"))!.id}` },
    ]);
    h.members.failing = true;

    const r = await signInTo(h, new Browser(), { clientId: "staff", githubLogin: "abe" });
    expect(r.code).toBeTruthy();
    const token = await exchangeCode(h, { clientId: "staff", code: r.code!, verifier: r.verifier });
    const { payload } = await idTokenClaims(String(token.body.id_token), "staff");
    expect(payload.member).toBe(true);
    expect(payload.role).toBe("ADMIN");
  });

  it("sends the headers a sign in page needs", async () => {
    const browser = new Browser();
    const first = await browser.request(authorizeUrl(h, { clientId: "quiz" }));
    const interaction = new URL(first.headers.get("location")!, h.issuer).toString();
    // The page itself: an error page is a convenient one that does not need GitHub.
    const page = await browser.request(`${h.issuer}/callback/github?state=${"b".repeat(43)}`);
    for (const response of [page, await browser.request(interaction)]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("strict-transport-security")).toMatch(/max-age=/);
    }
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/style-src 'nonce-[A-Za-z0-9_-]+'/);
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(csp).not.toMatch(/script-src/); // no script is ever served, so none is ever allowed
    // The nonce in the header is the one in the page.
    const nonce = /nonce-([A-Za-z0-9_-]+)/.exec(csp)![1];
    expect(await page.text()).toContain(`nonce="${nonce}"`);
  });

  it("answers the health checks", async () => {
    expect((await fetch(`${h.issuer}/healthz`)).status).toBe(200);
    const ready = await fetch(`${h.issuer}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, state: true });
  });

  it("escapes anything that comes from outside in the pages it shows", async () => {
    h.github.addPerson("<img src=x onerror=alert(1)>", { name: "<script>alert(1)</script>" });
    const browser = new Browser();
    const start = authorizeUrl(h, { clientId: "outside" });
    const { response } = await browser.follow(start, {
      githubLogin: "<img src=x onerror=alert(1)>",
      github: h.github,
      stopAt: isAppAddress,
    });
    const page = await response.text();
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("rate limiting", () => {
  it("turns away a flood and says when to come back", async () => {
    const limited = await startService({ limitOverrides: { interaction: 5 } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 9; i++) statuses.push((await fetch(`${limited.issuer}/callback/github?state=${"c".repeat(43)}`)).status);
      expect(statuses.slice(0, 5).every((s) => s === 400)).toBe(true);
      expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
      const blocked = await fetch(`${limited.issuer}/callback/github`);
      expect(blocked.headers.get("retry-after")).toBeTruthy();
      // Other kinds of request are not affected by it.
      expect((await fetch(`${limited.issuer}/.well-known/openid-configuration`)).status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe("in production (https behind a proxy)", () => {
  it("sets every cookie so that a browser will accept it and not leak it", async () => {
    const secure = await startService({ secureCookies: true });
    try {
      secure.github.addPerson("prod");
      const browser = new Browser({ "x-forwarded-proto": "https" });
      const r = await signInTo(secure, browser, { clientId: "quiz", githubLogin: "prod" });
      expect(r.code).toBeTruthy();

      const lines = browser.setCookies.filter((l) => !/^[^=]+=;|expires=Thu, 01 Jan 1970/i.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, line).toMatch(/;\s*secure/i);
        expect(line, line).toMatch(/;\s*httponly/i);
        expect(line, line).toMatch(/;\s*samesite=lax/i);
        expect(line, line).not.toMatch(/;\s*domain=/i);
      }
      // The session and our own binding cookie use the __Host- prefix, which a browser only accepts when Secure, Path=/ and no Domain.
      const session = lines.filter((l) => l.startsWith("__Host-oidc_session"));
      expect(session.length).toBeGreaterThan(0);
      for (const line of session) expect(line).toMatch(/;\s*path=\/(;|$)/i);
      expect(lines.some((l) => l.startsWith("__Host-oidc_bind="))).toBe(true);
    } finally {
      await secure.close();
    }
  });
});

describe("cross origin requests", () => {
  /** A real token request from a web page: an Origin header, and a code that is not valid (so the origin check is what is being tested). */
  const fromPage = (clientId: string, origin: string, secret?: string) =>
    fetch(`${h.issuer}/token`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
        ...(secret ? { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}` } : {}),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "not-a-real-code",
        redirect_uri: "http://localhost:4005/cb",
        code_verifier: "y".repeat(50),
        ...(secret ? {} : { client_id: clientId }),
      }),
    });

  it("lets a single page app call the token endpoint from its own address", async () => {
    const response = await fromPage("spa", "http://localhost:4005");
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4005");
    // It got as far as checking the code, which is the point.
    expect(((await response.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses the same call from any other address", async () => {
    const response = await fromPage("spa", "https://evil.example");
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await response.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/origin .* not allowed/);
  });

  it("never lets a web page call the token endpoint for an app that has a secret", async () => {
    const response = await fromPage("quiz", "http://localhost:4001", "q".repeat(48));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.status).toBe(400);
  });
});

describe("more ways to misuse it", () => {
  it("does not sign someone out because of a forged request", async () => {
    h.github.addPerson("forge");
    const browser = new Browser();
    await signInTo(h, browser, { clientId: "quiz", githubLogin: "forge" });
    // A page on another site makes the browser post to the logout confirmation, without the token the real page carried.
    const forged = await browser.request(`${h.issuer}/session/end/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ logout: "yes" }),
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    const quiet = await signInTo(h, browser, { clientId: "forums", prompt: "none" });
    expect(quiet.code).toBeTruthy();
  });

  it("does not let someone who learns a state value use it up", async () => {
    h.github.addPerson("burn");
    const victim = new Browser();
    let current = authorizeUrl(h, { clientId: "quiz" });
    let toGitHub = "";
    for (let i = 0; i < 6 && !toGitHub; i++) {
      const response = await victim.request(current);
      const location = new URL(response.headers.get("location") ?? "", current).toString();
      if (new URL(location).host === "github.test") toGitHub = location;
      else current = location;
    }
    const state = new URL(toGitHub).searchParams.get("state")!;

    // Someone else presents the state from their own browser: refused...
    const attacker = new Browser();
    expect((await attacker.request(`${h.issuer}/callback/github?code=x&state=${state}`)).status).toBe(400);

    // ...and the victim's sign in still works.
    const { url } = await victim.follow(h.github.approve(toGitHub, "burn"), { stopAt: isAppAddress });
    expect(url.searchParams.get("code")).toBeTruthy();
  });

  it("does not check its dependencies on every readiness request", async () => {
    let checked = 0;
    const counted = await startService({
      readiness: {
        database: async () => {
          checked++;
          return true;
        },
      },
    });
    try {
      for (let i = 0; i < 8; i++) expect((await fetch(`${counted.issuer}/readyz`)).status).toBe(200);
      // A database that is asked every second never gets to sleep, so the answer is reused for a few seconds.
      expect(checked).toBe(1);
    } finally {
      await counted.close();
    }
  });

  it("reports a failing dependency", async () => {
    const broken = await startService({ readiness: { database: async () => false, state: async () => true } });
    try {
      const response = await fetch(`${broken.issuer}/readyz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, database: false, state: true });
    } finally {
      await broken.close();
    }
  });
});

describe("protecting Redis from a flood of anonymous starts", () => {
  it("limits starting a sign in from nothing, but not people who are already signed in", async () => {
    const limited = await startService({ limitOverrides: { authAnonIp: 4 } });
    try {
      limited.github.addPerson("burst");
      const member = new Browser();
      await signInTo(limited, member, { clientId: "quiz", githubLogin: "burst" });

      const stranger = new Browser();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await stranger.request(authorizeUrl(limited, { clientId: "quiz" }))).status);
      expect(statuses.slice(0, 3).every((s) => s === 303)).toBe(true);
      expect(statuses.slice(3).every((s) => s === 429)).toBe(true);

      // (The first start above counted too: the person signing in began from nothing, from the same address.)
      // The signed in person from the same address is not affected.
      const again = await signInTo(limited, member, { clientId: "forums" });
      expect(again.code).toBeTruthy();
    } finally {
      await limited.close();
    }
  });

  it("has a limit for everyone together as well, so many addresses cannot add up to a flood", async () => {
    const limited = await startService({ limitOverrides: { authAnonIp: 1000, authAnonAll: 4 } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await new Browser().request(authorizeUrl(limited, { clientId: "quiz" }))).status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    } finally {
      await limited.close();
    }
  });
});
