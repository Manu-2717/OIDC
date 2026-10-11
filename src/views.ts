/**
 * The handful of pages a person can see here. They are plain HTML with no script and one inline stylesheet (allowed by a per-request nonce
 * in the Content-Security-Policy), and every value that comes from outside is escaped.
 */

export const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const CSS = `
  :root { color-scheme: light dark; --bg:#f7f4ec; --fg:#14110f; --muted:#5d574f; --card:#fffdf8; --line:#14110f; --accent:#1f9d55; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12100e; --fg:#f4efe6; --muted:#a79f93; --card:#1b1814; --line:#f4efe6; --accent:#3ddc84; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg); color:var(--fg);
         font:16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width:100%; max-width:30rem; background:var(--card); border:2.5px solid var(--line); border-radius:18px; padding:28px;
         box-shadow:6px 6px 0 var(--line); }
  h1 { margin:0 0 .5rem; font-size:1.5rem; line-height:1.2; }
  p { margin:.5rem 0; } .muted { color:var(--muted); font-size:.92rem; }
  ul { padding-left:1.2rem; }
  .row { display:flex; gap:12px; flex-wrap:wrap; margin-top:1.25rem; }
  button, .button { appearance:none; cursor:pointer; font:inherit; font-weight:700; text-decoration:none; color:var(--fg); background:var(--card);
         border:2.5px solid var(--line); border-radius:999px; padding:.6rem 1.1rem; }
  button.primary { background:var(--accent); color:#04130a; }
  button:focus-visible, .button:focus-visible { outline:3px solid var(--accent); outline-offset:3px; }
  .brand { font-weight:800; letter-spacing:.02em; font-size:.85rem; text-transform:uppercase; color:var(--muted); margin-bottom:1rem; }
`;

export function layout(title: string, body: string, nonce: string, status = 200) {
  return {
    status,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · USAR FOSS Club</title>
<style nonce="${esc(nonce)}">${CSS}</style>
</head>
<body>
<main>
<div class="brand">USAR FOSS Club</div>
${body}
</main>
</body>
</html>`,
  };
}

export const consentPage = (p: { uid: string; csrf: string; clientName: string; scopes: string[]; accountLabel: string; nonce: string }) =>
  layout(
    `Allow ${p.clientName}?`,
    `<h1>Allow ${esc(p.clientName)} to sign you in?</h1>
<p>You are signed in as <strong>${esc(p.accountLabel)}</strong>. ${esc(p.clientName)} will be able to see:</p>
<ul>${p.scopes.map((s) => `<li>${esc(scopeLabel(s))}</li>`).join("")}</ul>
<p class="muted">It never gets your GitHub password or any access to your GitHub account.</p>
<form method="post" action="/interaction/${esc(p.uid)}/confirm">
  <input type="hidden" name="csrf" value="${esc(p.csrf)}">
  <div class="row">
    <button class="primary" type="submit">Allow</button>
    <button type="submit" formaction="/interaction/${esc(p.uid)}/abort">Cancel</button>
  </div>
</form>`,
    p.nonce,
  );

const scopeLabel = (scope: string) =>
  (
    ({
      openid: "that it is you (an id that only this service gives to this app)",
      profile: "your name, GitHub username and picture",
      email: "your verified email address, if you have one",
      club: "whether you are a club member, and your role",
    }) as Record<string, string>
  )[scope] ?? scope;

export const membersOnlyPage = (p: { uid: string; csrf: string; clientName: string; infoUrl: string; nonce: string }) =>
  layout(
    "Members only",
    `<h1>${esc(p.clientName)} is for club members</h1>
<p>You signed in, but this GitHub account has not joined USAR FOSS Club yet.</p>
<p class="muted">Sign in once on fossclub.tech with the same GitHub account, then come back here and try again.</p>
<form method="post" action="/interaction/${esc(p.uid)}/abort">
  <input type="hidden" name="csrf" value="${esc(p.csrf)}">
  <div class="row">
    <a class="button primary" href="${esc(p.infoUrl)}" rel="noopener">Sign in on fossclub.tech</a>
    <button type="submit">Go back</button>
  </div>
</form>`,
    p.nonce,
    403,
  );

export const blockedPage = (nonce: string) =>
  layout(
    "Sign in not available",
    `<h1>Sign in is not available</h1>
<p>This account cannot be used to sign in to USAR FOSS Club apps.</p>
<p class="muted">If you think this is a mistake, contact the club's core team.</p>`,
    nonce,
    403,
  );

export const errorPage = (nonce: string, message: string, status = 400) =>
  layout(
    "Something went wrong",
    `<h1>Something went wrong</h1>
<p>${esc(message)}</p>
<p class="muted">Go back to the app you were using and try signing in again.</p>`,
    nonce,
    status,
  );

export const logoutPage = (p: { form: string; host: string; nonce: string }) =>
  layout(
    "Sign out",
    `<h1>Sign out of ${esc(p.host)}?</h1>
<p>You will be signed out of every USAR FOSS Club app that uses this sign in.</p>
${p.form}
<div class="row">
  <button class="primary" autofocus type="submit" form="op.logoutForm" value="yes" name="logout">Yes, sign me out</button>
  <button type="submit" form="op.logoutForm">No, stay signed in</button>
</div>`,
    p.nonce,
  );

export const loggedOutPage = (nonce: string) =>
  layout("Signed out", `<h1>You are signed out</h1><p>Close this tab, or go back to the club's website.</p>`, nonce);
