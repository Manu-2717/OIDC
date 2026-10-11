# Adding an app

Any app that can "sign in with an OpenID Connect provider" can use this. Nothing here is specific to a language or framework.

## 1. Register it

The quick way is one command. It adds the entry to `clients.json`, makes the secret and prints the settings for both sides:

```bash
npm run client:new -- monkeytype --redirect https://monkeytype.fossclub.tech/auth/callback --members-only
```

Options: `--logout <address>`, `--name "<text>"`, `--public` (no secret, PKCE only), `--untrusted`. The secret is shown once. What the command
does by hand is described below.

Add it to `clients.json` (a reviewed change, so a pull request):

```json
{
  "client_id": "quiz",
  "client_name": "FOSS Club Quiz",
  "redirect_uris": ["https://quiz.fossclub.tech/api/auth/callback/fossclub"],
  "post_logout_redirect_uris": ["https://quiz.fossclub.tech"],
  "type": "confidential",
  "trusted": true,
  "require_member": false
}
```

| Field                       | Meaning                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `client_id`                 | Lowercase letters, digits and dashes. Appears in tokens as the audience.                                             |
| `redirect_uris`             | Where the app receives the code. Matched **exactly**: no wildcards, https only (http for localhost).                 |
| `post_logout_redirect_uris` | Where the person lands after signing out.                                                                            |
| `type`                      | `confidential` for an app with a server (it has a secret). `public` for a single page or mobile app (PKCE only).     |
| `trusted`                   | One of ours: people are signed in without being asked. Use `false` for anyone else's app: they see an approval page. |
| `require_member`            | Only club members can use this app. Anyone else gets `access_denied` and a page saying why.                          |
| `release_github_id`         | Lets the app ask for the `github` scope, which adds `github_id` to the token. For the main website only (see below). |

Then give it a secret (confidential apps): a variable called `CLIENT_SECRET_` plus the id in capitals, dashes as underscores
(`quiz` becomes `CLIENT_SECRET_QUIZ`). Make one with `openssl rand -base64 48`, put it in Vercel (Sensitive) and in the app's own settings.

```bash
npm run clients:check      # catches a bad address before it is deployed
```

## 2. Configure the app

| Setting               | Value                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Issuer / discovery    | `https://oidc.fossclub.tech` (the discovery document is at `/.well-known/openid-configuration`) |
| Client id             | the `client_id`                                                                                 |
| Client secret         | the secret above (not for `public` apps)                                                        |
| Scopes                | `openid profile email club`                                                                     |
| PKCE                  | **on** (`S256`). This service refuses an app that does not use it.                              |
| Client authentication | `client_secret_basic` (or `client_secret_post` if `clients.json` says so)                       |
| Signing algorithm     | `RS256`                                                                                         |

### next-auth (v4)

```ts
providers: [
  {
    id: "fossclub",
    name: "USAR FOSS Club",
    type: "oauth",
    wellKnown: "https://oidc.fossclub.tech/.well-known/openid-configuration",
    authorization: { params: { scope: "openid profile email club" } },
    idToken: true,
    checks: ["pkce", "state", "nonce"],
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    profile(profile) {
      return {
        id: profile.sub,
        name: profile.name,
        email: profile.email,
        image: profile.picture,
        member: profile.member,
        role: profile.role,
      };
    },
  },
];
```

The callback address to register is `https://<your app>/api/auth/callback/fossclub`.

### openid-client (Node)

```ts
import * as client from "openid-client";

const config = await client.discovery(new URL("https://oidc.fossclub.tech"), "quiz", process.env.OIDC_CLIENT_SECRET);
const verifier = client.randomPKCECodeVerifier();
const url = client.buildAuthorizationUrl(config, {
  redirect_uri: "https://quiz.fossclub.tech/callback",
  scope: "openid profile email club",
  code_challenge: await client.calculatePKCECodeChallenge(verifier),
  code_challenge_method: "S256",
  state: client.randomState(),
});
// ... keep the verifier and state in the app's session, redirect to `url`, and on the callback:
const tokens = await client.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: verifier, expectedState });
const claims = tokens.claims(); // sub, name, email, member, role
```

### Discourse (OpenID Connect plugin)

| Field                             | Value                                                         |
| --------------------------------- | ------------------------------------------------------------- |
| openid connect discovery document | `https://oidc.fossclub.tech/.well-known/openid-configuration` |
| client id / client secret         | from above                                                    |
| authorize scope                   | `openid profile email`                                        |
| use PKCE                          | on                                                            |

## 3. Behaviour to rely on

- **Already signed in:** the app is sent back with a code and the person sees nothing.
- **Not signed in:** they go through GitHub once, then back to the app.
- **Quiet check:** add `prompt=none` to the authorization request, as a top level redirect. The answer is a code, or `error=login_required`
  (not signed in), or `error=access_denied` (a members only app and they are not a member).
- **Force a fresh sign in:** `prompt=login`.
- **Sign out:** send the browser to the `end_session_endpoint` from discovery with `id_token_hint`, `post_logout_redirect_uri` and `state`.
  The person confirms once.
- **Keys:** key your own users on `sub`. Check `iss`, `aud`, `exp` and `nonce` (any OpenID library does).

## 4. Keep the app's own session reasonable

Every sign in here is a handful of Redis calls, and every app depends on this service being up. Give the app's own session
a day or more, not minutes, and let it use `prompt=none` only when it needs to re-check.

## Trying the service by hand

`examples/test-app` is a small app that signs in with the hosted service and shows what an app receives: the checked ID token, its claims
and the userinfo answer. It uses the two test registrations in `clients.json` (`oidc-test` and `oidc-test-members`, localhost only).

```bash
npm run example        # then open http://localhost:4000
```

Remove the two test registrations once the first real app is in.

## The main website is the one app that gets the GitHub id

Every app sees `sub`, which is ours and says nothing about GitHub. The main website is the exception: it keeps its member records by GitHub's
numeric id, so it is registered with `"release_github_id": true` and asks for the `github` scope. Only an app with that flag may ask for
it; any other app that does gets `invalid_scope`. Do not set the flag for an app that does not hold member records keyed by GitHub id.

Seeding: `npm run accounts:seed` (dry run) and `npm run accounts:seed -- --apply` create an account for each current member before their
first sign in, so they can be seen and blocked from the start. It is safe to run again.
