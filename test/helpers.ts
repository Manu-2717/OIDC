import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair } from "jose";
import { AccountService, MemoryAccountRepo, type GitHubProfile } from "../src/accounts.js";
import { createApp, type AppDeps } from "../src/create-app.js";
import { MemoryAuditLog } from "../src/audit.js";
import { loadClients } from "../src/clients.js";
import type { Config } from "../src/config.js";
import type { GitHubClient } from "../src/github.js";
import { MemberDirectory, type MemberSource, type MemberStatus } from "../src/members.js";
import { MemoryState, UpstashState, type StateBackend } from "../src/state.js";
import { FakeRedis, installFakeRedis } from "./fake-redis.js";

/* ------------------------------------------------------------------------------------------------ a stand in for GitHub */

export class FakeGitHub implements GitHubClient {
  readonly people = new Map<string, GitHubProfile>();
  readonly revoked: string[] = [];
  /** challenge by state, so exchange() can check the PKCE verifier the way GitHub does. */
  private readonly challenges = new Map<string, string>();
  private readonly codes = new Map<string, { login: string; challenge: string }>();
  failExchange = false;

  addPerson(login: string, extra: Partial<GitHubProfile> = {}) {
    const id = String(1000 + this.people.size);
    this.people.set(login, {
      id,
      login,
      name: `${login} Name`,
      email: `${login}@example.com`,
      emailVerified: true,
      picture: `https://avatars.githubusercontent.com/u/${id}`,
      ...extra,
    });
  }

  authorizeUrl({ state, codeChallenge, redirectUri }: { state: string; codeChallenge: string; redirectUri: string }) {
    this.challenges.set(state, codeChallenge);
    const url = new URL("https://github.test/login/oauth/authorize");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** What GitHub does when the person approves: it sends the browser back with a code. */
  approve(authorizeUrl: string, login: string) {
    const url = new URL(authorizeUrl);
    const state = url.searchParams.get("state")!;
    const code = `code-${randomBytes(8).toString("hex")}`;
    this.codes.set(code, { login, challenge: this.challenges.get(state)! });
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    return back.toString();
  }

  async exchange({ code, codeVerifier }: { code: string; codeVerifier: string; redirectUri: string }) {
    if (this.failExchange) throw new Error("github is down");
    const entry = this.codes.get(code);
    if (!entry) throw new Error("bad code");
    this.codes.delete(code); // codes work once
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    if (challenge !== entry.challenge) throw new Error("pkce mismatch");
    return `token-for-${entry.login}`;
  }

  async profile(accessToken: string) {
    const login = accessToken.replace("token-for-", "");
    const profile = this.people.get(login);
    if (!profile) throw new Error("unknown person");
    return profile;
  }

  async revoke(accessToken: string) {
    this.revoked.push(accessToken);
  }
}

export class FakeMemberSource implements MemberSource {
  readonly members = new Map<string, MemberStatus>();
  lookups = 0;
  failing = false;

  async lookup(githubId: string) {
    this.lookups++;
    if (this.failing) throw new Error("main database unreachable");
    return this.members.get(githubId) ?? { member: false, role: null };
  }
}

/* ------------------------------------------------------------------------------------------------ a running service */

export const TEST_CLIENTS = [
  {
    client_id: "quiz",
    client_name: "Quiz",
    redirect_uris: ["http://localhost:4001/cb"],
    post_logout_redirect_uris: ["http://localhost:4001/bye"],
  },
  {
    client_id: "forums",
    client_name: "Forums",
    redirect_uris: ["http://localhost:4002/cb"],
    post_logout_redirect_uris: ["http://localhost:4002/bye"],
  },
  { client_id: "staff", client_name: "Staff Room", redirect_uris: ["http://localhost:4003/cb"], require_member: true },
  { client_id: "outside", client_name: "Outside App", redirect_uris: ["http://localhost:4004/cb"], trusted: false },
  { client_id: "spa", client_name: "Single Page", redirect_uris: ["http://localhost:4005/cb"], type: "public" },
  { client_id: "site", client_name: "Main Site", redirect_uris: ["http://localhost:4006/cb"], release_github_id: true },
];

export const SECRETS: Record<string, string> = {
  QUIZ: "q".repeat(48),
  FORUMS: "f".repeat(48),
  STAFF: "s".repeat(48),
  OUTSIDE: "o".repeat(48),
  SITE: "w".repeat(48),
};

export interface Harness {
  issuer: string;
  github: FakeGitHub;
  members: FakeMemberSource;
  state: StateBackend;
  accounts: AccountService;
  audit: MemoryAuditLog;
  repo: MemoryAccountRepo;
  server: Server;
  config: Config;
  close(): Promise<void>;
}

export async function startService(
  overrides: {
    limitOverrides?: Partial<Record<string, number>>;
    clients?: unknown[];
    secureCookies?: boolean;
    readiness?: Record<string, () => Promise<boolean>>;
  } = {},
): Promise<Harness> {
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const jwk = await exportJWK(privateKey);

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const config: Config = {
    issuer,
    production: false,
    secureCookies: overrides.secureCookies ?? false,
    databaseUrl: "unused",
    mainDbUrl: null,
    redisUrl: "unused",
    redisToken: "unused",
    github: { clientId: "gh-client", clientSecret: "gh-secret" },
    jwks: { keys: [{ ...jwk, kid: "test-key", use: "sig", alg: "RS256" } as never] },
    cookieKeys: ["test-cookie-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    csrfSecret: "test-csrf-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    membershipInfoUrl: "https://www.fossclub.tech",
    clientSecrets: SECRETS,
  };

  // STATE_BACKEND=upstash runs the same tests through the real Upstash client library, over HTTP, against a fake server.
  const useUpstash = process.env.STATE_BACKEND === "upstash";
  const uninstall = useUpstash ? installFakeRedis(new FakeRedis()) : () => undefined;
  const state: StateBackend = useUpstash ? new UpstashState("https://redis.test", "token") : new MemoryState();
  const github = new FakeGitHub();
  const members = new FakeMemberSource();
  const repo = new MemoryAccountRepo();
  const accounts = new AccountService(repo, state, new MemberDirectory(members, state));
  const audit = new MemoryAuditLog();
  const clients = loadClients(overrides.clients ?? TEST_CLIENTS, SECRETS);
  if (clients.errors.length) throw new Error(`test clients are invalid: ${clients.errors.join("; ")}`);

  const deps: AppDeps = {
    config,
    state,
    accounts,
    audit,
    github,
    clients,
    readiness: overrides.readiness ?? { state: () => state.ping() },
    ...(overrides.limitOverrides ? { limitOverrides: overrides.limitOverrides } : {}),
  };
  server.on("request", createApp(deps));

  return {
    issuer,
    github,
    members,
    state,
    accounts,
    audit,
    repo,
    server,
    config,
    close: () =>
      new Promise<void>((resolve) => {
        uninstall();
        server.close(() => resolve());
      }),
  };
}

/* ------------------------------------------------------------------------------------------------ a browser */

interface StoredCookie {
  name: string;
  value: string;
  path: string;
}

/** A browser that follows redirects by hand and scopes cookies by path, the way a real one does. That matters here: the provider's
 *  interaction cookie is only sent to /interaction/<uid>, and getting that wrong is exactly the bug a lenient test client would hide. */
export class Browser {
  private cookies: StoredCookie[] = [];
  readonly visited: string[] = [];
  /** Every Set-Cookie line the service sent, as it was sent. */
  readonly setCookies: string[] = [];

  constructor(private readonly extraHeaders: Record<string, string> = {}) {}

  cookie(name: string) {
    return this.cookies.find((c) => c.name === name)?.value;
  }

  clearCookies() {
    this.cookies = [];
  }

  private header(url: URL) {
    return this.cookies
      .filter((c) => url.pathname === c.path || url.pathname.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`) || c.path === "/")
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  private store(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      this.setCookies.push(line);
      const [pair, ...attrs] = line.split(";").map((p) => p.trim());
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      const path = attrs.find((a) => a.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
      const expired =
        value === "" ||
        attrs.some((a) => a.toLowerCase() === "max-age=0") ||
        attrs.some((a) => a.toLowerCase().startsWith("expires=") && new Date(a.slice(8)).getTime() < Date.now());
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.path === path));
      if (!expired) this.cookies.push({ name, value, path });
    }
  }

  async request(url: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    // Behind a proxy the service builds https addresses, but the test server only speaks http.
    const target = new URL(url.replace(/^https:\/\/127\.0\.0\.1/, "http://127.0.0.1"));
    this.visited.push(`${init.method ?? "GET"} ${target.pathname}`);
    const response = await fetch(target, {
      ...init,
      redirect: "manual",
      headers: { ...this.extraHeaders, ...(init.headers ?? {}), ...(this.header(target) ? { cookie: this.header(target) } : {}) },
    });
    this.store(response);
    return response;
  }

  /**
   * Follows redirects until one leaves the service for an address in `stopAt`, and returns that address. A redirect to GitHub is
   * answered by the fake (approving as `login`) and the browser carries on.
   */
  async follow(
    start: string,
    opts: { githubLogin?: string; github?: FakeGitHub; stopAt: (url: URL) => boolean; max?: number },
  ): Promise<{ url: URL; response: Response }> {
    let current = start;
    for (let hop = 0; hop < (opts.max ?? 15); hop++) {
      const url = new URL(current);
      if (opts.stopAt(url)) return { url, response: new Response(null, { status: 302 }) };
      const response = await this.request(current);
      if (response.status >= 300 && response.status < 400) {
        const location = new URL(response.headers.get("location")!, current).toString();
        if (new URL(location).host === "github.test") {
          if (!opts.githubLogin || !opts.github) throw new Error("the flow went to GitHub, but no one was set to sign in");
          current = opts.github.approve(location, opts.githubLogin);
        } else {
          current = location;
        }
        continue;
      }
      return { url, response };
    }
    throw new Error(`too many redirects: ${this.visited.slice(-8).join(" -> ")}`);
  }
}

/* ------------------------------------------------------------------------------------------------ the app side of the flow */

export const pkce = () => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export interface AuthorizeOptions {
  clientId: string;
  redirectUri?: string;
  scope?: string;
  prompt?: string;
  state?: string;
  nonce?: string;
  challenge?: string | null;
  extra?: Record<string, string>;
}

export function authorizeUrl(h: Harness, o: AuthorizeOptions) {
  const redirect = o.redirectUri ?? TEST_CLIENTS.find((c) => c.client_id === o.clientId)?.redirect_uris[0] ?? "http://localhost:4001/cb";
  const url = new URL(`${h.issuer}/auth`);
  url.searchParams.set("client_id", o.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("scope", o.scope ?? "openid profile email club");
  url.searchParams.set("state", o.state ?? "st-" + randomBytes(4).toString("hex"));
  url.searchParams.set("nonce", o.nonce ?? "nonce-" + randomBytes(4).toString("hex"));
  if (o.challenge !== null) {
    url.searchParams.set("code_challenge", o.challenge ?? pkce().challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (o.prompt) url.searchParams.set("prompt", o.prompt);
  for (const [k, v] of Object.entries(o.extra ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

/** The app's redirect_uri hosts, so the browser stops there instead of trying to open a page that does not exist. */
export const isAppAddress = (url: URL) => url.hostname === "localhost";

export async function exchangeCode(
  h: Harness,
  o: { clientId: string; code: string; verifier: string; redirectUri?: string; secret?: string | null },
) {
  const redirect = o.redirectUri ?? TEST_CLIENTS.find((c) => c.client_id === o.clientId)?.redirect_uris[0] ?? "";
  const secret = o.secret === undefined ? SECRETS[o.clientId.toUpperCase()] : o.secret;
  const body = new URLSearchParams({ grant_type: "authorization_code", code: o.code, redirect_uri: redirect, code_verifier: o.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (secret) headers.authorization = `Basic ${Buffer.from(`${o.clientId}:${secret}`).toString("base64")}`;
  else body.set("client_id", o.clientId);
  const response = await fetch(`${h.issuer}/token`, { method: "POST", headers, body });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The whole dance for one app: authorize, sign in through GitHub if needed, and end up with a code. */
export async function signInTo(h: Harness, browser: Browser, o: AuthorizeOptions & { githubLogin?: string }) {
  const { verifier, challenge } = pkce();
  const nonce = o.nonce ?? "nonce-" + randomBytes(4).toString("hex");
  const state = o.state ?? "st-" + randomBytes(4).toString("hex");
  const start = authorizeUrl(h, { ...o, challenge, nonce, state });
  const { url } = await browser.follow(start, {
    ...(o.githubLogin ? { githubLogin: o.githubLogin } : {}),
    github: h.github,
    stopAt: isAppAddress,
  });
  return { url, verifier, nonce, state, code: url.searchParams.get("code"), error: url.searchParams.get("error") };
}
