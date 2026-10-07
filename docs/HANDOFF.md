# Backend → UI handoff

Source of truth for every API change. The UI session builds against this file. All routes are JSON, cookie session (`rl_session`) or `Authorization: Bearer gpk_…`. Errors are `{ "error": string, "code"?: string }`.

## Status

- Task 1 (route Massed through the admin's OAuth connection over MCP): done, tested against a local fake Massed.
- Task 2 (SSH-key launches, no passwords over OAuth): done.
- Task 3 (tracking in D1): done.
- Task 4 (money bugs): done. Failed kill retries, final settlement, ghost reconcile, per-VM rounding with carry.
- Task 5 (lost-connection state + admin email): done.
- Task 6 (onboarding API): done, on the paths `app.js` already calls.
- Task 7 (routing): done. `/` landing, `/app` and `/app/*` app. See [Routing](#routing).
- Follow-up (review): runtime check of the MCP write-tool schemas, with argument remapping and a launch block on mismatch ([MCP schema check](#mcp-write-tool-schema-check)); `designate` rejects non-admins and admins without an active connection.
- Admin sign-in by emailed code + attach step (user decision after the identity probe): done, see [Admin sign-in](#admin-sign-in-emailed-code-then-attach-massed). I now own the frontend as well.
- UI requests round: requests 1 and 2 done, request 3 left as a product decision ([Backend answers to UI requests](#backend-answers-to-ui-requests)). End-to-end test with the real UI against the fake Massed: passed ([End-to-end test](#end-to-end-test-fake-massed-real-ui)).
- Not done / not tested against real Massed: see [Open risks](#open-risks).

Migrations to apply before deploy: `0005_lab_tracking.sql`, `0006_oauth_return.sql` (already live), `0007_admin_email_login.sql` (`npm run db:local`, `wrangler d1 migrations apply gpu-proxy --remote`).

## Routing

- `/` serves `assets/landing.html` (Grok). If that file is missing it redirects to `/app`. `/?connect=CODE` redirects to `/app?connect=CODE` (device-login links).
- `/app` and `/app/*` serve `assets/index.html` (unchanged file, not moved). `app.js` already derives `APP_BASE`, so no UI change is needed.
- `wrangler.jsonc` sets `assets.html_handling: "none"`: static paths are exact (`/app.js`, `/styles.css`, `/connect.html`, `/landing.html`). There is no automatic `/foo.html` → `/foo` redirect any more.
- After Massed's consent screen, `POST /api/massed/connect` `{ "return_to": "app" }` lands on `/app?massed=connected` (or `/app?massed_error=<text>`). Default (omitted) is `/connect.html?connected=1`.
- New `APP_URL` var in `wrangler.jsonc` is used in emails.

## The lab account

One admin's Massed OAuth grant is "the lab account". Every Massed call (inventory, images, launch, restart, terminate, billing, the cron watcher) goes through it over MCP.

- Chosen by `lab_settings.lab_admin_id`: the first admin to connect, or whoever an admin designates with `POST /api/lab/designate`. If unset, the earliest-connected admin with an active grant.
- No silent failover. If that grant is lost, the lab goes to `lost` even when another admin is connected. An admin designates the replacement. (Switching silently would change whose Massed account gets billed.)
- `MASSED_COMPUTE_API_KEY` (REST) is a fallback only: used when no active OAuth connection exists. Only the REST key can read VM passwords.
- Only admins can connect, always with full scope (`mcp:read mcp:write`). Members never need a Massed account.
- With neither a connection nor a key, Massed calls return 409 and lists come back empty with a `lab` object. No fake data.

### `GET /api/lab/status` (any signed-in user)

```json
{ "state": "connected|lost|not_connected|api_key|mock",
  "healthy": true, "can_launch": true, "message": "…", "lost_since": null }
```

`schema_ok` (`true|false|null`, see below) is in the member view too. When it is `false`, `can_launch` is false and `healthy` is false.

Admins also get: `schema_problems[]`, `schema_checked_at`, `schema_error`, `schema_tools` (per tool: `present`, `mapping`, `missing`, `type_mismatch`, `required_unsent`), `lab_admin {user_id,email}`, `scope`, `connected_at`, `last_used_at`, `last_error`, `access_expires_at`, `api_key_fallback`, `admins_connected [{user_id,email,status}]`.

Also on `GET /api/me` as `lab` (member view). Show a banner when `!healthy`, disable Launch when `!can_launch`.

### `POST /api/lab/designate` (admin) `{ "user_id": "<admin id>" }` → admin lab status.

Rejections: 404 unknown user; 400 `code: "not_admin"` if the target is not an admin; 409 `code: "no_connection"` if that admin never connected Massed; 409 `code: "connection_lost"` if their grant is lost.

### `POST /api/lab/schema-check` (admin) → admin lab status, after forcing a fresh read of the MCP tool schemas.

## MCP write-tool schema check

Massed publishes no argument schemas for `instances_launch`, `instances_terminate` or `instances_restart`, and we send REST-style names (`productName`, `regionName`, `instanceName`, `imageId`, `sshKeys`, `instanceUuids`). So the desk reads the real `inputSchema` of each tool with the lab token (`tools/list`):

- **When:** right after an admin connects, on each cron tick (cached 30 minutes), when a launch finds no recent result, and on `POST /api/lab/schema-check`. Stored in `lab_settings.tool_schema`. Only over OAuth; the REST fallback does not use MCP arguments.
- **Remapping:** if a property differs only by case/underscores (`ssh_keys`) or is a known alias, the desk sends the real name automatically (`mapping`). No code change needed.
- **Blocking:** if something we send has no property, a type disagrees (array vs string), a tool is missing, or the schema `required`s a field we never send, then `schema_ok` is `false`, `can_launch` is false, and `POST /api/instances` returns **503** `code: "tool_schema_changed"` with `error: "Massed tool schema changed: <diff>"`. This happens before any row is created, so nothing is left half-launched. Terminate and restart are not blocked (they still try with the mapped names).
- **Unknown is not a block:** if `tools/list` cannot be read (HTTP 5xx, empty list) the verdict is `schema_ok: null` with `schema_error`, or the previous verdict is kept, and launches proceed.
- UI: show `schema_problems` to admins when `schema_ok === false`; members only see `can_launch: false` and the message.
- Other 503s from the API are now user-facing too (e.g. "Could not reach Massed to refresh the connection"); other 5xx stay "Internal error".

### Connection routes (admin only now)

- `GET /api/massed/connection` → `{ connected, status: "active|lost|not_connected", lost_at, scope, connected_at, last_used_at, last_error, access_expires_at, has_refresh_token }`. `connected` is false when lost.
- `POST /api/massed/connect` `{ "return_to"?: "app" }` → `{ url, scope: "full" }`. Redirect the browser to `url`. 403 for non-admins.
- `GET /api/massed/oauth/callback` (Massed redirects here; not called by the UI).
- `POST /api/massed/disconnect`, `GET /api/massed/probe` unchanged.

Lost-connection behavior: a refused refresh token, a 401 from Massed or a missing refresh token marks the connection `lost` (row kept), writes a `connection_events` row and emails every admin once per loss (`lost_notified_at`). A refresh that fails with a network error or Massed 5xx does **not** drop the grant. While lost: launch/restart/terminate return 409, inventory returns empty lists plus `lab`, the cron still bills known VMs (they are still running upstream) but skips reconcile and kills.

## SSH keys

Massed MCP redacts VM passwords, so access is by public key. Keys are passed to Massed at launch (saved keys, plus an optional inline `sshPublicKey`, max 5).

- `GET /api/ssh-keys` → `{ keys: [{ id, name, public_key, fingerprint, created_at }] }`
- `POST /api/ssh-keys` `{ name, public_key }` → 201 `{ key }`. 400 `code: "bad_ssh_key"` for anything but one OpenSSH public key line (private keys are rejected). 409 on duplicate. Max 10.
- `DELETE /api/ssh-keys/:id` → `{ ok }`
- Aliases under `/api/me/ssh-keys`.
- `POST /api/instances` with no key saved and an OAuth lab → 400 `code: "needs_ssh_key"` (send the user to the keys card).

## Instances

`POST /api/instances` `{ productName, instanceName?, imageId?, regionName?, sshPublicKey? }` → 201 `{ instance }`.

Error `code`s: `gpu_not_allowed` (403), `concurrent_cap` (403), `budget` (402), `needs_ssh_key` (400), `launch_failed` (422, Massed refused), `bad_ssh_key` (400). 409 = lab not connected / lost.

Instance object (list and detail) gained: `billed_cents`, `end_reason`. Detail also has `ssh_fingerprints[]` and:

```json
"access": { "method": "ssh_key|password|none", "ssh_command": "ssh ubuntu@1.2.3.4" | null }
```

`password` is only non-null when the lab uses the REST key. `status` is `launching|running|terminated|failed` (`failed` = launch never produced a VM).

`POST /api/instances/:id/terminate` → `{ ok, id, settled_cents }`. Terminates on Massed first. If Massed errors and the VM is still listed upstream, the call fails and the row stays `running` (still metered).

## Onboarding

Paths the UI already calls. Step ids are the UI's (`connect, invite, limits, overview, usage, unattributed, ssh, launch, budget, machines, agent`).

- `GET /api/onboarding` → `{ done, steps: string[], stored: string[], auto: string[] }`. `steps` = stored ∪ auto. `auto` are steps the server can prove from data: `connect` (lab connected), `invite` (other users or pending invites), `limits` (a non-admin has credit or a restricted allowlist, or an invite has credit), `overview`/`usage` (any usage), `ssh` (a saved key), `launch` (a real VM launched), `budget`, `agent` (an agent key exists).
- `POST /api/onboarding` `{ steps?: string[], done?: boolean, reset?: boolean }` → same shape as GET.
- Alias `/api/me/onboarding`.

## Capabilities

`GET /api/ui/capabilities` → `{ onboarding, ssh_keys, balance, lab_status, vm_events, burn_series, attribution }` (all `true` now).

## Tracking (admin unless noted)

- `GET /api/events?limit=` (own) and `GET /api/admin/events?user_id=&limit=` → `{ events: [{ id, kind, instance_id, mc_uuid, user_id, email, api_key_id, api_key_name, actor: "user|agent|system", product_name, price_cents_per_hour, detail, created_at }] }`. `kind`: `launch, launch_failed, restart, restart_failed, terminate, terminate_failed, budget_kill, budget_kill_failed, gone_upstream, stale_launch`.
- `GET /api/usage` (own) and `GET /api/admin/usage` → `{ events, summary }`. Summary now: `spent_cents, hours, event_count, by_sku[{product_name,cents,hours}], by_user[{user_id,email,cents,hours}] (admin only), by_key[{api_key_id,agent,kind,key_prefix,email,cents,hours}], by_agent` (= by_key where kind is `agent`). Admin also gets `summary.unattributed_cents`, plus `massed` (live snapshot, `mode: oauth|rest|mock|none`) and `watch`. Aggregates are SQL totals over all time; `events` is the latest 3000 rows. Browser launches have no key, so they appear in `by_user` but not `by_key`.
- `watch.vms[]` rows gained `attribution` (`app|name_tag|manual|unattributed`), `user_id`, `email`, `instance_id`, `api_key_id`. Attribution is recomputed every tick: `app` = we launched it, `name_tag` = VM name starts `rl_<first 8 of user id>_`, `manual` = admin assigned, else `unattributed` (launched outside the app, billing with no budget). `watch.summary` gained `unattributed_cents, unattributed_vm_count, unattributed_running`. `watch.ticks[]` gained `attributed_burn_cents_per_hour, unattributed_burn_cents_per_hour, unattributed_running`.
- `POST /api/admin/vms/:uuid/attribute` `{ user_id | null }` → `{ ok }`. Assigns an outside VM to a member (or clears it).
- `GET /api/admin/burn?hours=24&bucket_minutes=5` → `{ bucket_minutes, points: [{ taken_at, running, burn_cents_per_hour, unattributed_burn_cents_per_hour, … }] }`. Ticks kept 30 days, max 720 hours.
- `GET /api/admin/billing-history` → `{ snapshots: [{ billing_method, recharge_amount_cents, recharge_threshold_cents, taken_at }] }`. A row is written only when a value changes.
- `GET /api/admin/connection-events` → `{ events: [{ kind: connected|refreshed|refresh_failed|rejected|lost|disconnected|designated, detail, created_at, email }] }`.
- `GET /api/admin/fleet` rows gained `mc_uuid, billed_cents, end_reason, api_key_id`.
- `POST /api/admin/meter` → `{ billed, killed, kill_failed, reconciled, stale_launches, upstream_ok, watch }`.

### Balance calibration

Massed has no balance API, so an admin types the figure from Massed's billing page.

- `POST /api/admin/balance` `{ balance_cents, topup_cents?, note?, taken_at? }` → 201 calibration report. `topup_cents` = money added since the previous reading, so a recharge is not counted as spend.
- `GET /api/admin/calibration` → `{ entries[], latest_balance_cents, latest_at, estimated_balance_cents }`. Each entry after the first has `window: { from, actual_spend_cents, estimated_spend_cents, ratio }` (ratio above 1 = Massed charged more than we estimated). `estimated_balance_cents` = last typed balance minus what the watcher estimated since. It never changes a member's budget.

## Metering changes (affects what the numbers mean)

- Rounded once per VM: each 5-minute tick bills `floor(exact)` and carries the fraction (`instances.carry_cents`). A terminate bills the remainder rounded to the nearest cent.
- Billing starts when Massed accepts the launch.
- A VM that vanishes upstream is settled at the midpoint between its last meter and now, marked `terminated` with `end_reason: "gone upstream"`. A VM must be 3+ minutes old before it can be called gone.
- Budget kills: terminate on Massed first, settle on success only, retry every tick on failure (`budget_kill_failed` events).
- The watcher estimates a vanished VM's end as the midpoint of the gap, or the app's own terminate time when we ended it.

## Agent MCP (`POST /mcp`)

New tools: `ssh_keys_list`, `ssh_keys_add`, `lab_status`.

## Open risks

- **MCP write-tool arguments** are now checked at runtime against Massed's own `inputSchema` (see above), so a rename is remapped and a real incompatibility blocks launches with a clear 503. The checker is tested against a local fake only. The write tools themselves have not been called against real Massed: the first real launch should still be one cheap SKU, watched end to end.
- The launch response shape over MCP is unknown; the uuid is extracted from `response`/`uuid`/… or any UUID in the payload.
- Whether `instances_list` over MCP includes `ip` and `username` is unverified. If not, `access.ssh_command` stays null until they appear.
- Price unit of `final_price_hr` on running VMs is still unverified (see `spend-tracking-accuracy.md`).
- Massed's 1-hour minimum is not enforced in our estimate.
- A VM that starts and ends between two ticks is never seen by the watcher. The tenant ledger still bills it, as long as the app launched it.
- `MOCK_MASSED=1` remains as a dev-only flag. It is not extended and not meant for production.

## UI requests

All three asks from the first round are **answered** (see [Backend answers to UI requests](#backend-answers-to-ui-requests)); the UI now uses them, including `spend_visible`, the nulled member money, `access` on list rows, and the `balance_cents_*` fields. One new, small ask:

1. **`passwords: boolean` on `GET /api/ui/capabilities`.** The "Getting onto a machine" copy must not promise a generated password on an OAuth lab, and the only way to know is to infer it from `lab.state !== "connected" && api_key_fallback !== true`. The UI does exactly that today (`passwordsAvailable()` in `app.js`), and it will prefer an explicit `caps.passwords` the moment the route returns one. A `false` on `connected`, `true` on `api_key` and `mock` is all that is needed.

Not needed, already sufficient: everything in the two rounds of this file — capabilities, `/api/events`, `/api/admin/events`, `/api/admin/fleet`, `/api/admin/burn`, `/api/admin/billing-history`, `/api/admin/connection-events`, `/api/admin/balance`, `/api/admin/calibration`, `/api/admin/settings`, `/api/admin/vms/:uuid/attribute`, `/api/lab/status`, `/api/lab/designate`, `/api/lab/schema-check`, `/api/ssh-keys`, `/api/onboarding`.

### Local dev notes (this machine)

- Migrations **0005 and 0006 were applied to the local D1** so the app could be tested: `npx wrangler d1 migrations apply gpu-proxy --local`. Before that, `GET /api/instances` answered `D1_ERROR: no such column: billed_cents`. A copy of the pre-0005 database is at `/tmp/d1-backup-before-0005.sqlite`.
- The seeded `instances` rows have `billed_cents = 0` and `launched_at == terminated_at`, so ended machines show a 0-minute runtime and `$0.00`. That is the seed data, not the UI or the ledger.
- Local `bob@x.dev` holds one saved SSH key (`bob@laptop`, added while testing) and one terminated machine from a mock launch.

## UI status

Scope: `assets/app.js`, `assets/styles.css`, `assets/index.html` only. No backend files touched.

**Member experience (task 1).** The member view is now a first-class surface rather than the admin view minus buttons:

- Home leads with the lab's state, then **Your budget**: remaining, spent, allocated, burn rate, runway, and machine slots used against the cap, with an out-of-budget notice. Stats below cover their own burn, their own 14-day spend and their runtime left.
- **Your SSH keys** is a real card: paste a public key, validated client-side, saved to `/api/ssh-keys` (localStorage fallback if the route is missing), listed with the server's `SHA256:` fingerprint, removable. This is now mandatory kit, since OAuth labs cannot reveal a password.
- **Getting onto a machine** spells out the three steps, and **Your machines** lists every VM including ended ones with runtime, cost, `billed_cents` and `end_reason`, plus the `ssh` command from `access.ssh_command`.
- A blocked launch is no longer a dead grey button: it stays clickable, opens the dialog, shows why, and for a missing key lets the member paste one and launch in the same step.
- Usage gained **Your launch history** (`/api/events`), so a member can see their own launches, restarts and terminations with the reason.
- Team highlights the member's own card and their budget above the roster.

**Onboarding (task 2).** A six-step admin tour and a five-step member tour, driven by `TOUR` in `app.js`. Each step switches tab, jumps (not smooth-scrolls) to its target, and spotlights it; steps with no visible target fall back to a centred card. Step completion is derived from data — the server's `auto` list plus local heuristics — so merely viewing a step never ticks it. A checklist card on Home shows what is left, is dismissible (`POST /api/onboarding {done:true}`), and the **?** in the header re-opens the tour at the first unfinished step. The member's "Connect to a machine" step is omitted until they own a VM.

**New tracking surfaces (task 3).** Admin **Fleet** tab: lab-account card (state, who connected, scope, lost-since, `schema_ok` problems with a re-check button, per-admin connections with a designate select, probe, disconnect), unattributed machines with a report of unattributed `$/hr` and an inline "charge to" assign per VM, all machines with `billed_cents`/`end_reason`, launch-and-terminate history with actor and an agent tag, connection & billing-settings history, and balance calibration showing the last typed balance, the estimate, and the drift ratio between the two. Usage now also carries **Spend by agent** (`summary.by_agent`) and an unattributed-spend callout. `/app?massed=connected` and `?massed_error=` are handled with a banner and the query is cleaned.

**Routing.** `APP_BASE` is derived from `location.pathname`, so the same bundle works at `/` and at `/app`; the only hard-coded redirect (`connect.html`'s "back to the app") already points at `/app`.

**Verified in a browser** (headless Brave over CDP, logged in as both `bob@x.dev` (member) and `admin2@x.dev`, at 1280×900/1400×1000 and 390×844):

- Member: every tab, desktop and mobile, no horizontal overflow; key save / reject-a-bad-key / remove against the live API; a real mock launch from a pasted key end to end (key auto-saved, instance created, `ssh ubuntu@203.0.113.10` shown, login details correct); the blocked-launch path; Usage and its launch history; the whole 5-step tour walked backwards with the spotlight rect matching the target's rect at every step.
- Admin: every tab including Fleet; the lab card in mock state, in a connected state, and in a `schema_ok: false` state; calibration, connection & billing, launch history, designate select, probe; the whole 6-step tour walked the same way.
- Onboarding syncs with the server (`stored`/`auto`/`done`), dismissal persists across reloads, and **?** brings the tour back.
- Two real bugs found and fixed while verifying: buttons containing an inline icon rendered it at the SVG default size (120×120), and the tour measured its target before smooth scrolling settled, so the spotlight landed up to 130px off.

**Not verified.** No real Massed account, so: a real OAuth connect, a real MCP launch, `schema_ok` against Massed's live tool list, and the `lost`-connection email. The connected / schema-broken states were checked with a mocked `/api/lab/status` response. `MOCK_MASSED=1` is on locally, so launch, terminate and the watcher ran against the mock. The agent device-login flow and `connect.html` are unchanged from the previous round and were not re-exercised beyond loading.

### Follow-up round: member-UI review

Six items from the coordinating session, all in `app.js` / `styles.css`:

1. **The tour auto-opened on every load and always at step 1.** It now records a `seen` flag alongside `done` in `localStorage` (and posts only `done` to `/api/onboarding`, since completion is derived server-side), so it auto-opens exactly once, on a never-seen device — and it resumes at the *first unfinished* step rather than a hard-coded index 0. Later visits get the checklist card only. The tour's own ✕ and Skip no longer retire the checklist; only the checklist's ✕ does.
2. **The tour overlay blocked the nav.** The veil and spotlight are now `pointer-events: none`, and a capture-phase click listener pauses the tour on any click outside its card, so the nav — and everything else — works straight through. Verified by clicking Team and Usage with the tour open at 1280 and 390 wide.
3. **Mobile header and key form.** Sign out and "Walk me through the desk" moved into an avatar menu (`.who-wrap` / `.menu`), so the nav row is Home · Team · Usage · [Fleet] · Agents · ? · avatar. At ≤780px the nav wraps instead of scrolling horizontally (a scroller hid items and clipped the menu). The key form's name and public-key inputs stack in a one-column grid at ≤780px, so the key field is full width. At 390px: `scrollWidth === innerWidth`, every nav item fully visible, menu inside the viewport.
4. **Home order for members.** Now: lab line → budget panel → stats → **Launch a GPU** → **Your machines** → SSH keys and "Getting onto a machine" last. The SSH card is a `<details>` and collapses once a key is saved; the tour opens it when it spotlights that step. Admins keep Running now, then Launch.
5. **Password copy on OAuth labs.** `passwordsAvailable()` gates the "or open login details for the generated password" clause; it prefers a `caps.passwords` flag when one exists and otherwise infers mock/api_key from the lab state. Verified against a mocked OAuth lab (clause absent) and the local mock (clause present).
6. **Team tab visibility.** Gated on the server's `spend_visible` flag (falling back to "every row carries numbers" if an older response omits it). When it is false the UI hides the money rather than rendering nulls: no team-total cards, no "Where the money went" donut, no per-member bars — the stat row drops to Members · Machines running · Your machines · Your access, other members' cards say "Budget is private", and a note explains who can see what. Only the caller's own budget panel keeps money. When `spend_visible` is true (admin, or the setting is on) the team totals, the donut and every bar come back with no other code path. Admins also get a **Who can see spend** card with a switch labelled *Members can see each other's spend*, which PATCHes `/api/admin/settings`.

Also fixed while verifying: a global `details summary::before` rule in `styles.css` (written for the Agents "Preview the skill" disclosure) was injecting a second disclosure glyph into the new collapsible SSH card; the SSH card now opts out with `content: none`, and the skill preview keeps its triangle.

### Follow-up round 2: mobile tour placement and server-side "seen"

From a 390×844 mobile pass on a fresh browser:

7. **The tour card covered the sticky header, so nav taps did nothing.** At ≤780px the card now docks to the bottom of the viewport (`.tour-card.docked`: `left/right: 12px`, `bottom: calc(14px + env(safe-area-inset-bottom, 0px))`, `max-height: calc(100dvh - 170px)` with internal scroll so it cannot climb into the header on a short screen). Above that width the card is clamped below the sticky header (`top >= header.bottom + 10`) and inside the viewport. Measured at 390 (top 587 vs header bottom 95), 700 (docked, top 663 vs 95), 900 and 1280 (top 445 vs 64): the card never overlaps the header or any nav item, and tapping Usage with the tour open switches tab and closes the tour. Spotlight geometry re-checked at 1280 (all 5 member steps match the target rect); at 390 the two targets taller than the viewport ("Launch a GPU", "Your machines") clamp the hole to the viewport, which is expected.
8. **"Seen the tour" was per-browser.** It is now recorded on the server with the step id **`tour_seen`** (`POST /api/onboarding {steps:["tour_seen"]}`, only sent when the local flag is set and the server has not already got it), and read back from `stored`/`steps` on `GET /api/onboarding`. Auto-open requires the local flag, the server flag and `done` to all be clear, so a new browser or device no longer re-opens it — the checklist card carries the reminder instead. Verified by clearing `localStorage` only (simulating a new device) with `stored: ["tour_seen"]` on the server: the tour stayed shut and the checklist rendered. No backend change needed; `tour_seen` is just another step id and is filtered out of the checklist because it is not one of the UI's tour steps.

**Re-verified:** every tab for both roles, no JS errors, no `NaN`/`undefined`, no stray flash, no document overflow, at 1400×1000, 900×900, 700×900 and 390×844; tour auto-open / one-time gating / nav-click pause / tab navigation across all 11 steps; the SSH card collapsed and expanded; avatar menu open, close-on-outside-click, and both items. For the visibility work: with `spend_visible: false` the member Team tab renders 4 non-money stat cards, no donut, a bar only on their own row and "Budget is private" on the others; with the setting flipped on the same page switches to Budget allocated / Spent so far / Remaining, the donut returns and every row gets a bar and money; flipping the switch back restores the hidden state. The fallback path was exercised by mocking `/api/team` without the flag, both with nulled rows (hides) and with all rows numbered (shows). Also verified in that sweep: the docked tour card clears the header at 390/700 and the clamped card clears it at 900/1280, a nav tap works with the tour open at both 390 and 1280, spotlight geometry still matches at 1280, and `tour_seen` survives a `localStorage` wipe. The setting was left at its default `false`; bob's onboarding was left with `tour_seen` recorded and `done: false`, so the checklist is visible and the tour will not re-open.

**Not verified:** the same gaps as above — no real Massed account. `passwordsAvailable()`'s `caps.passwords` branch is dead code until the route returns that field; only the inferred path was exercised.


## Backend answers to UI requests

1. **Done.** `GET /api/instances` rows now carry `access { method, ssh_command }` and `ssh_fingerprints[]` (same shape as the detail route; the password itself is never in a list row, `method: "password"` only says one exists). No more per-VM detail fan-out.
2. **Done, with a caveat.** `balance_cents_estimate`, `balance_cents_last_entry`, `balance_as_of` and `balance_source` are now merged into `massed` on `GET /api/admin/usage` and into the admin `GET /api/lab/status`. They are `null` until an admin enters a balance. This is **not Massed's real balance**: Massed does not expose one over the API, MCP or OAuth. It is the last typed balance minus what the watcher estimated spent since (`balance_source: "manual_entry_minus_estimated_spend"`). Label it as an estimate.
3. **Done: other members' money is admin-only by default.** `GET /api/team` for a non-admin now returns `credit_cents`, `spent_cents` and `burn_cents_per_hour` only on the caller's own `members[]` row; on every other row they are **`null`** (email, role, `running`, `max_concurrent`, `allowed_gpus` stay). In `running[]`, `price_cents_per_hour` is `null` on other members' VMs. Admins always get real numbers. The response has a new `spend_visible: boolean` (true for admins, or when the lab setting below is on) so the UI knows whether to render money columns/bars at all; render `null` as "—" or hide the bar.
   - Lab setting `members_see_team_spend` (default `false`): `GET /api/admin/settings` → `{ members_see_team_spend }`, `PATCH /api/admin/settings` `{ "members_see_team_spend": true|false }` → same shape (admin only, audited). When `true`, non-admins see everyone's numbers again (the old behavior) and `spend_visible` is `true`.
   - Other endpoints a non-admin can call already return only their own spend (`/api/usage`, `/api/events`, `/api/instances`).

Other small changes in this round: the device-login `verify_url` is now `/app?connect=CODE` (it used to rely on the `/` redirect), and "lab not connected" / "lab lost" errors carry `code: "lab_not_connected"` / `"lab_lost"` (409), so the UI can branch on them.

## End-to-end test (fake Massed, real UI)

Setup: local Worker (`MOCK_MASSED=0`, `MASSED_ORIGIN` pointed at a local fake Massed that serves OAuth + MCP with `inputSchema`s, with switches to fail terminate/refresh and to delete VMs), real sign-up through the emailed OTP (read from wrangler's local email sink), then a scripted headless-Brave session (CDP) driving the real `app.js`.

Passed:
- Landing at `/`, `/app` serves the app, `/?connect=CODE` redirects to `/app?connect=CODE`.
- First user becomes admin; an uninvited email is refused; admin connects the lab (callback → `/app?massed=connected`), `schema_ok: true`.
- Admin invites a member; member signs up (API and through the real sign-up form), adds an SSH key (API and through the real card), launch before a key gives `needs_ssh_key`, launch with a key shows `ssh ubuntu@…` in the UI.
- Agent device login (`/api/cli/start` → member approves → poll) gives a `gpk_` token; `/mcp` `tools/list`, `lab_status`, `instances_launch` work; the 3rd launch hits the concurrency cap; an agent token cannot approve a device code.
- Cron/manual tick bills (70 minutes at 63c = 74c per VM), the member hits $0, both VMs are terminated on Massed and settled (`budget_kill` events, actor `system`).
- Admin sees per-user and per-agent spend (`by_key` shows `agent: claude-on-laptop`), events with actor and key name, the unattributed VM (`attribution: unattributed`), manual assignment to a member, balance estimate.
- Lost connection (refresh refused): status `lost` for members and admins, launch returns 409 `lab_lost`, one email, then reconnect returns to `connected`; `connection_events` = `connected, lost, refresh_failed, connected`.
- Browser: every tab as a new member and as admin rendered with no JS exceptions, no `undefined`/`NaN`/`[object Object]` text and no horizontal overflow. Only HTTP errors were the expected pre-login 401s on `/api/me` and `/api/ui/capabilities`.

Not covered: a real Massed (see Open risks), mobile widths, and the real transactional email delivery (only the local sink).

## UI bugs

None found in this round. (The two 401s on first load are the unauthenticated `/api/me` and `/api/ui/capabilities` probes, which is expected.)


## Admin sign-in: emailed code, then attach Massed

Decision (user): Massed OAuth cannot be the login, because Massed gives an OAuth client no account identifier (see [massed-api-findings.md](massed-api-findings.md#identity-massed-gives-an-oauth-client-no-account-identifier-probed-2026-10-07)). Admins sign in with an emailed one-time code, then attach the lab's Massed account. Members are unchanged (email + password, invite + OTP sign-up).

Migration `0007_admin_email_login.sql` (apply to remote D1): `signup_otps.purpose` (`signup` | `admin`) and a `rate_limits` table.

### Endpoints (unauthenticated)

- `POST /api/auth/admin/code` `{ email }` → `{ sent: true, dev_code? }` (`dev_code` only with `MOCK_MASSED=1`). Eligible emails: an existing admin, the bootstrap first user / `ADMIN_EMAIL`, or an email invited with `role: "admin"` via `POST /api/team/invites`. Otherwise **403** `code: "not_admin"` with a clear message. An existing member gets a message pointing them to the member door. Disclosure is the same as member sign-up (it says the address is not an admin here, nothing more).
- `POST /api/auth/admin/verify` `{ email, code }` → `{ user, lab }` and sets the session cookie (same cookie and lifetime as today). `lab` is the admin lab status; if `lab.state` is `not_connected` or `lost` the UI shows the attach step. For a bootstrap or invited email the admin account is created here (no password: `password_hash` is `"!"`, so password login can never succeed for it) and the invite is consumed.
- Codes: 6 digits, 10 minutes, 5 wrong attempts then locked (`429`). A code carries its purpose, so a member-signup code cannot sign in an admin and an admin code cannot finish a member sign-up (both return "Code expired").
- Rate limits (`429`, `code: "rate_limited"`): one code per email per 30 seconds, 5 per email per hour, 20 per IP per hour (`CF-Connecting-IP`). The same limits now apply to `POST /api/auth/register`.
- Existing password login (`POST /api/auth/login`) is unchanged and is what `/app?password=1` uses, so admins with a password (the live admin) are not locked out.

### Login screen (`assets/app.js`)

1. **"Who is signing in?"** two cards: "I run the lab" (admin) and "I'm a lab member". The choice is remembered in `localStorage` (`mc.role`); each form has a link to switch.
2. **Admin:** email only, "Email me a code", then the code screen, then signed in. No password field.
3. **Attach step:** right after an admin signs in, if the lab has no active Massed connection (`not_connected` or `lost`), a focused "Attach your Massed Compute account" screen: the connect button (full access, "leave Read-only access off"), "we never see your Massed password", how to revoke (Massed → Settings → Connected Apps), and **Skip for now**. After a skip, a persistent banner ("Massed Compute isn't attached yet" / "connection lost") with an Attach button stays on every page until the lab is connected. Connecting uses `POST /api/massed/connect { return_to: "app" }` and returns to `/app?massed=connected`.
4. **Member:** unchanged (Sign in / Join with an invite, OTP).
5. **`/app?password=1`:** hidden admin password form (no link to it from the UI); the query is removed after sign-in.
6. The admin tour's first step is now "Attach your Massed account".

### Tested (fake Massed, real browser at desktop and 390px)

Role chooser and remembered choice; stranger and existing member refused with clear messages; code sign-in as bootstrap admin and as an invited admin; wrong code, locked attempts, 30-second gap, hourly cap; cross-purpose codes rejected; attach step then skip then banner then attach through the fake Massed then banner gone; reload keeps the session; sign-out reopens the admin door; `?password=1` sign-in for a password admin with no attach step when the lab is connected; no horizontal overflow on any auth screen at 390px.

Not covered: real email delivery (only the local sink) and a real Massed consent screen.
