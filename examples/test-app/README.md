# Test app

A small app that signs in with the hosted service, to try it by hand. It prints what an app receives: the checked ID token, its claims
and the userinfo answer.

```bash
npm run example            # then open http://localhost:4000
```

Uses `ISSUER` (default `https://oidc.fossclub.tech`) and `PORT` (default `4000`). It needs the two apps `oidc-test` and
`oidc-test-members` to be in `clients.json` of the service. They are public clients that only accept `http://localhost:4000`, so they are
for testing: remove them once the first real app is registered.
