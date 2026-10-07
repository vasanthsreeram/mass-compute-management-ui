# Massed Compute: what the API, MCP and dashboard expose

Investigated 2026-10-07 against the live service using the operator account. Every call was a read-only GET or a read-only MCP tool call, except the OAuth test, which registered a test client and approved a read-only grant that was revoked afterwards (see [OAuth](#oauth-login-with-massed-compute)).

Sources: https://vm-docs.massedcompute.com/api/v1 and /docs/mcp/*, the live endpoints, and the logged-in dashboard.

## REST API (`https://vm.massedcompute.com/api/v1`)

Auth: `Authorization: Bearer <api key>`. Send a `User-Agent` header.

| Area | Endpoint | Used by us |
|------|----------|------------|
| Auth | `POST /account/token/validation` | `validateToken()` exists, **nothing calls it** |
| Inventory | `GET /gpu-inventory`, `GET /images` | yes |
| Instances | `GET /instance`, `GET /instance/{uuid}`, `POST /instance/launch`, `/restart`, `/terminate` | yes |
| Coupons | `POST /coupon/information`, `POST /coupon/accepted-products` | **no**. `launch` accepts a `coupon` param we never pass |
| Billing | `GET /account/billing` | partly. Only the recharge amount and threshold are shown, and errors are swallowed (`getBilling()` returns `null` on any non-OK) |
| SSH keys | `GET/POST /ssh-keys`, `DELETE /ssh-keys/{id}` | **no**. We only pass a key inline at launch |

### Verified response shapes

- `GET /account/billing` returns `{"billingMethod":"creditcard","rechargeThresholdCents":500,"rechargeThreshold":"5.00","rechargeAmountCents":500,"rechargeAmount":"5.00"}`. `parseBilling()` in `src/massed.ts` matches these field names.
- `GET /gpu-inventory` returns 90 SKUs with `price_cents_per_hour` in **cents** (for example `gpu_1x_a6000` is 57, `gpu_8x_b300_SXM6` is 5280).
- `GET /instance` returns `{"runningInstances":[...]}`, `GET /ssh-keys` returns `{"sshKeys":[]}`, and token validation returns `{"message":"Valid Token"}`.
- **Not verified:** the unit of `product.final_price_hr` and `product.price_hr` on a running instance. No VM was running during the investigation. See [spend-tracking-accuracy.md](spend-tracking-accuracy.md#price-unit-heuristic).

### What the API does not have

No balance, transactions, invoices, usage history or terminated-VM history. About 18 guessed paths (`/account`, `/balance`, `/billing`, `/usage`, `/invoices`, `/transactions`, and variants) all returned a 307 redirect to `/login`, which is the same response any non-API route gives.

## MCP (`https://vm.massedcompute.com/api/mcp`)

Transport: HTTP JSON-RPC. Auth is the same API key as a bearer token, or OAuth (below). Protocol version `2025-06-18`.

- **17 tools:** 14 mirror the REST API one to one (`gpu_inventory_list`, `images_list`, `instances_*`, `coupon_*`, `account_token_validation`, `account_billing`, `ssh_keys_*`), plus 3 recipe tools: `recipes_list`, `recipes_search`, `recipes_get`.
- **37 resources**, all `recipe://<slug>` setup guides. Reading any other URI scheme returns `Field 'uri' ... must match recipe://<slug>`.
- **No prompts.**
- `account_billing` takes no arguments and returns the same data as REST. There is no hidden option.
- 21 guessed tool names (`account_balance`, `billing_transactions`, `usage_list`, `instances_history`, and similar) all returned `Unknown tool`.
- The full tool catalog is visible to every caller. Scope is enforced at `tools/call`: destructive tools return error `40300` for read-only keys.
- Instance tools redact the cleartext VM password. Use REST for that.

### Recipes

`recipes_list` returns **37** recipes (and there are 37 `recipe://` resources). The catalog in the server instructions lists only **17** of them, the app setup ones: vLLM with an OpenAI-compatible API, Ollama, JupyterLab, nginx variants, PostgreSQL, MySQL, Redis and self-hosted Supabase. The instructions say diagnostics and runbooks are not listed there, so the other 20 are probably those. Slugs come from `recipes_list`. This is a candidate feature: a one-click "set this VM up for X" on top of our launch flow.

## OAuth ("Login with Massed Compute")

Massed runs a standard OAuth 2.1 server (discovery at `/.well-known/oauth-authorization-server`):

- `authorization_endpoint` `/oauth/authorize`, `token_endpoint` `/api/oauth/token`, `registration_endpoint` `/api/oauth/register` (dynamic client registration), `revocation_endpoint` `/api/oauth/revoke`.
- Authorization code with **PKCE S256**, refresh tokens, public clients (`token_endpoint_auth_method: none`).
- Scopes `mcp:read` and `mcp:write`. The user approves read-only or full access and can revoke under Settings → Connected Apps.

### Tested end to end (2026-10-07)

1. Registered a public client with a loopback redirect URI.
2. Opened the authorize URL in the signed-in dashboard. The consent screen listed "View your instances, GPU inventory, images and billing".
3. After Allow, the exchange returned a Bearer token with a 1-hour lifetime and a refresh token, scope `mcp:read`.
4. **The OAuth token is rejected on `/api/v1/*` (401 "Authentication not correct") but accepted on `/api/mcp`.** `account_billing`, `instances_list` and `ssh_keys_list` returned the same data as the API key.
5. Both tokens were revoked afterwards (200 on each).

Consequence: a "Login with Massed Compute" flow is feasible and never touches the user's password, but the proxy would have to talk to Massed over MCP JSON-RPC for those users, because REST does not accept the OAuth token.

The test client (`94f32b07-563b-4cab-9784-1afac3e3023c`) is still registered. Remove it under Settings → Apps if unwanted.

### Identity: Massed gives an OAuth client no account identifier (probed 2026-10-07)

Probed with `scripts/massed-identity-probe.mjs` (read-only grant on the operator account, revoked afterwards; no token or value was written anywhere). Everything an OAuth client can reach was checked for a stable per-account value:

| Source | What it returned |
|--------|------------------|
| Discovery document | `issuer`, authorize/token/registration/revocation endpoints and a few capability lists. No `userinfo_endpoint`, no `introspection_endpoint`, no `jwks_uri`. `/.well-known/openid-configuration` and `/.well-known/jwks.json` are 404 |
| Token response | `access_token`, `token_type`, `expires_in`, `refresh_token`, `scope`. Nothing else, no `id_token` |
| Access and refresh tokens | Opaque 48-character strings, not JWTs, so no `sub` or `email` claim |
| `/api/oauth/userinfo`, `/oauth/userinfo`, `/api/userinfo`, `/api/me`, `/api/oauth/introspect` | 307 to the login page (browser-session only) |
| `/api/auth/session` with the Bearer token | 200 with no fields (the dashboard's session endpoint; an OAuth token has no session) |
| MCP `initialize` | `serverInfo.name` is the product (`massed-compute-vm-marketplace`), instructions are generic |
| MCP `account_token_validation` | `{message}` only |
| MCP `account_billing` | `billingMethod`, `rechargeThresholdCents`, `rechargeThreshold`, `rechargeAmountCents`, `rechargeAmount`. No account, customer or team id |
| MCP `ssh_keys_list`, `instances_list` | Empty for that account at the time. Earlier readings of `instances_list` showed no owner or group field |

So a "Sign in with Massed Compute" can prove the person controls *some* Massed account, but nothing tells us *which* one. Options and the recommendation are in the report that accompanied this probe; no login feature was built on a guess.

### Now the lab account (backend build, 2026-10-07)

The OAuth connection is no longer a per-user read-only extra. One admin's full-scope grant is "the lab account" and carries every Massed call over MCP (see [HANDOFF.md](HANDOFF.md#the-lab-account)). Only admins connect. The write tools are called with REST-mirroring argument names that are **unverified against real Massed**; they were exercised only against a local fake.

### Implemented: "Connect Massed Compute" (2026-10-07)

Code: `src/massed_oauth.ts`, routes in `src/api.ts`, migration `migrations/0004_massed_oauth.sql`, page `assets/connect.html`.

- **Flow:** `POST /api/massed/connect` registers one public client per redirect URI (cached in `massed_oauth_apps`), stores a hashed `state` and the encrypted PKCE verifier (`massed_oauth_states`, 10-minute TTL) and returns Massed's authorize URL. Massed redirects to `GET /api/massed/oauth/callback`, which checks the state belongs to the signed-in user, exchanges the code and stores the access and refresh tokens AES-GCM encrypted with `DATA_KEY` (`massed_connections`, one per user).
- **Other routes:** `GET /api/massed/connection` (status), `POST /api/massed/disconnect` (revokes at Massed, then deletes the row), `GET /api/massed/probe` (calls every read-only tool and reports counts and field names, not values).
- **Scope:** read-only (`mcp:read`) by default. `mcp:write` is only requested for admins who pass `{"scope":"full"}`.
- **Redirect URI:** derived from the request origin, so it is `https://massedui.vasanth.cloud/api/massed/oauth/callback` in production. Massed rejects a plain `http` redirect on a real domain (`invalid_redirect_uri`) but accepts `http://localhost` and `http://127.0.0.1`.

**Tested against the operator account, end to end:**

| Check | Result |
|-------|--------|
| Client registration, consent page, callback, token exchange, encrypted storage | works |
| Probe with the stored token | all 7 read tools returned data |
| Forced expiry (`expires_at = 1`), then probe | token refreshed silently, new expiry about 1 hour out |
| User clicks Disconnect on Massed (Settings → Connected Apps) | next call returns 409 "Massed connection was revoked. Reconnect." and the local row is removed |
| Our Disconnect button | revokes at Massed; the Connected Apps page is empty afterwards |

**What the OAuth connection returned (read-only scope):** token validation (`{"message"}`), billing settings (`billingMethod`, `rechargeThresholdCents`, `rechargeThreshold`, `rechargeAmountCents`, `rechargeAmount`), running instances (0 at the time), SSH keys (0), GPU inventory (90 entries), images (33) and recipes (37). It matches the API-key data exactly, and still has no balance, transactions, usage or team data. The consent page and Connected Apps page describe it as: "Can view your instances, GPU inventory, images and billing". Here "billing" means the settings above.

**Write scope (`mcp:read mcp:write`) tested (2026-10-07):** connected a full-access grant (on Massed's consent page the "Read-only access" switch is on by default and must be turned off; the form then carries `scope=mcp:read mcp:write`, `readonly=0`). Then called `initialize`, `tools/list`, `resources/list` and all 7 read-only tools with the OAuth token and with the operator's API key, and compared the raw JSON. **All of it was identical:** same server info and instructions, same 17 tool definitions, same 37 resources, same data from every tool. Write scope added no extra information, and no extra tools or fields. Only read-only tools were called; nothing was launched, restarted, terminated or written. The grant was then revoked and the Connected Apps page was empty again. Not tested: the responses of the write tools themselves (`instances_launch` and the like), since that would spend money. An earlier recollection that write scope returns more could not be reproduced, and no earlier session in this repo's history records such a result. If it was seen elsewhere, the likely place to look is the write tools' own responses.

Test notes:
- Local testing needs `wrangler dev --local-upstream 127.0.0.1:<port>` because `wrangler.jsonc` has a custom-domain route, which makes the Worker see itself as `http://massedui.vasanth.cloud`. Use `127.0.0.1` rather than `localhost`: cookies are shared across ports on `localhost`, and a second `wrangler dev` session of this app on another port overwrote the test session cookie. Use `--persist-to <dir>` to keep local D1 state separate from other `wrangler dev` sessions, which otherwise hit `SQLITE_BUSY`.
- The tests registered about 10 throwaway OAuth clients on Massed (including the first test client `94f32b07-…`). Massed offers no way to delete a client, and they have no grants attached.
- `tsc --noEmit` reports one error in `src/meter.ts` (the `watch` property is not in the declared return type of `tickMeter`). It was there before this change and is unrelated.

## Web dashboard (`vm.massedcompute.com`, login session only)

Pages: `/` (browse), `/deploy`, `/deploy-docker`, `/running-instance`, `/billing`, `/gpu-finder`, `/settings/{profile,team,audit-log,ssh-key,api,connected-apps,inventory-notification,referral}`.

- **`/billing`** shows the real **balance** (it read $15.35 at 2026-10-07 7:11pm), cost per hour, the auto-recharge settings and a **Recent Transactions** table with Stripe receipt links (5 card top-ups totalling $70.00: $10 on 2025-05-17, $5 + $20 + $5 on 2026-04-12/14, $30 on 2026-06-02).
- **`/settings/connected-apps`** is where OAuth grants are listed (app, what it can do, when connected) with a Disconnect action that takes effect immediately and cannot be undone. It was empty on 2026-10-07 because the test grant had already been revoked through `/api/oauth/revoke`, so revoking by token removes the grant from this list. Users can cut off the proxy here at any time. It is a management page only, with no data we can pull.
- **`/running-instance`** lists only running VMs, so it has no history.
- **`/settings/audit-log`** is "changes to this account's team, instances, storage and keys", with an Export CSV button. It is new and only held that day's API key events when checked. It should start recording instance launch and terminate events with the actor and the portal or API origin. See whether it can answer "which VM caused this charge".

- **`/settings/team`** has team members, "Invite a teammate" and **instance groups** (each group sets who can see and manage its instances; there is a default "General" group visible to everyone). For this account it says "It's just you here", so there is only one member. **No team data is exposed through the API or MCP.** Seven guessed REST paths (`/team`, `/teams`, `/account/team`, `/account/members`, `/members`, `/users`, `/account/users`) all returned the 307 to `/login`, and five guessed MCP tool names (`team_list`, `team_members_list`, `account_team`, `members_list`, `account_members`) returned `Unknown tool`. Instances belong to a group, but the instance payload we read has no group or owner field.

### How the dashboard loads data

It does **not** use a client-callable JSON API. Pages are Next.js server components. Client navigation fetches `<page>?_rsc=...` (content type `text/x-component`). The only other first-party call is `/api/auth/session`. The JS bundles contain no `/api/` routes except `/api/auth/*`.

`GET /billing` with an `RSC: 1` header returns a payload containing `"balance":"15.35"`, `costPerHour`, the transactions and a server action reference `getCurrentBalanceString`. All of it needs the logged-in **session cookie**. API keys and OAuth tokens get a 307 to `/login`.

Why we do not build on this: it needs a stored session cookie (a credential risk), the payload format and server action IDs change on every Massed deploy, and automated portal access is likely against their terms. Scraping would be acceptable only as an admin-only feature for the operator's own account.

## How sure are the "not available" results

| Data | Via API / MCP / OAuth token | Via dashboard login | Confidence in the "no" |
|------|----------------------------|---------------------|------------------------|
| Billing settings (method, recharge amount, threshold) | yes | yes | n/a |
| Balance, transactions, receipts | not found | yes (`/billing`) | **Strong, not proof.** 17 tools listed, none match. About 40 guessed names and paths (21 MCP tools, 18 REST paths) failed. A guess failing does not prove nothing exists. |
| Team members, instance groups | not found | yes (`/settings/team`) | **Weakest.** Only 7 REST paths and 5 MCP tool names were guessed. |
| Past or terminated VMs | not available | no (`/running-instance` is running only) | **Tested.** `GET /instance/{uuid}` and MCP `instances_get` on the UUID of an already-ended VM both returned `{"runningInstances":[]}`. `instances_list` rejects extra options (`includeTerminated`: "Unknown field"). Tested on one VM that lived 16 seconds. |
| Audit log of instance events | no | yes (`/settings/audit-log`, CSV export) | Not tested for contents yet. It only held that day's API key events. |

Limits of the testing: the OAuth token was tested with the read-only scope (`mcp:read`) only, not `mcp:write`. The statement that every caller sees the full tool catalog comes from the server's own instructions text and was not tested with write scope.

The reliable way to settle all of these is to ask Massed support or their Discord whether balance, transactions, usage and team members are available over the API.

## Where this leaves the balance

No supported machine interface exposes the balance, transactions or usage. Options, in order of preference:

1. Ask Massed to add balance and transactions (the dashboard's `getCurrentBalanceString` and transactions list) to the REST API and MCP.
2. Keep our own estimate (see [spend-tracking-accuracy.md](spend-tracking-accuracy.md)) and calibrate it against manual balance readings.
3. Admin-only scrape of `/billing` for the operator account, with the caveats above.

## Credentials hygiene

An API key was pasted into a chat session during this investigation. Treat it as exposed and rotate it (Settings → API Keys). Keys are not recorded in this repo.
