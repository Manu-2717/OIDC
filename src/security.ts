import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Small, boring, well-tested building blocks. Nothing clever belongs in this file. */

/** A random value of `bytes` bytes, as URL safe text. 32 bytes is 256 bits. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** SHA-256, as URL safe text. This is also exactly an S256 PKCE challenge when applied to a verifier. */
export const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

/** Compares without leaking, through timing, how much of a secret was right. */
export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A PKCE pair for the sign in to GitHub: the verifier stays on the server, the challenge goes to GitHub. */
export function pkcePair() {
  const verifier = randomToken(48);
  return { verifier, challenge: sha256(verifier) };
}

/** A token that proves a form was served by us for this particular sign in. Nothing is stored: it is recomputed to check it. */
export const csrfToken = (secret: string, uid: string) => createHmac("sha256", secret).update(`csrf:${uid}`).digest("base64url");

export const csrfValid = (secret: string, uid: string, candidate: unknown) =>
  typeof candidate === "string" && candidate.length > 0 && safeEqual(csrfToken(secret, uid), candidate);
