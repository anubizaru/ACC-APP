# Cloudflare D1 backend

This Worker implements the app's JSON action API using the existing normalized
D1 tables. The deployed Worker must replace the current public `/query` SQL
gateway: that endpoint is not an app API and allows unauthenticated SQL access.

## 1. Bind the existing D1 database

Install Node.js and Wrangler (`npm install --global wrangler`), then sign in:

```powershell
npx wrangler login
```

In Cloudflare Dashboard, open **Workers & Pages → D1 SQL database → pawnshop**,
copy its database ID into `database_id` in `cloudflare/wrangler.toml`, and
confirm that the Worker binding is named `DB`. The existing account already
has the app's tables (`Employees`, `Products`, `Statements`, and others).
Add the private authentication cache table:

```powershell
npx wrangler d1 execute pawnshop --remote --file=cloudflare/schema.sql --config cloudflare/wrangler.toml
```

## 2. Build and deploy

Build and deploy `pawnshop-api`. This replaces the existing `/query` endpoint
with the app API (`ping`, `setupStatus`, login, and authenticated app actions):

```powershell
node scripts/build-cloudflare.js
npx wrangler deploy --config cloudflare/wrangler.toml
```

The current database reports `Config.setupDone = 1`, so do **not** call
`/setup` again. After deploying, check that `POST` to the Worker root with
`{"action":"ping"}` returns `{"ok":true,"service":"pawnshop","version":1}`.
Then enter `https://pawnshop-api.anubizaru.workers.dev` in the app.

## Notes

- Existing D1 data stays in the existing SQL tables; the Worker does not
  recreate, clear, or migrate those tables.
- Login sessions and rate-limit counters are stored in the separate `PawnAuth`
  table. Passwords are hashed and never stored in plaintext.
- Deploy the frontend over HTTPS. The Worker supports CORS for cross-origin
  app hosting.
- The Worker serializes requests within an isolate and persists each request's
  changes in D1 batches. Use a Durable Object if strict ordering across
  isolates is required under heavy concurrent writes.
