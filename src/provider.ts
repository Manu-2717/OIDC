import Provider, { interactionPolicy, type Account, type Configuration, type KoaContextWithOIDC } from "oidc-provider";
import type { AccountService, AccountSnapshot } from "./accounts.js";
import { createAdapter } from "./adapter.js";
import type { AuditLog } from "./audit.js";
import type { LoadedClients } from "./clients.js";
import type { Config } from "./config.js";
import { LIFETIMES } from "./lifetimes.js";
import { log } from "./log.js";
import type { StateBackend } from "./state.js";
import { loggedOutPage, logoutPage, errorPage } from "./views.js";

/**
 * The OpenID Connect server itself, configured as narrowly as it can be while still being useful:
 *  - one flow, the authorization code flow, and PKCE is required for every app (public or confidential),
 *  - no implicit or hybrid flow, no password grant, no client credentials, no device flow, no dynamic registration,
 *  - no refresh tokens: apps keep their own sessions, and signing in again is one redirect while the sign in here is alive,
 *  - short lived tokens (ten minutes), a sign in code that works once for one minute,
 *  - ID tokens signed with RS256 only.
 */

/** The claims an app can receive, by scope. */
const CLAIMS = {
  openid: ["sub"],
  profile: ["name", "preferred_username", "picture", "updated_at"],
  email: ["email", "email_verified"],
  club: ["member", "role"],
  // Released only to apps registered with `release_github_id` (see clients.ts): the main website matches its members by it.
  github: ["github_id"],
} as const;

/** The scopes this service knows. Anything else an app asks for is dropped by the provider. */
export const SCOPES = ["openid", "profile", "email", "club", "github"] as const;

export const claimsFor = (snapshot: AccountSnapshot) => ({
  sub: snapshot.id,
  name: snapshot.name ?? snapshot.login,
  preferred_username: snapshot.login,
  ...(snapshot.picture ? { picture: snapshot.picture } : {}),
  ...(snapshot.email ? { email: snapshot.email, email_verified: snapshot.emailVerified } : {}),
  updated_at: snapshot.updatedAt,
  member: snapshot.member,
  ...(snapshot.role ? { role: snapshot.role } : {}),
  // Only ever put in a token when the app asked for the `github` scope, which only the apps allowed it can be granted.
  ...(snapshot.githubId ? { github_id: snapshot.githubId } : {}),
});

export interface ProviderDeps {
  config: Config;
  state: StateBackend;
  accounts: AccountService;
  clients: LoadedClients;
  audit: AuditLog;
}

/** The nonce the Express layer put in this response's Content-Security-Policy, so the pages rendered here can use it. */
const nonceOf = (ctx: KoaContextWithOIDC) => (ctx.res as unknown as { locals?: { nonce?: string } }).locals?.nonce ?? "";

export function createProvider({ config, state, accounts, clients, audit }: ProviderDeps) {
  const { Prompt, Check, base } = interactionPolicy;

  /**
   * Apps that are for members only get an extra step in the sign in: after the person has signed in, if they are not a member, the flow
   * stops with "access_denied" (or, for a silent check with prompt=none, answers with that error straight away).
   */
  const policy = base();

  // A session whose account has since been blocked (or deleted) must not count as signed in. Left alone, the provider would find the
  // session, fail to load the account, and carry on half way (an internal error). This turns it into the ordinary "sign in again": for a
  // quiet check (prompt=none) that is login_required, and the sign in itself then refuses a blocked account.
  policy.get("login")?.checks.add(
    new Check("account_unavailable", "the account for this session can no longer be used", "login_required", async (ctx) => {
      const accountId = ctx.oidc.session?.accountId;
      if (!accountId) return Check.NO_NEED_TO_PROMPT;
      const snapshot = await accounts.snapshot(accountId);
      return snapshot && snapshot.status === "active" ? Check.NO_NEED_TO_PROMPT : Check.REQUEST_PROMPT;
    }),
    0,
  );

  policy.add(
    new Prompt(
      { name: "club_access", requestable: false },
      () => ({}),
      new Check("member_required", "this app is only for club members", "access_denied", async (ctx) => {
        const client = ctx.oidc.client;
        const accountId = ctx.oidc.session?.accountId;
        if (!client || !accountId) return Check.NO_NEED_TO_PROMPT;
        if (!clients.policies.get(client.clientId)?.requireMember) return Check.NO_NEED_TO_PROMPT;
        const snapshot = await accounts.snapshot(accountId);
        return snapshot?.member ? Check.NO_NEED_TO_PROMPT : Check.REQUEST_PROMPT;
      }),
    ),
    1, // after "login", before "consent"
  );

  const configuration: Configuration = {
    adapter: createAdapter(state),
    clients: clients.metadata,

    async findAccount(_ctx, sub): Promise<Account | undefined> {
      const snapshot = await accounts.snapshot(sub);
      // A blocked or deleted account is simply not found, which ends its sessions and makes its tokens useless within minutes.
      if (!snapshot || snapshot.status !== "active") return undefined;
      return { accountId: sub, claims: async () => claimsFor(snapshot) };
    },

    jwks: config.jwks as unknown as Configuration["jwks"],
    cookies: {
      keys: config.cookieKeys,
      // `secure` is left to the provider: it follows the real protocol of the request (we are behind Vercel's proxy), so it is on in
      // production and the service still works over plain http on a laptop.
      long: { httpOnly: true, sameSite: "lax" },
      short: { httpOnly: true, sameSite: "lax" },
      // The __Host- prefix makes browsers refuse the cookie unless it is Secure, set from this exact host and valid for the whole site.
      // (The two interaction cookies are scoped to one path each, which that prefix does not allow, so they keep their plain names.)
      names: config.secureCookies ? { session: "__Host-oidc_session" } : {},
    },

    scopes: [...SCOPES],
    claims: CLAIMS as unknown as Configuration["claims"],
    // Put the claims in the ID token itself, so most apps never need a second call to the userinfo endpoint.
    conformIdTokenClaims: false,

    // Every app uses PKCE, including the ones with a secret: a stolen code is useless without the verifier.
    pkce: { required: () => true },
    responseTypes: ["code"],
    clientAuthMethods: ["client_secret_basic", "client_secret_post", "none"],
    enabledJWA: { idTokenSigningAlgValues: ["RS256"] },
    clockTolerance: 10,

    ttl: { ...LIFETIMES },

    features: {
      // On by default, and accepts any username with any password. It must be off.
      devInteractions: { enabled: false },
      userinfo: { enabled: true },
      revocation: { enabled: true },
      introspection: { enabled: false },
      registration: { enabled: false },
      registrationManagement: { enabled: false },
      clientCredentials: { enabled: false },
      deviceFlow: { enabled: false },
      rpInitiatedLogout: {
        enabled: true,
        async logoutSource(ctx, form) {
          const { status, html } = logoutPage({ form, host: ctx.host, nonce: nonceOf(ctx) });
          ctx.status = status;
          ctx.type = "html";
          ctx.body = html;
        },
        async postLogoutSuccessSource(ctx) {
          const { status, html } = loggedOutPage(nonceOf(ctx));
          ctx.status = status;
          ctx.type = "html";
          ctx.body = html;
        },
      },
    },

    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
      policy,
    },

    // The one-click part of single sign on. For one of our own (trusted) apps, signing in *is* the approval, so the grant is made on the
    // spot and the person is never asked. For any other app the provider falls through to the consent page.
    async loadExistingGrant(ctx) {
      const { oidc } = ctx;
      const clientId = oidc.client?.clientId;
      if (!clientId) return undefined;

      const grantId = oidc.result?.consent?.grantId ?? oidc.session?.grantIdFor(clientId);
      if (grantId) return oidc.provider.Grant.find(grantId);

      if (!clients.policies.get(clientId)?.trusted || !oidc.session?.accountId) return undefined;

      const grant = new oidc.provider.Grant({ clientId, accountId: oidc.session.accountId });
      // Only what the app is registered for and actually asked for, never more.
      const allowed = new Set((oidc.client?.scope ?? "").split(" "));
      const asked = String(oidc.params?.scope ?? "")
        .split(" ")
        .filter((scope) => scope && allowed.has(scope) && (SCOPES as readonly string[]).includes(scope));
      if (asked.length > 0) grant.addOIDCScope(asked.join(" "));
      await grant.save();
      return grant;
    },

    // No refresh tokens at all. See the note at the top of this file.
    issueRefreshToken: async () => false,

    async renderError(ctx, out, error) {
      // `out` is already safe to show (it carries only the standard error code and description). The detail goes to the log, not the page.
      log("warn", "error page shown", { route: ctx.oidc?.route, error: out.error, description: out.error_description, name: error.name });
      const { status, html } = errorPage(nonceOf(ctx), out.error_description ?? "The request could not be completed.", ctx.status || 400);
      ctx.status = status;
      ctx.type = "html";
      ctx.body = html;
    },
  };

  const provider = new Provider(config.issuer, configuration);
  // We are behind Vercel's proxy: trust x-forwarded-proto and x-forwarded-for, so the discovery document and the cookies get the real https.
  provider.proxy = true;

  // The library always lists refresh_token among the grants it can do. This service never issues one, and no app is registered for that
  // grant, so the discovery document says what is true.
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.oidc?.route === "discovery" && ctx.body && typeof ctx.body === "object") {
      (ctx.body as { grant_types_supported?: string[] }).grant_types_supported = ["authorization_code"];
    }
  });

  provider.on("server_error", (_ctx, error) => {
    log("error", "provider server error", { name: error.name, message: error.message });
  });
  // A code was exchanged for tokens: an app has signed this person in.
  provider.on("grant.success", (ctx) => {
    void audit.record({
      event: "app.signin",
      accountId: ctx.oidc.account?.accountId ?? ctx.oidc.entities.AuthorizationCode?.accountId,
      clientId: ctx.oidc.client?.clientId,
      ip: ctx.ip,
      userAgent: ctx.get("user-agent"),
    });
  });
  provider.on("end_session.success", (ctx) => {
    void audit.record({
      event: "logout",
      accountId: ctx.oidc.session?.accountId,
      clientId: ctx.oidc.client?.clientId,
      ip: ctx.ip,
      userAgent: ctx.get("user-agent"),
    });
  });

  return provider;
}
