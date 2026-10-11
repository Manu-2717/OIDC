# Locking someone out

_Last checked: not yet._

Use this when a person's account must stop working in every club app: a compromised GitHub account, or someone who must be removed.

You need the repository checked out, and `DATABASE_URL` (the `oidc_app` address) and the two `UPSTASH_REDIS_REST_*` values in your
environment (a local `.env` is fine; the production values are in the password manager).

```bash
npm run account -- show <github-username>      # look first: is this the right person?
npm run account -- block <github-username>
```

What happens: the account is marked blocked in Postgres and its cached copy is removed, so within a minute:

- their sessions here no longer count (a quiet check says `login_required`),
- their access tokens stop working at the userinfo endpoint,
- they are refused at the GitHub step if they try to sign in again.

What it does **not** do: end the sessions that apps keep for themselves. An app signs the person out when its own session ends. For anything
urgent, tell the app's owner as well, or rotate that app's secret.

To undo it: `npm run account -- unblock <github-username>`.

Both are recorded in the audit log (`account.blocked`, `account.unblocked`).

Note this is separate from being a **member**: membership belongs to the main website's database. Blocking here keeps someone out of every
app even if they are still a member there.
