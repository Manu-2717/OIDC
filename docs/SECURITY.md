# Security

This is the one place everyone's identity passes through, so it is built to do as little as possible and to refuse everything else. The
tests in `test/` check each control below by trying to break it.

Written against [RFC 9700 (OAuth 2.0 Security Best Current Practice)](https://www.rfc-editor.org/rfc/rfc9700.html) and OpenID Connect Core 1.0.

## What it defends against

| Threat                                               | Control                                                                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A stolen authorization code                          | One minute life, single use, bound to a PKCE verifier only the app has. A second use revokes everything the first one produced.        |
| A code swapped between apps                          | The code is bound to the app that asked for it; another app's attempt is `invalid_grant`.                                              |
| Redirecting a code to an attacker (open redirect)    | Redirect addresses are matched exactly, with no wildcards. An unknown address is an error page, never a redirect.                      |
| Login CSRF / forced login                            | The GitHub `state` is single use and tied to a secret cookie of the browser that began the sign in.                                    |
| A sign in finished in the wrong browser              | The final ticket is found by that same secret cookie, not by anything in a URL.                                                        |
| CSRF on approval and sign out                        | Forms carry a token and are only accepted from this origin.                                                                            |
| Clickjacking                                         | `frame-ancestors 'none'` and `X-Frame-Options: DENY` on every response.                                                                |
| Script injection                                     | No JavaScript is served. The CSP allows only a per-request nonce for the stylesheet, and every outside value is escaped.               |
| Token theft from a browser                           | Tokens last 10 minutes, cookies are `HttpOnly`, `Secure`, `SameSite=Lax` and use the `__Host-` prefix.                                 |
| Implicit, password, client credentials, device flows | Not enabled. Asking for them is refused (tested).                                                                                      |
| An app that forgets PKCE                             | Refused for every app, including ones with a secret.                                                                                   |
| Cross site calls to the token endpoint               | Only a public app may be called from a web page, and only from its own registered address.                                             |
| A blocked person staying in                          | Their account stops being found, so sessions and tokens fail within a minute; the sign in refuses them.                                |
| A leaked database address                            | The service's login can read and write rows only: no drop, truncate or alter (tested against a real Postgres).                         |
| A leaked GitHub token                                | Never stored. Revoked immediately after the profile is read.                                                                           |
| Flooding Redis, or the database, with sign in starts | Per address limits, a tighter limit on anonymous starts (per address and for everyone), and no Postgres access without a real sign in. |
| An unusable server on a bad configuration            | The service refuses to start on a weak secret, an http issuer in production, or a key that is not an RSA private key.                  |
| The development login                                | The library ships one that accepts any password. It is disabled, and a test checks no such page exists.                                |

## Choices that look strict on purpose

- **No silent sign in inside an iframe.** `prompt=none` works as a top level redirect, which is the supported way now (browsers block
  third party cookies in frames anyway). Embedding this service in a frame is refused.
- **The sign in is always GitHub's.** There are no passwords here to leak, reset or guess.
- **Apps have no way to register themselves.** An attacker who finds an endpoint cannot add one.

## What it does not protect against

- **A compromised app.** An app that is breached can misuse the people signed in to it. Keep app sessions short, and block the account or
  rotate the app's secret (runbooks).
- **A compromised GitHub account.** Whoever controls the account signs in as that person. Members should use GitHub's two factor sign in.
- **A compromised signing key or hosting account.** Anyone who holds the signing key can make tokens that apps will believe. Keep it only in
  Vercel's sensitive settings and the password manager, and rotate it on any doubt (runbook).
- **Sign out reaching every app at once.** Signing out ends the session here, and an app finds out at its next sign in check. Back-channel
  logout is available in the library but off, because function instances are frozen the moment a response is sent, which makes
  fire-and-forget calls to apps unreliable. App sessions should therefore be short.
- **Email as an identity.** `email` is a convenience. Key users on `sub`.

## Personal data held

Per account: GitHub numeric id, username, name, verified email, avatar address, last membership answer, last sign in. Audit entries (account,
app, event, address, browser string) are deleted after 180 days. Redis holds sessions and codes for minutes to days. There are no passwords
and no GitHub tokens.

## Keeping it secure

- Dependencies are audited in CI (`npm audit --omit=dev --audit-level=high`) and every GitHub Action is pinned to a commit.
- Secrets live only in Vercel (Sensitive) and the password manager, never in git. `.gitignore` refuses `.env`.
- Review any change to `src/provider.ts`, `src/interactions.ts` and `src/clients.ts` with extra care, and run the whole `npm run check`.

## Reporting a problem

Contact the club's core team directly. Do not open a public issue for a vulnerability.
