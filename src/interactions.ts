import { Router, urlencoded, type Request, type Response } from "express";
import { parseCookie as parseCookies } from "cookie";
import type Provider from "oidc-provider";
import type { AccountService } from "./accounts.js";
import type { AuditEvent, AuditLog } from "./audit.js";
import type { LoadedClients } from "./clients.js";
import type { Config } from "./config.js";
import type { GitHubClient } from "./github.js";
import { log } from "./log.js";
import { csrfToken, csrfValid, pkcePair, randomToken, safeEqual, sha256 } from "./security.js";
import type { StateBackend } from "./state.js";
import { blockedPage, consentPage, errorPage, membersOnlyPage } from "./views.js";

/**
 * The part of signing in that the provider hands to us: it sends a person to /interaction/<uid> when it needs them to prove who they are or
 * to approve an app, and we send them back to it when that is done.
 *
 * The sign in itself is GitHub's. The chain is:
 *
 *   /interaction/<uid>   a state value and a one-time PKCE verifier are saved, and the browser is sent to GitHub
 *   /callback/github     GitHub sends the browser back. Checks: the state exists and is used once, and belongs to *this* browser (it
 *                        carries a secret cookie only this browser has). The code is exchanged, the profile read, the GitHub token revoked,
 *                        the account found or created, and a one-time "ticket" is left for the last step
 *   /interaction/<uid>/finish   the provider's interaction cookie is only sent to paths under /interaction/<uid>, so the last step has to be
 *                        here. It collects the ticket and tells the provider who signed in.
 *
 * Nothing in the browser's address bar at any point can be used to sign in as someone else: the ticket is looked up by a secret in a cookie,
 * not by anything in a URL.
 */

const UID = /^[A-Za-z0-9_-]{8,128}$/;

export interface InteractionDeps {
  provider: Provider;
  config: Config;
  state: StateBackend;
  accounts: AccountService;
  github: GitHubClient;
  audit: AuditLog;
  clients: LoadedClients;
}

interface Ticket {
  uid: string;
  kind: "login" | "error";
  accountId?: string;
  error?: string;
  description?: string;
}

function parseTicket(raw: string | null): Ticket | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Ticket;
  } catch {
    return null;
  }
}

export function interactionRouter(deps: InteractionDeps): Router {
  const { provider, config, state, accounts, github, audit, clients } = deps;
  const router = Router();
  const form = urlencoded({ extended: false, limit: "4kb" });

  const bindCookie = config.secureCookies ? "__Host-oidc_bind" : "oidc_bind";
  const callbackUrl = `${config.issuer}/callback/github`;
  const nonce = (res: Response) => String((res.locals as { nonce?: string }).nonce ?? "");

  const send = (res: Response, page: { status: number; html: string }) => {
    res.status(page.status).type("html").send(page.html);
  };
  const fail = (res: Response, message: string, status = 400) => send(res, errorPage(nonce(res), message, status));

  const who = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") ?? undefined });
  const record = (req: Request, event: AuditEvent, extra: { accountId?: string | undefined; clientId?: string | undefined } = {}) =>
    audit.record({ event, ...extra, ...who(req) });

  const setBinding = (res: Response, value: string) =>
    res.cookie(bindCookie, value, { httpOnly: true, secure: config.secureCookies, sameSite: "lax", path: "/", maxAge: 10 * 60 * 1000 });
  const clearBinding = (res: Response) =>
    res.clearCookie(bindCookie, { httpOnly: true, secure: config.secureCookies, sameSite: "lax", path: "/" });
  const bindingOf = (req: Request) => {
    const value = parseCookies(req.headers.cookie ?? "")[bindCookie];
    return value && value.length >= 32 && value.length <= 128 ? value : null;
  };

  /** A form post must come from a page of ours (Origin), and carry the token that was put in that page. */
  const sameOrigin = (req: Request) => req.get("origin") === config.issuer;

  /* ------------------------------------------------------------------------------------------ 1. what the provider needs */

  router.get("/interaction/:uid", async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    const { uid, prompt, params } = details;
    const clientId = String(params.client_id ?? "");
    const client = clients.policies.get(clientId);

    switch (prompt.name) {
      case "login": {
        const { verifier, challenge } = pkcePair();
        const stateValue = randomToken(32);
        const binding = randomToken(32);
        await state.exec([
          { t: "set", key: `oidc:gh:${sha256(stateValue)}`, value: JSON.stringify({ uid, bind: sha256(binding), v: verifier }), ex: 600 },
        ]);
        setBinding(res, binding);
        res.redirect(303, github.authorizeUrl({ state: stateValue, codeChallenge: challenge, redirectUri: callbackUrl }));
        return;
      }

      case "consent": {
        const accountId = details.session?.accountId;
        const snapshot = accountId ? await accounts.snapshot(accountId) : null;
        const missing = (prompt.details as { missingOIDCScope?: string[] }).missingOIDCScope ?? [];
        send(
          res,
          consentPage({
            uid,
            csrf: csrfToken(config.csrfSecret, uid),
            clientName: client?.name ?? clientId,
            scopes: ["openid", ...missing.filter((s) => s !== "openid")],
            accountLabel: snapshot?.name ?? snapshot?.login ?? "your account",
            nonce: nonce(res),
          }),
        );
        return;
      }

      case "club_access": {
        await record(req, "access.denied_not_member", { accountId: details.session?.accountId, clientId });
        send(
          res,
          membersOnlyPage({
            uid,
            csrf: csrfToken(config.csrfSecret, uid),
            clientName: client?.name ?? clientId,
            infoUrl: config.membershipInfoUrl,
            nonce: nonce(res),
          }),
        );
        return;
      }

      default:
        fail(res, "This step of signing in is not available.");
    }
  });

  /* ------------------------------------------------------------------------------------------ 2. GitHub sends the browser back */

  router.get("/callback/github", async (req, res) => {
    const stateValue = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const upstreamError = typeof req.query.error === "string" ? req.query.error : "";
    const binding = bindingOf(req);

    // The record is looked at first and only used up once it is known to belong to this browser, so that someone who learns a state value
    // cannot burn another person's sign in just by presenting it.
    const key = `oidc:gh:${sha256(stateValue)}`;
    const raw = stateValue.length >= 16 && stateValue.length <= 128 ? await state.get(key) : null;
    let saved: { uid: string; bind: string; v: string } | null = null;
    try {
      saved = raw ? (JSON.parse(raw) as { uid: string; bind: string; v: string }) : null;
    } catch {
      saved = null;
    }

    const ownedByThisBrowser = !!saved && !!binding && UID.test(saved.uid) && safeEqual(saved.bind, sha256(binding));
    // getdel: of two requests presenting the same state at the same moment, exactly one gets it.
    if (!ownedByThisBrowser || !saved || !binding || (await state.getdel(key)) === null) {
      await record(req, "login.denied_state");
      clearBinding(res);
      fail(res, "This sign in link has expired or was not started in this browser.");
      return;
    }

    const leaveTicket = async (ticket: Omit<Ticket, "uid">) => {
      await state.exec([
        { t: "set", key: `oidc:tk:${sha256(binding)}`, value: JSON.stringify({ uid: saved.uid, ...ticket } satisfies Ticket), ex: 120 },
      ]);
      res.redirect(303, `/interaction/${saved.uid}/finish`);
    };

    // The person pressed "cancel" on GitHub (or GitHub refused). The app is told, in the standard way, that access was denied.
    if (upstreamError || !code) {
      await record(req, "login.cancelled");
      await leaveTicket({ kind: "error", error: "access_denied", description: "The sign in was cancelled." });
      return;
    }

    let profile;
    try {
      const token = await github.exchange({ code, codeVerifier: saved.v, redirectUri: callbackUrl });
      profile = await github.profile(token);
      // Done with it. It was never stored, and now it cannot be used either.
      await github.revoke(token);
    } catch (error) {
      log("warn", "github sign in failed", { error: error instanceof Error ? error.message : String(error) });
      await record(req, "login.denied_upstream");
      await leaveTicket({
        kind: "error",
        error: "temporarily_unavailable",
        description: "GitHub could not confirm the sign in. Try again.",
      });
      return;
    }

    const snapshot = await accounts.signIn(profile);
    if (snapshot.status !== "active") {
      await record(req, "login.denied_blocked", { accountId: snapshot.id });
      clearBinding(res);
      send(res, blockedPage(nonce(res)));
      return;
    }

    await record(req, "login.success", { accountId: snapshot.id });
    await leaveTicket({ kind: "login", accountId: snapshot.id });
  });

  /* ------------------------------------------------------------------------------------------ 3. hand the result to the provider */

  router.get("/interaction/:uid/finish", async (req, res) => {
    const uid = req.params.uid;
    const binding = bindingOf(req);
    const raw = binding ? await state.getdel(`oidc:tk:${sha256(binding)}`) : null;
    const ticket = parseTicket(raw);
    clearBinding(res);

    if (!ticket || ticket.uid !== uid) {
      fail(res, "This sign in could not be completed. Go back to the app and try again.");
      return;
    }

    if (ticket.kind === "login" && ticket.accountId) {
      await provider.interactionFinished(
        req,
        res,
        // `remember`: a persistent session, which is what lets the next app sign in with no screen at all.
        { login: { accountId: ticket.accountId, remember: true } },
        { mergeWithLastSubmission: false },
      );
      return;
    }

    await provider.interactionFinished(
      req,
      res,
      { error: ticket.error ?? "access_denied", error_description: ticket.description ?? "The sign in was not completed." },
      { mergeWithLastSubmission: false },
    );
  });

  /* ------------------------------------------------------------------------------------------ approving an app (other people's apps) */

  router.post("/interaction/:uid/confirm", form, async (req, res) => {
    const uid = String(req.params.uid);
    if (!sameOrigin(req) || !csrfValid(config.csrfSecret, uid, (req.body as Record<string, unknown>)?.csrf)) {
      fail(res, "This form could not be verified. Go back and try again.", 403);
      return;
    }

    const details = await provider.interactionDetails(req, res);
    if (details.uid !== uid || details.prompt.name !== "consent" || !details.session?.accountId) {
      fail(res, "This step of signing in is not available.");
      return;
    }

    const { prompt, params, session } = details;
    let grantId = details.grantId;
    const grant = grantId
      ? await provider.Grant.find(grantId)
      : new provider.Grant({ accountId: session.accountId, clientId: String(params.client_id) });
    if (!grant) {
      fail(res, "This approval has expired. Go back and try again.");
      return;
    }

    const missing = (prompt.details as { missingOIDCScope?: string[]; missingOIDCClaims?: string[] }) ?? {};
    if (missing.missingOIDCScope?.length) grant.addOIDCScope(missing.missingOIDCScope.join(" "));
    if (missing.missingOIDCClaims?.length) grant.addOIDCClaims(missing.missingOIDCClaims);

    grantId = await grant.save();
    await record(req, "consent.granted", { accountId: session.accountId, clientId: String(params.client_id) });
    await provider.interactionFinished(req, res, { consent: details.grantId ? {} : { grantId } }, { mergeWithLastSubmission: true });
  });

  router.post("/interaction/:uid/abort", form, async (req, res) => {
    const uid = String(req.params.uid);
    if (!sameOrigin(req) || !csrfValid(config.csrfSecret, uid, (req.body as Record<string, unknown>)?.csrf)) {
      fail(res, "This form could not be verified. Go back and try again.", 403);
      return;
    }
    const details = await provider.interactionDetails(req, res);
    await record(req, "consent.declined", { accountId: details.session?.accountId, clientId: String(details.params.client_id) });
    await provider.interactionFinished(
      req,
      res,
      { error: "access_denied", error_description: "The person did not continue." },
      { mergeWithLastSubmission: false },
    );
  });

  return router;
}
