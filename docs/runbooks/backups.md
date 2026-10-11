# Backups and restore

_Last checked: not yet._

Only the Postgres database (`ufc-oidc`: accounts and the audit log) is worth keeping. Redis holds nothing that cannot be remade.

## What to back up

The club's backup repository already runs a scheduled `pg_dump`, checks that it restores, encrypts it, and keeps it. Add this database to
it: copy the workflow `.github/workflows/backup.yml` there to `backup-oidc.yml` and set:

| Setting                      | Value                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| secret `BACKUP_DATABASE_URL` | the **direct** address of `ufc-oidc` with the `oidc_backup` login (see `db/roles.sql`) |
| env `CORE_TABLES`            | `accounts,audit_log` (the check that the right database is being backed up)            |
| secret `STANDBY_1_URL`       | leave unset: this database is small enough that restoring from a dump is the plan      |

(`CORE_TABLES` is supported by the backup repository's `scripts/dump.sh`. Its default is the main website's tables.)

## Restoring

1. Create an empty database (a new Neon branch or project).
2. Decrypt the backup and restore it with `scripts/restore.sh` from the backup repository (see its runbook).
3. Run `db/roles.sql` on it, so the service has its restricted login.
4. Put the new pooled `oidc_app` address in Vercel as `DATABASE_URL` and redeploy.
5. People's accounts are as of the backup. Anyone who first signed in after it gets a new account (and a new `sub`) at their next sign in.
   Apps that keyed users on `sub` will see them as new people, which is why backups should be recent.

## What is **not** in the database

The signing key and the cookie keys are in Vercel and the password manager. A restore of the database does not need them, and a lost
database does not lose them.
