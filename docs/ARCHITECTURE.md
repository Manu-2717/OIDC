# Architecture

## The parts

```
                                   ┌──────────────────────────────┐
   browser ───────────────────────►│  this service (Vercel)       │
   (a person)                      │  Express + oidc-provider     │
                                   └──┬───────────┬───────────┬───┘
                                      │           │           │
                  short lived state   │           │           │   read only, only the
                  (Upstash Redis)     ▼           ▼           ▼   `oidc_members_v` view
                                   sessions,   accounts,   main website's
                                   codes,      audit log   database (Neon)
                                   tokens      (Neon)
```

| Part                      | Holds                                                                                   | Lost, what happens                                          |
| ------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Redis** (`ufc-oidc`)    | Sessions, sign ins in progress, codes, access tokens, rate limit counters, short caches | Everyone is signed out and signs in again. Nothing else.    |
| **Postgres** (`ufc-oidc`) | Accounts (who exists, blocked or not, last known membership), audit log                 | Real loss. It is backed up (see runbooks).                  |
| **Main website database** | Who is a member, and their role. Read only, through one view.                           | Sign in keeps working on the last known answer.             |
| **GitHub**                | Who the person is. Asked once per sign in; its token is revoked at once.                | New sign ins fail. People already signed in are unaffected. |

## One sign in, step by step

1. The app sends the browser to `/auth` with a PKCE challenge, a `state` and a `nonce`.
2. If there is a session, the provider issues a code straight away (**step 8**). If not, it creates a _sign in in progress_ in Redis and
   sends the browser to `/interaction/<uid>`.
3. We save a one-time GitHub `state`, a PKCE verifier and a hash of a secret cookie value in Redis, and send the browser to GitHub.
4. GitHub sends the browser to `/callback/github`. We check that the `state` exists, belongs to **this browser** (the secret cookie), and
   is used up in the same step, so it works once.
5. We exchange GitHub's code (with the PKCE verifier), read the profile and verified email, and **revoke GitHub's token straight away**.
6. The account is found or created (Postgres) and membership is looked up (cached ten minutes). A blocked account stops here.
7. A one-time ticket is left in Redis, found only by the secret cookie, and the browser is sent to `/interaction/<uid>/finish`, where the
   provider's own cookie is available, and we tell the provider who signed in.
8. The provider redirects to the app with a one-minute, single-use code. The app swaps it (with its secret and the PKCE verifier) for a
   ten-minute ID token carrying the person's claims.

The sign in for the **second** app starts at step 1 and ends at step 8 with no screen: the provider finds the session, and for one of our
own apps the approval is made on the spot.

## What is in the ID token

| Claim                | Scope     | Source                                                 |
| -------------------- | --------- | ------------------------------------------------------ |
| `sub`                | `openid`  | Our own account id (a UUID). Never a GitHub id.        |
| `name`               | `profile` | GitHub name, or the username if there is none          |
| `preferred_username` | `profile` | GitHub username (can change; do not use as a key)      |
| `picture`            | `profile` | GitHub avatar                                          |
| `email`              | `email`   | GitHub's primary email, only if GitHub has verified it |
| `email_verified`     | `email`   | true only for that verified address                    |
| `member`             | `club`    | From the main website's database                       |
| `role`               | `club`    | The member's role there, if any                        |

Apps should key their own users on `sub`.

## Data ownership

| Data                      | Owner                 | How the others get it                             |
| ------------------------- | --------------------- | ------------------------------------------------- |
| Member or not, role       | Main website database | This service reads one view, never writes         |
| Account identity, blocked | This service          | Nobody else needs it                              |
| Name, picture, email      | GitHub                | Copied in at every sign in                        |
| GitHub tokens             | Nobody                | Never stored here; the main website keeps its own |

## When something is down

| Down                  | What people see                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Main website database | Nothing. The last known membership is used, and the database is left alone for 30 seconds between tries.    |
| GitHub                | New sign ins get `temporarily_unavailable` in the app. People already signed in carry on.                   |
| Redis                 | No sign in works (sessions and codes live there). `/readyz` goes red.                                       |
| Postgres              | People with a cached account (5 minutes) carry on. New sign ins and first lookups fail.                     |
| This service          | No new sign in anywhere. Apps keep their own sessions, so people already in an app stay in until those end. |

Because every app depends on this one service, apps should keep their own sessions for a day or more rather than asking again on every visit.

## Cost on the free plans

A sign in is a handful of Redis commands (measured by a test that fails if it grows): about **42** for a first sign in, about **20** for each
further app, about **10** for a quiet check. The free Upstash plan is 500,000 a month, so roughly:

- 100 people a day signing in to two apps each is about 120,000 a month.
- 1,000 active members each signing in to five apps a week would be about 500,000. That is the ceiling, so watch the Upstash graph in the
  first weeks, and prefer longer app sessions to more sign ins.

Postgres is touched only when someone really signs in (and for the five minute account cache), and anything unauthenticated never reaches
it, so Neon sleeps when nobody is signing in.

## Decisions, and why

| Decision                                      | Why                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A certified library, not our own protocol     | The protocol is where authentication systems go wrong. We write the login and the policy.                                        |
| No refresh tokens                             | Apps keep their own sessions, and signing in again is one redirect while the session here is alive. Nothing long lived to steal. |
| RS256 only                                    | The one algorithm every OpenID client must support.                                                                              |
| Claims in the ID token                        | Most apps never need a second call, so fewer requests and fewer Redis commands.                                                  |
| Apps are listed in `clients.json`             | Adding one is a reviewed change, not an API call anyone could make.                                                              |
| `sub` is our own id                           | Usernames change and GitHub ids are not ours to hand out.                                                                        |
| Membership is pulled, cached, with a fallback | No sync job to break, and an outage elsewhere does not stop sign in.                                                             |
| Redis for state, Postgres for what must last  | Expiry is free in Redis, and nothing precious is kept anywhere it can be flushed.                                                |
