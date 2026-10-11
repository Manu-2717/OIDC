/**
 * Makes the secrets the service needs, and prints them. Nothing is written to disk, so nothing can be committed by accident.
 *
 *   npm run keys:generate
 *
 * Copy each value into the hosting settings (Vercel: Settings, Environment Variables, tick Sensitive), and into the password manager.
 * To rotate the signing key later, see docs/runbooks/rotate-keys.md.
 */
import { randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";

const { privateKey } = await generateKeyPair("RS256", { modulusLength: 3072, extractable: true });
const jwk = await exportJWK(privateKey);
const kid = `${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString("hex")}`;
const jwks = { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] };

console.log("# Signing key (RS256, 3072 bit). One line, no spaces.");
console.log(`OIDC_JWKS='${JSON.stringify(jwks)}'`);
console.log();
console.log("# Cookie signing keys. The first signs, all of them verify (that is how a key is rotated without signing everyone out).");
console.log(`COOKIE_KEYS='${randomBytes(48).toString("base64url")}'`);
console.log();
console.log("# Signs the tokens in the approval forms.");
console.log(`CSRF_SECRET='${randomBytes(48).toString("base64url")}'`);
console.log();
console.log("# A secret for one app. Replace QUIZ with the app's client id in capitals, with dashes as underscores.");
console.log(`CLIENT_SECRET_QUIZ='${randomBytes(48).toString("base64url")}'`);
