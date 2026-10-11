import { z } from "zod";
import type { ClientMetadata } from "oidc-provider";

/**
 * The apps that may sign people in with this service. They are listed in `clients.json`, so adding or changing one is a reviewed change in
 * git, and each secret lives in the environment (CLIENT_SECRET_<ID>), never in the file.
 *
 * There is no dynamic registration: nobody can add an app by calling the service.
 */

const isLoopback = (url: URL) => url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

const redirectUri = z
  .string()
  .max(512)
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.hash) return false; // fragments are forbidden in redirect URIs
      if (value.includes("*")) return false; // matching is exact, so there are no wildcards
      return url.protocol === "https:" || isLoopback(url);
    } catch {
      return false;
    }
  }, "must be an absolute https address (http only for localhost), with no fragment and no wildcard");

const definition = z.object({
  client_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "lowercase letters, digits and dashes, 2 to 40 characters"),
  client_name: z.string().min(1).max(80),
  redirect_uris: z.array(redirectUri).min(1).max(10),
  post_logout_redirect_uris: z.array(redirectUri).max(10).default([]),
  /** `confidential` apps have a server that can keep a secret. `public` ones (single page apps, mobile) rely on PKCE alone. */
  type: z.enum(["confidential", "public"]).default("confidential"),
  token_endpoint_auth_method: z.enum(["client_secret_basic", "client_secret_post"]).default("client_secret_basic"),
  /** A trusted app is one of ours: people are not asked to approve it, they are just signed in. */
  trusted: z.boolean().default(true),
  /** Only people who are club members may use this app. */
  require_member: z.boolean().default(false),
  /**
   * Lets the app ask for the `github` scope, which adds the person's GitHub numeric id to the token. For the club's own main website only:
   * it keys its member records by that id. Every other app sees a `sub` that is ours and nothing that identifies a GitHub account.
   */
  release_github_id: z.boolean().default(false),
});

export type ClientDefinition = z.infer<typeof definition>;

export interface ClientPolicy {
  clientId: string;
  name: string;
  trusted: boolean;
  requireMember: boolean;
}

export interface LoadedClients {
  metadata: ClientMetadata[];
  policies: Map<string, ClientPolicy>;
  /** Problems that kept an app from being registered. They are logged, and `npm run clients:check` fails on them. */
  errors: string[];
}

export const secretVariable = (clientId: string) => `CLIENT_SECRET_${clientId.toUpperCase().replace(/-/g, "_")}`;

export function loadClients(raw: unknown, secrets: Record<string, string>): LoadedClients {
  const out: LoadedClients = { metadata: [], policies: new Map(), errors: [] };

  const list = z.array(z.unknown()).safeParse(raw);
  if (!list.success) {
    out.errors.push("clients.json must be a list");
    return out;
  }

  const seen = new Set<string>();
  list.data.forEach((item, index) => {
    const parsed = definition.safeParse(item);
    if (!parsed.success) {
      const id = typeof (item as { client_id?: unknown })?.client_id === "string" ? (item as { client_id: string }).client_id : `#${index}`;
      out.errors.push(`${id}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      return;
    }
    const def = parsed.data;
    if (seen.has(def.client_id)) {
      out.errors.push(`${def.client_id}: listed twice`);
      return;
    }
    seen.add(def.client_id);

    const metadata: ClientMetadata = {
      client_id: def.client_id,
      client_name: def.client_name,
      redirect_uris: def.redirect_uris,
      post_logout_redirect_uris: def.post_logout_redirect_uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: def.release_github_id ? "openid profile email club github" : "openid profile email club",
      id_token_signed_response_alg: "RS256",
      application_type: "web",
      token_endpoint_auth_method: "none",
    };

    if (def.type === "confidential") {
      const secret = secrets[secretVariable(def.client_id).replace(/^CLIENT_SECRET_/, "")];
      if (!secret) {
        out.errors.push(`${def.client_id}: no secret, set ${secretVariable(def.client_id)}`);
        return;
      }
      if (secret.length < 32) {
        out.errors.push(`${def.client_id}: ${secretVariable(def.client_id)} is shorter than 32 characters`);
        return;
      }
      metadata.client_secret = secret;
      metadata.token_endpoint_auth_method = def.token_endpoint_auth_method;
    }

    out.metadata.push(metadata);
    out.policies.set(def.client_id, {
      clientId: def.client_id,
      name: def.client_name,
      trusted: def.trusted,
      requireMember: def.require_member,
    });
  });

  return out;
}

export interface NewClientOptions {
  id: string;
  /** Shown to people on the sign in pages. Made from the id when it is not given. */
  name?: string | undefined;
  redirects: string[];
  /** Where people land after signing out. The first redirect address's own site when it is not given. */
  logout?: string[] | undefined;
  membersOnly?: boolean | undefined;
  /** A single page app or mobile app, which cannot keep a secret and relies on PKCE alone. */
  publicApp?: boolean | undefined;
  /** Not one of the club's own apps: people are asked to approve it. */
  untrusted?: boolean | undefined;
}

const titleOf = (id: string) =>
  id
    .split("-")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");

/**
 * The entry to put in `clients.json` for a new app, in the same shape and order as the others. It is not checked here: pass it through
 * `loadClients` (the helper script does) so it is held to exactly the rules the running service applies.
 */
export function newClientEntry(o: NewClientOptions) {
  const logout =
    o.logout ??
    o.redirects
      .flatMap((address) => {
        try {
          return [`${new URL(address).origin}/`];
        } catch {
          return [];
        }
      })
      .slice(0, 1);
  return {
    client_id: o.id,
    client_name: o.name ?? `FOSS Club ${titleOf(o.id)}`,
    redirect_uris: o.redirects,
    post_logout_redirect_uris: logout,
    type: o.publicApp ? "public" : "confidential",
    trusted: !o.untrusted,
    require_member: !!o.membersOnly,
  };
}
