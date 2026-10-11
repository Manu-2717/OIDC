# Rotating keys and secrets

_Last checked: not yet. Fix anything that was wrong when you follow it, and put the date here._

Rotate on a schedule (once a year, at the officer handover) and straight away if a secret may have leaked.

## The token signing key (`OIDC_JWKS`)

Apps cache this service's public keys, so a new key has to be published **before** it is used, and the old one kept until every token it
signed has expired (ten minutes) and apps have refreshed their copy. Never swap it in one step.

1. Make a new key: `npm run keys:generate`. Take only the `OIDC_JWKS` line. Its `kid` is the date plus a random part.
2. In Vercel, edit `OIDC_JWKS` so the keys list holds the **old key first and the new key second**. Redeploy.
   The new key is now published (in `/jwks`) but not yet used.
3. Wait at least an hour, so apps have seen it.
4. Edit `OIDC_JWKS` again with the **new key first, old key second**. Redeploy. New tokens are now signed with the new key.
5. Wait at least an hour (far more than the ten minutes a token lives).
6. Remove the old key. Redeploy.
7. Put the new `OIDC_JWKS` in the password manager.

Check: `curl -s https://oidc.fossclub.tech/jwks` lists the keys you expect, and a fresh sign in produces an ID token whose header `kid` is
the new one.

If the key may have **leaked**, skip the waiting: make the new key, publish only it, and redeploy at once. Apps will reject tokens signed by
the old key from then on, and people will sign in again, which is the point.

## The cookie keys (`COOKIE_KEYS`)

A comma separated list. The **first** key signs, **all** verify.

1. Make a new random value (`openssl rand -base64 48`).
2. Put it at the **front**: `NEW,OLD`. Redeploy. Everyone stays signed in.
3. A week later (longer than a session lives), remove `OLD`. Redeploy.

If one leaked, drop the old key at once. Everyone is signed out and signs in again.

## `CSRF_SECRET`

Replace it and redeploy. Any approval page open at that moment must be reloaded. Nothing else is affected.

## An app's secret (`CLIENT_SECRET_<APP>`)

1. Make a new value (`openssl rand -base64 48`).
2. Set it in the app's own settings and in Vercel here, then redeploy this service. There is a short moment when the two disagree, in
   which that app's token requests fail: do it when it is quiet.

## The GitHub OAuth secret

1. In the OAuth app's settings, **Generate a new client secret** (GitHub allows two at once).
2. Put it in Vercel as `GITHUB_CLIENT_SECRET` and redeploy.
3. Delete the old secret in GitHub.

## The database passwords

`oidc_app`: run `ALTER ROLE oidc_app PASSWORD '<new>';` as the owner in the Neon SQL editor, update `DATABASE_URL` in Vercel, redeploy.
`oidc_reader` (in the main website's database) is the same, with `MAIN_DB_URL`.
