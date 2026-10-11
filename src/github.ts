import type { GitHubProfile } from "./accounts.js";

/**
 * GitHub is where people prove who they are. This service asks GitHub two things, "who is this?" and "what is their verified email?", and
 * then throws the GitHub token away (it is revoked right after use). It is never stored and never given to an app.
 */

export interface GitHubClient {
  authorizeUrl(params: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** Swaps the one-time code for an access token. Throws if GitHub refuses. */
  exchange(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<string>;
  profile(accessToken: string): Promise<GitHubProfile>;
  /** Best effort: the token has done its job. */
  revoke(accessToken: string): Promise<void>;
}

const TIMEOUT_MS = 8_000;

export class GitHubError extends Error {}

export class HttpGitHubClient implements GitHubClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorizeUrl({ state, codeChallenge, redirectUri }: { state: string; codeChallenge: string; redirectUri: string }) {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    // read:user for the profile, user:email for the verified address. Nothing that can read or change anyone's code.
    url.searchParams.set("scope", "read:user user:email");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchange({ code, codeVerifier, redirectUri }: { code: string; codeVerifier: string; redirectUri: string }) {
    const response = await this.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // GitHub answers 200 even when it says no: the answer is in the body.
    const body = (await response.json().catch(() => null)) as { access_token?: string; error?: string } | null;
    if (!body?.access_token) throw new GitHubError(`GitHub would not exchange the code: ${body?.error ?? response.status}`);
    return body.access_token;
  }

  private async api<T>(path: string, accessToken: string): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "usar-foss-oidc",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new GitHubError(`GitHub ${path} answered ${response.status}`);
    return (await response.json()) as T;
  }

  async profile(accessToken: string): Promise<GitHubProfile> {
    const user = await this.api<{ id: number; login: string; name: string | null; avatar_url: string | null; email: string | null }>(
      "/user",
      accessToken,
    );
    if (!user.id || !user.login) throw new GitHubError("GitHub's answer had no id.");

    // The address on the profile may be unset or unverified. Only a verified primary address is ever reported as verified.
    let email: string | null = null;
    let emailVerified = false;
    try {
      const emails = await this.api<{ email: string; primary: boolean; verified: boolean }[]>("/user/emails", accessToken);
      const primary = emails.find((e) => e.primary && e.verified);
      if (primary) {
        email = primary.email;
        emailVerified = true;
      }
    } catch {
      // No email is better than no sign in: the address is a convenience for apps, not a requirement.
    }

    return {
      id: String(user.id),
      login: user.login,
      name: user.name?.trim() || null,
      email,
      emailVerified,
      picture: user.avatar_url,
    };
  }

  async revoke(accessToken: string) {
    try {
      await this.fetchImpl(`https://api.github.com/applications/${encodeURIComponent(this.clientId)}/token`, {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/json",
          "User-Agent": "usar-foss-oidc",
        },
        body: JSON.stringify({ access_token: accessToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // The token expires by itself (and was never stored), so a failure here is not worth interrupting anyone for.
    }
  }
}
