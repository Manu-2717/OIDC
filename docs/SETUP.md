# Setup

About an hour, done once. You need: a GitHub account that can create an OAuth app for the `USAR-FOSS` organisation, access to the Vercel
team, and the DNS for `fossclub.tech`.

Make the secrets first (they are printed, not saved):

```bash
npm install
npm run keys:generate
```

Keep the output open. Each value goes into Vercel and into the password manager.

## 1. The database (Neon)

1. [console.neon.tech](https://console.neon.tech), **New project**. Name `ufc-oidc`, Postgres 18, region AWS Singapore (the same as the
   main site, so they are close to each other and to Vercel's `sin1`).
2. **Connect**, role `neondb_owner`, **Pooled connection off**. Copy the string. This is the owner's _direct_ address.
3. Create the tables (once, and again after any new file in `db/migrations`):
   ```bash
   DATABASE_URL="<the owner's direct address>" npm run db:migrate
   ```
4. In the Neon **SQL Editor**, paste `db/roles.sql`, replace the two passwords (`openssl rand -hex 24`) and run it. That makes
   `oidc_app` (what the service runs as) and `oidc_backup`.
5. Build the service's address: the **pooled** host (with `-pooler`), user `oidc_app`, its password. That is `DATABASE_URL`.
6. In **Compute**, set autoscaling to 0.25 CU maximum and leave scale to zero on.

## 2. Short lived state (Upstash)

1. [console.upstash.com](https://console.upstash.com), **Create database**. Name `ufc-oidc`, **Regional**, Singapore.
2. **Turn eviction OFF.** With it on, Redis may throw away a live session when it is full.
3. Copy the REST URL and token (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`).

Use a database of its own: it is not sharing a command allowance with the main website.

## 3. The GitHub sign in

1. GitHub, the `USAR-FOSS` organisation, **Settings, Developer settings, OAuth Apps, New OAuth App**.
2. Name `USAR FOSS Club sign in`. Homepage `https://oidc.fossclub.tech`.
   Authorization callback URL `https://oidc.fossclub.tech/callback/github` (exactly this).
3. Create it, then **Generate a new client secret**. These are `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

For local development make a second OAuth app whose callback is `http://localhost:3000/callback/github`.

## 4. Hosting (Vercel)

1. Push this repository to GitHub (for example `USAR-FOSS/oidc`).
2. Vercel, **Add New Project**, import it. Framework preset **Other**. No build command is needed.
3. Settings, **Environment Variables**, scope **Production** only, tick **Sensitive** on all of them:

   | Name                                                  | Value                                               |
   | ----------------------------------------------------- | --------------------------------------------------- |
   | `ISSUER`                                              | `https://oidc.fossclub.tech`                        |
   | `DATABASE_URL`                                        | the `oidc_app` pooled address from step 1           |
   | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | from step 2                                         |
   | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`           | from step 3                                         |
   | `OIDC_JWKS`, `COOKIE_KEYS`, `CSRF_SECRET`             | from `npm run keys:generate`                        |
   | `CLIENT_SECRET_<APP>`                                 | one per app (see [adding an app](ADDING-AN-APP.md)) |
   | `MAIN_DB_URL`                                         | step 5 below (can wait)                             |

4. **Settings, Domains**, add `oidc.fossclub.tech`, and in DNS add the record Vercel shows (a CNAME to `cname.vercel-dns.com`).
5. Redeploy once the variables are in.

### If Vercel's build complains about TypeScript or modules

The service is plain ESM TypeScript, and the same code runs anywhere Node 22 or newer does, so the hosting is replaceable:

```bash
npm run build         # compiles to dist/
npm run start:prod    # node dist/src/server.js, reading the same environment variables
```

There is also a `Dockerfile` for any container host. Nothing else changes: the issuer address, the keys and the apps stay the same, so
signing in to apps is unaffected by where it runs.

## 5. Membership from the main website

1. In the main website repository the migration `*_oidc_members_view` creates the view `oidc_members_v`. Deploy it to the main database
   the usual way (`ALLOW_PRODUCTION_DB=yes npx prisma migrate deploy` from a machine with the owner's address).
2. In the **main** database's SQL editor, run `docs/main-db-view.sql` with a password of your own. It makes `oidc_reader`, which can read
   that view and nothing else.
3. Put its **pooled** address in `MAIN_DB_URL` and redeploy.

Until this is done nobody is reported as a member, which is the safe answer. Everything else works.

## 6. Check it

```bash
curl -s https://oidc.fossclub.tech/healthz            # {"ok":true}
curl -s https://oidc.fossclub.tech/readyz             # {"ok":true,"state":true,"database":true}
curl -s https://oidc.fossclub.tech/.well-known/openid-configuration | head -c 400
```

Then add the first app ([adding an app](ADDING-AN-APP.md)) and sign in to it, and check:

- the second app signs in with no screen,
- `prompt=none` from a browser with no session comes back with `error=login_required`,
- a member shows `member: true` in the ID token, and a non-member does not.

## 7. Back it up

The Postgres database (accounts and audit log) is the only thing here worth backing up. Add it to the backup repository's job (see
[runbooks/backups.md](runbooks/backups.md)).
