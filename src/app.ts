import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { errors } from "oidc-provider";
import type { AccountService } from "./accounts.js";
import type { AuditLog } from "./audit.js";
import type { LoadedClients } from "./clients.js";
import type { Config } from "./config.js";
import type { GitHubClient } from "./github.js";
import { interactionRouter } from "./interactions.js";
import { log } from "./log.js";
import { createProvider } from "./provider.js";
import { randomToken } from "./security.js";
import type { StateBackend } from "./state.js";
import { errorPage } from "./views.js";

export interface AppDeps {
  config: Config;
  state: StateBackend;
  accounts: AccountService;
  audit: AuditLog;
  github: GitHubClient;
  clients: LoadedClients;
  /** Things `/readyz` checks. Each answers true when it is working. */
  readiness: Record<string, () => Promise<boolean>>;
  /** Per minute limits to use instead of the defaults, by rule name. For tests. */
  limitOverrides?: Partial<Record<string, number>>;
}

/**
 * How many requests one address may make in a minute, by what it is doing. They are generous on purpose: a campus Wi-Fi puts many students
 * behind a few addresses, and the apps' own servers make every token call from one. They are there to stop floods and guessing, not people.
 */
const LIMITS: { name: string; match: RegExp; perMinute: number }[] = [
  { name: "token", match: /^\/token(\/|$)/, perMinute: 600 },
  { name: "auth", match: /^\/auth(\/|$)/, perMinute: 300 },
  { name: "me", match: /^\/me$/, perMinute: 600 },
  { name: "session", match: /^\/session\//, perMinute: 60 },
  { name: "interaction", match: /^\/(interaction|callback)\//, perMinute: 120 },
  { name: "public", match: /^\/(\.well-known|jwks)/, perMinute: 1200 },
  { name: "ready", match: /^\/readyz$/, perMinute: 30 },
];

export function createApp(deps: AppDeps): Express {
  const { config, state } = deps;
  const provider = createProvider(deps);
  const app = express();

  app.disable("x-powered-by");
  // Exactly one proxy (Vercel's) stands in front of this service, and its client address is the one to believe.
  app.set("trust proxy", 1);

  /* ------------------------------------------------------------------------------------------ every request */

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.nonce = randomToken(16);
    res.locals.requestId = req.get("x-vercel-id") ?? randomUUID();
    res.setHeader("X-Request-Id", String(res.locals.requestId));
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'none'"],
          "style-src": [(_req, res) => `'nonce-${String((res as Response).locals.nonce)}'`],
          "img-src": ["'self'", "https://avatars.githubusercontent.com", "data:"],
          "base-uri": ["'none'"],
          "frame-ancestors": ["'none'"],
          // `form-action` is deliberately absent: browsers apply it to the redirects that follow a form post, and finishing a sign in
          // redirects to the app, which would be blocked.
        },
      },
      strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: false },
      referrerPolicy: { policy: "no-referrer" },
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-site" },
      xFrameOptions: { action: "deny" },
    }),
  );

  // Everything here is about one person's sign in, so nothing may be kept by a browser or a shared cache, apart from the key set.
  app.use((req, res, next) => {
    if (!/^\/(jwks|\.well-known)/.test(req.path)) res.setHeader("Cache-Control", "no-store");
    next();
  });

  /* ------------------------------------------------------------------------------------------ rate limits */

  const sessionCookie = config.secureCookies ? "__Host-oidc_session" : "_session";
  const limitFor = (name: string, fallback: number) => deps.limitOverrides?.[name] ?? fallback;

  /** True if this address (or everyone together) has used up `limit` for this kind of request in the current minute. */
  const overLimit = async (counter: string, limit: number) => {
    const minute = Math.floor(Date.now() / 60_000);
    return (await state.incrWindow(`oidc:rl:${counter}:${minute}`, 120)) > limit;
  };

  const turnAway = (res: Response, rule: string, ip: string) => {
    log("warn", "rate limited", { rule, ip });
    res.setHeader("Retry-After", "30");
    res.status(429).json({ error: "too_many_requests", error_description: "Too many requests. Wait a moment and try again." });
  };

  app.use(async (req, res, next) => {
    try {
      // Starting a sign in from nothing is the one thing anyone on the internet can do that writes to Redis (it creates a session and a
      // sign in in progress), so it has a tighter limit of its own, per address and for everyone together. Someone who is already signed
      // in is not affected, and neither are the people in the middle of a sign in.
      if (req.path === "/auth" && !(req.headers.cookie ?? "").includes(`${sessionCookie}=`)) {
        const perAddress = await overLimit(`authanon:${req.ip}`, limitFor("authAnonIp", 60));
        const everyone = await overLimit("authanon:all", limitFor("authAnonAll", 600));
        if (perAddress || everyone) return turnAway(res, perAddress ? "authAnonIp" : "authAnonAll", String(req.ip));
      }

      const rule = LIMITS.find((l) => l.match.test(req.path));
      if (rule && (await overLimit(`${rule.name}:${req.ip}`, limitFor(rule.name, rule.perMinute)))) {
        return turnAway(res, rule.name, String(req.ip));
      }
    } catch {
      // If the counter itself is unreachable, people are let through: a broken limiter must not become an outage.
    }
    next();
  });

  /* ------------------------------------------------------------------------------------------ health */

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Answered from a short lived copy: this one touches the database, and a database that is asked every second never gets to sleep.
  let readiness: { at: number; ok: boolean; results: Record<string, boolean> } | null = null;
  app.get("/readyz", async (_req, res) => {
    if (!readiness || Date.now() - readiness.at > 15_000) {
      const results: Record<string, boolean> = {};
      await Promise.all(
        Object.entries(deps.readiness).map(async ([name, check]) => {
          results[name] = await check().catch(() => false);
        }),
      );
      readiness = { at: Date.now(), ok: Object.values(results).every(Boolean), results };
    }
    res.status(readiness.ok ? 200 : 503).json({ ok: readiness.ok, ...readiness.results });
  });

  /* ------------------------------------------------------------------------------------------ the service */

  app.use(interactionRouter({ ...deps, provider }));
  app.use(provider.callback());

  /* ------------------------------------------------------------------------------------------ anything unexpected */

  const onError: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (res.headersSent) return next(error);

    // The sign in cookie is gone or the sign in timed out: the person has to start again from the app.
    if (error instanceof errors.SessionNotFound) {
      res
        .status(400)
        .type("html")
        .send(errorPage(String(res.locals.nonce), "This sign in has expired. Go back to the app and try again.").html);
      return;
    }

    log("error", "unhandled error", {
      path: req.path,
      requestId: res.locals.requestId,
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    res
      .status(500)
      .type("html")
      .send(errorPage(String(res.locals.nonce), "Something went wrong on our side. Try again in a minute.", 500).html);
  };
  app.use(onError);

  return app;
}
