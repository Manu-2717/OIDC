import { z } from "zod";

/**
 * Everything the service reads from its environment, checked once at start-up. A missing or weak value stops the service with a message that
 * names it, instead of letting it run in a state where sign-ins quietly weaken.
 */

export interface JwkPrivate {
  kty: string;
  kid: string;
  alg?: string;
  use?: string;
  d?: string;
  [key: string]: unknown;
}

export interface Config {
  /** The address of this service, as it appears in every token. It must never change once an app uses it. */
  issuer: string;
  production: boolean;
  /** Cookies carry the Secure flag (and the __Host- prefix) whenever the issuer is https. */
  secureCookies: boolean;
  databaseUrl: string;
  /** A read-only connection to the main website's database, for the member lookup. Without it nobody is reported as a member. */
  mainDbUrl: string | null;
  redisUrl: string;
  redisToken: string;
  github: { clientId: string; clientSecret: string };
  jwks: { keys: JwkPrivate[] };
  cookieKeys: string[];
  csrfSecret: string;
  /** Where a person who is not a member is pointed to learn how to become one. */
  membershipInfoUrl: string;
  /** Secrets of the confidential apps, from CLIENT_SECRET_<ID> variables. */
  clientSecrets: Record<string, string>;
}

const truthy = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === "" ? fallback : ["1", "true", "yes", "on"].includes(value.toLowerCase());

const schema = z.object({
  ISSUER: z.url(),
  NODE_ENV: z.string().optional(),
  VERCEL_ENV: z.string().optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  MAIN_DB_URL: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  OIDC_JWKS: z.string().min(1, "OIDC_JWKS is required (run `npm run keys:generate`)"),
  COOKIE_KEYS: z.string().min(1, "COOKIE_KEYS is required (run `npm run keys:generate`)"),
  CSRF_SECRET: z.string().min(32, "CSRF_SECRET must be at least 32 characters"),
  MEMBERSHIP_INFO_URL: z.url().optional(),
});

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  const e = parsed.data;

  const issuer = e.ISSUER.replace(/\/+$/, "");
  const url = new URL(issuer);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const production = e.NODE_ENV === "production" || e.VERCEL_ENV === "production";
  if (url.protocol !== "https:" && !local) throw new ConfigError("ISSUER must be an https address (http is only allowed for localhost).");
  if (production && local) throw new ConfigError("ISSUER points at localhost in a production environment.");
  if (url.pathname !== "/" || url.search || url.hash)
    throw new ConfigError("ISSUER must be a bare origin such as https://oidc.fossclub.tech.");

  let jwks: { keys: JwkPrivate[] };
  try {
    jwks = JSON.parse(e.OIDC_JWKS) as { keys: JwkPrivate[] };
  } catch {
    throw new ConfigError("OIDC_JWKS is not valid JSON.");
  }
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new ConfigError("OIDC_JWKS must contain at least one key.");
  const seen = new Set<string>();
  for (const key of jwks.keys) {
    if (key.kty !== "RSA" || !key.d) throw new ConfigError("OIDC_JWKS may only hold RSA private keys (the signing algorithm is RS256).");
    if (!key.kid) throw new ConfigError("Every key in OIDC_JWKS needs a kid.");
    if (seen.has(key.kid)) throw new ConfigError(`OIDC_JWKS has two keys with the kid ${key.kid}.`);
    seen.add(key.kid);
  }

  const cookieKeys = e.COOKIE_KEYS.split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (cookieKeys.length === 0 || cookieKeys.some((k) => k.length < 32)) {
    throw new ConfigError("COOKIE_KEYS must be a comma separated list of random strings of at least 32 characters each.");
  }

  const clientSecrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const match = /^CLIENT_SECRET_([A-Z0-9_]+)$/.exec(name);
    if (match?.[1] && value) clientSecrets[match[1]] = value;
  }

  return {
    issuer,
    production,
    secureCookies: url.protocol === "https:" && truthy(env.SECURE_COOKIES, true),
    databaseUrl: e.DATABASE_URL,
    mainDbUrl: e.MAIN_DB_URL?.trim() || null,
    redisUrl: e.UPSTASH_REDIS_REST_URL,
    redisToken: e.UPSTASH_REDIS_REST_TOKEN,
    github: { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET },
    jwks,
    cookieKeys,
    csrfSecret: e.CSRF_SECRET,
    membershipInfoUrl: e.MEMBERSHIP_INFO_URL ?? "https://www.fossclub.tech",
    clientSecrets,
  };
}
