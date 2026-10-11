/**
 * How long each kind of record lives. One place, because the storage adapter depends on these numbers: the index that lets a grant be
 * revoked in one go must outlive every record in it.
 */

const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;

export const LIFETIMES = {
  /** What an app receives to call the userinfo endpoint. Short, because it cannot be recalled once it is out. */
  AccessToken: 10 * MINUTE,
  /** Proves who signed in. An app reads it once, straight away. */
  IdToken: 10 * MINUTE,
  /** The one time code an app swaps for tokens. */
  AuthorizationCode: MINUTE,
  /** A sign in that has been started and not finished. */
  Interaction: 15 * MINUTE,
  /** How long someone stays signed in here, so that the next app needs no screen at all. */
  Session: 7 * DAY,
  /** A person's approval of an app. */
  Grant: 7 * DAY,
} as const;

/**
 * The records that belong to a grant (and are removed together with it) are indexed by a set. It is kept this long, which is more than any
 * record that can be in it lives.
 */
export const GRANT_INDEX_TTL = 30 * MINUTE;

// A record in the index that outlived the index could not be revoked. Refuse to start rather than allow that.
for (const model of ["AccessToken", "AuthorizationCode", "Interaction"] as const) {
  if (LIFETIMES[model] > GRANT_INDEX_TTL) throw new Error(`${model} lives longer than the grant index (${GRANT_INDEX_TTL}s)`);
}
