import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";

/**
 * A small app that signs people in with the hosted service, for trying it by hand. It is what a real app does, with nothing hidden behind a
 * library: discovery, authorization code with PKCE, checking the ID token, calling userinfo, and signing out.
 *
 *   npm run example            then open http://localhost:4000
 *
 * It keeps one session in memory (this is a test tool for one person on one machine, not a pattern for a real app).
 */

const ISSUER = (process.env.ISSUER || "https://oidc.fossclub.tech").replace(/\/+$/, "");
const PORT = Number(process.env.PORT ?? 4000);
const BASE = `http://localhost:${PORT}`;
const REDIRECT_URI = `${BASE}/callback`;
const SCOPE = "openid profile email club";

/** Two registrations of the same test app: one for everybody, one that only lets club members in. */
const CLIENTS = { any: "oidc-test", members: "oidc-test-members" } as const;
type ClientKey = keyof typeof CLIENTS;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint: string;
  jwks_uri: string;
}

let discovery: Discovery | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

async function getDiscovery(): Promise<Discovery> {
  if (!discovery) {
    const response = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Discovery failed: ${response.status}`);
    discovery = (await response.json()) as Discovery;
    if (discovery.issuer !== ISSUER) throw new Error(`The service says its issuer is ${discovery.issuer}, not ${ISSUER}.`);
    jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  }
  return discovery;
}

/* ------------------------------------------------------------------------------------------------ state */

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface Notice {
  kind: "ok" | "error" | "info";
  title: string;
  lines: string[];
}

interface Pending {
  verifier: string;
  nonce: string;
  client: ClientKey;
  prompt: string | null;
  createdAt: number;
}

interface Session {
  client: ClientKey;
  idToken: string;
  header: Record<string, unknown>;
  claims: JWTPayload;
  checks: Check[];
  userinfo: unknown;
  signedInAt: number;
}

const pending = new Map<string, Pending>();
let session: Session | undefined;
let notice: Notice | undefined;

const b64url = (buffer: Buffer) => buffer.toString("base64url");
const random = (bytes = 32) => b64url(randomBytes(bytes));

/* ------------------------------------------------------------------------------------------------ flow */

async function startLogin(client: ClientKey, prompt: string | null): Promise<string> {
  const d = await getDiscovery();
  const state = random(16);
  const verifier = random(48);
  const nonce = random(16);
  pending.set(state, { verifier, nonce, client, prompt, createdAt: Date.now() });
  for (const [key, value] of pending) if (Date.now() - value.createdAt > 15 * 60_000) pending.delete(key);

  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: CLIENTS[client],
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    state,
    nonce,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    ...(prompt ? { prompt } : {}),
  }).toString();
  return url.toString();
}

async function finishLogin(params: URLSearchParams) {
  const state = params.get("state") ?? "";
  const flow = pending.get(state);
  pending.delete(state);
  if (!flow) throw new Error("Unknown or expired sign-in attempt (the state value does not match one this app started).");

  const error = params.get("error");
  if (error) {
    const description = params.get("error_description") ?? "";
    notice = {
      kind: flow.prompt === "none" && error === "login_required" ? "info" : "error",
      title:
        flow.prompt === "none" && error === "login_required"
          ? "No active session (this is the expected answer)"
          : `Sign-in refused: ${error}`,
      lines: [
        description,
        flow.prompt === "none" ? 'prompt=none asks "is someone already signed in?" without showing anything.' : "",
      ].filter(Boolean),
    };
    return;
  }

  const code = params.get("code");
  if (!code) throw new Error("The service sent neither a code nor an error.");

  const d = await getDiscovery();
  const tokenResponse = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENTS[flow.client],
      code_verifier: flow.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokens = (await tokenResponse.json()) as { id_token?: string; access_token?: string; error?: string; error_description?: string };
  if (!tokenResponse.ok || !tokens.id_token || !tokens.access_token) {
    throw new Error(`Token request failed: ${tokens.error ?? tokenResponse.status} ${tokens.error_description ?? ""}`.trim());
  }

  const checks: Check[] = [];
  const header = decodeProtectedHeader(tokens.id_token) as Record<string, unknown>;
  // jwtVerify checks the signature against the service's published keys, the issuer, the audience and the expiry.
  const { payload } = await jwtVerify(tokens.id_token, jwks!, { issuer: ISSUER, audience: CLIENTS[flow.client], algorithms: ["RS256"] });
  checks.push({ name: "Signature", ok: true, detail: `RS256, key ${String(header.kid)}, verified against ${d.jwks_uri}` });
  checks.push({ name: "Issuer", ok: true, detail: String(payload.iss) });
  checks.push({ name: "Audience", ok: true, detail: `${CLIENTS[flow.client]} (this app)` });
  checks.push({ name: "Expiry", ok: true, detail: `expires ${new Date((payload.exp ?? 0) * 1000).toLocaleTimeString()}` });
  const nonceOk = payload.nonce === flow.nonce;
  checks.push({ name: "Nonce", ok: nonceOk, detail: nonceOk ? "matches the one this app sent" : "does not match" });
  if (!nonceOk) throw new Error("The nonce in the ID token does not match, so this response is rejected.");

  const userinfoResponse = await fetch(d.userinfo_endpoint, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const userinfo: unknown = userinfoResponse.ok ? await userinfoResponse.json() : { error: `HTTP ${userinfoResponse.status}` };

  session = { client: flow.client, idToken: tokens.id_token, header, claims: payload, checks, userinfo, signedInAt: Date.now() };
  notice = undefined;
}

async function logoutUrl(): Promise<string> {
  const d = await getDiscovery();
  const url = new URL(d.end_session_endpoint);
  const params: Record<string, string> = { post_logout_redirect_uri: `${BASE}/`, state: random(8) };
  if (session) params.id_token_hint = session.idToken;
  if (session) params.client_id = CLIENTS[session.client];
  url.search = new URLSearchParams(params).toString();
  session = undefined;
  notice = { kind: "info", title: "Signed out of this app", lines: ["The sign-in service was asked to end its session too."] };
  return url.toString();
}

/* ------------------------------------------------------------------------------------------------ page */

/** What index.html shows. It is fetched by the page and drawn there, so the HTML file holds all of the markup and the styling. */
const pageState = () => ({
  issuer: ISSUER,
  base: BASE,
  notice: notice ?? null,
  signedIn: session
    ? {
        clientKey: session.client,
        clientId: CLIENTS[session.client],
        claims: session.claims,
        header: session.header,
        userinfo: session.userinfo,
        checks: session.checks,
      }
    : null,
});

/* ------------------------------------------------------------------------------------------------ server */

const send = (res: ServerResponse, status: number, type: string, body: string) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(302, { location: to, "cache-control": "no-store" });
  res.end();
};

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", BASE);
  try {
    if (url.pathname === "/") {
      // Read on every request, so an edit to the page shows on a refresh.
      return send(res, 200, "text/html; charset=utf-8", await readFile(new URL("./index.html", import.meta.url), "utf8"));
    }
    if (url.pathname === "/api/state") return send(res, 200, "application/json", JSON.stringify(pageState()));
    if (url.pathname === "/login") {
      const client: ClientKey = url.searchParams.get("client") === "members" ? "members" : "any";
      const prompt = ["none", "login"].includes(url.searchParams.get("prompt") ?? "") ? url.searchParams.get("prompt") : null;
      return redirect(res, await startLogin(client, prompt));
    }
    if (url.pathname === "/callback") {
      await finishLogin(url.searchParams);
      return redirect(res, "/");
    }
    if (url.pathname === "/logout") return redirect(res, await logoutUrl());
    return send(res, 404, "text/plain", "Not found");
  } catch (error) {
    notice = { kind: "error", title: "Something went wrong", lines: [error instanceof Error ? error.message : String(error)] };
    return redirect(res, "/");
  }
}

createServer((req, res) => void handle(req, res)).listen(PORT, "localhost", () => {
  console.log(`Test app on ${BASE}  (signing in with ${ISSUER})`);
});
