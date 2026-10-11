# Runbooks

Steps for the moments when something needs doing and nobody has time to think. Each one says when to use it, what you need, the exact
steps, and how to check it worked. After following one, fix anything that was wrong in it and put the date in the line at the top.

| When                                                               | Runbook                              |
| ------------------------------------------------------------------ | ------------------------------------ |
| Rotating the signing key, cookie keys, an app's or GitHub's secret | [rotate-keys.md](rotate-keys.md)     |
| Someone must be locked out of every club app                       | [block-account.md](block-account.md) |
| People cannot sign in, or everyone was signed out                  | [incident.md](incident.md)           |
| Backing up and restoring the accounts database                     | [backups.md](backups.md)             |

Secrets are in the club's password manager, never in this repository.
