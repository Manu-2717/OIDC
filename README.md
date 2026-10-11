# USAR FOSS OIDC

One sign in for every USAR FOSS Club app. People sign in once with GitHub, and every club app (the quiz, the forums, the website) knows who
they are, without ever seeing a GitHub token or a password.

It is an [OpenID Connect](https://openid.net/specs/openid-connect-core-1_0.html) provider: the standard that "Sign in with Google" uses,
which means anything that can sign in with Google (Discourse, next-auth, openid-client, Django, Go, mobile apps) can sign in with this.

```
quiz.fossclub.tech  ─┐
forums.fossclub.tech ┼──►  oidc.fossclub.tech  ──►  GitHub  ──►  "member of the club?" (the main website's database)
fossclub.tech        ─┘          the only place anyone signs in
```

## What it does

- **One click for the second app.** Once someone is signed in, any other club app signs them in with no screen at all.
- **Quiet checks** (`prompt=none`) answer in the standard way: a code if they are signed in, `login_required` if not.
- **Membership.** Tokens say whether the person is a club member and their role. An app can be set to members only.
- **Sign out for everyone** with the standard RP-initiated logout.
- **Blocking** a person ends their sessions everywhere within a minute.

## What it deliberately does not do

One flow only (authorization code with PKCE), no implicit or password grants, no refresh tokens, no dynamic client registration, no
introspection. Fewer features is fewer ways to go wrong. See [docs/SECURITY.md](docs/SECURITY.md).

## Run it locally

```bash
npm install
cp .env.example .env          # then fill it in; `npm run keys:generate` makes the secrets
npm run db:migrate            # DATABASE_URL must be the owner's direct address for this one command
npm run dev                   # http://localhost:3000/.well-known/openid-configuration
```

To try the whole thing without any account, run the tests: they use an in-memory store and a fake GitHub.

| Command                 | What it does                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `npm test`              | All tests, twice: against memory, and through the real Upstash client against a fake Redis server |
| `npm run test:postgres` | The SQL against a real Postgres (set `TEST_DATABASE_URL`)                                         |
| `npm run check`         | Types, lint, format and tests                                                                     |
| `npm run keys:generate` | Prints a signing key, cookie keys and secrets. Nothing is written to disk                         |
| `npm run clients:check` | Checks `clients.json` the way the service reads it                                                |
| `npm run account`       | `show`, `block` or `unblock` an account                                                           |

## Where things are

| Path                                | What                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| `src/provider.ts`                   | The OpenID Connect server and its (narrow) configuration            |
| `src/interactions.ts`               | The sign in with GitHub, and the approval and "members only" pages  |
| `src/adapter.ts`                    | The provider's storage, on Redis                                    |
| `src/accounts.ts`, `src/members.ts` | Accounts (Postgres) and the member lookup (main website's database) |
| `clients.json`                      | The apps that may sign people in                                    |
| `db/`                               | The migration and the database logins                               |
| `docs/`                             | How it works, how to set it up, how to add an app, runbooks         |

## Docs

- [Architecture](docs/ARCHITECTURE.md): how a sign in works, what is stored where, what happens when something is down
- [Security](docs/SECURITY.md): the threats it is built against, and what it does not protect against
- [Setup](docs/SETUP.md): the accounts to create and the settings to make, step by step
- [Adding an app](docs/ADDING-AN-APP.md): with ready configurations for next-auth, Discourse and openid-client
- [Runbooks](docs/runbooks/README.md): rotating keys, blocking someone, when things go wrong

Licensed under the Apache License 2.0.
