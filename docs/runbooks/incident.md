# People cannot sign in

_Last checked: not yet._

Start with two minutes of looking before changing anything.

```bash
curl -s https://oidc.fossclub.tech/readyz
```

| You see                              | It means                                           | Do this                                                                                                            |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `{"ok":true,...}`, but sign in fails | Not Redis or Postgres. Probably GitHub or one app. | Check [githubstatus.com](https://www.githubstatus.com). Look at the app's own settings (secret, redirect address). |
| `"state":false`                      | Redis is down, or refusing commands                | Upstash console, the database, **Usage**. See below.                                                               |
| `"database":false`                   | Postgres is down, asleep too long, or out of hours | Neon console, the project `ufc-oidc`. See below.                                                                   |
| the request itself fails             | This service is not running                        | Vercel, the project, **Deployments**. Roll back to the last good one (Promote).                                    |

Logs: Vercel, the project, **Logs**. They are one JSON object a line. Search for `"level":"error"` or the `requestId` shown in an error.
Nothing secret is logged.

## Redis

- **Refusing commands** (Upstash reports that a limit was reached): sign ins stop until the limit resets or is raised. Raise it in the
  Upstash console, or add a second database. Look at what used them first: a loop in an app calling `/auth` with no session is the usual
  cause (the per address limits slow one address down, not many).
- **Flushed or lost:** everyone is signed out. They sign in again with one click each. Nothing else is lost.

## Postgres (Neon)

- **Asleep:** the first request after a quiet spell takes a few seconds. It is not an incident.
- **At a compute or storage limit:** the Neon project page says so. Raise the limit in the Neon console, or wait for it to reset.
- **A bad migration or lost data:** restore from the backup ([backups.md](backups.md)). Accounts are recreated at a person's next sign in,
  with the same `sub` only if the row is restored, so restore before people sign in again if you can.

## "Everyone was signed out"

Almost always one of: the Redis database was flushed, `COOKIE_KEYS` was changed without keeping the old key, or the issuer address changed.
None is harmful. If `ISSUER` changed, every app's configuration is wrong too: change it back.

## "invalid_client" or "invalid_grant" in one app

- `invalid_client`: the secret in the app does not match `CLIENT_SECRET_<APP>` here, or the app is not in `clients.json`
  (the logs say `app not registered` with the reason at start up).
- `invalid_grant`: the code was used twice, took more than a minute, or the PKCE verifier did not match. In a working app this is a double
  click or a retried request.
- `redirect_uri` error page: the app sent an address that is not an exact match in `clients.json`.

## A member is shown as "not a member"

The answer is cached ten minutes, and the last known answer is used if the main website's database cannot be reached. Check
`oidc_members_v` in the main database, and `MAIN_DB_URL` here. Remember a person is a member there once they have signed in on the website.
