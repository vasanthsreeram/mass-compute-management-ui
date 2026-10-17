# Admin setup: run the desk on your own Cloudflare account

## Config changes needed (for the maintainer, before the Deploy button works for strangers)

The committed `wrangler.jsonc` is the maintainer's production config. For the Deploy to Cloudflare button and for `npm run setup` to work on someone else's account:

1. **Remove `account_id`** (the button and `scripts/setup.mjs` supply the deployer's own). `setup.mjs` already generates a private `wrangler.local.jsonc` that drops `account_id`, `routes`, `preview_urls`, `APP_URL`, `MAIL_FROM` and swaps in your new D1 id, so the CLI path works today even if this is not done.
2. **Remove or fence the `routes` custom domain** (`massedui.vasanth.cloud` is not yours). Keep production's route in a separate `wrangler.prod.jsonc` or in the dashboard.
3. **D1 `database_id`**: the button needs a default name and creates a new database, replacing the id. Keep `database_name: "gpu-proxy"`; the owner's id should move to the prod override.
4. **R2 binding**: `r2_buckets: [{ "binding": "BACKUPS", "bucket_name": "gpu-proxy-backups" }]` (being added). The button and `setup.mjs` create the bucket.
5. **`.dev.vars.example` is used by the button as the list of secrets to prompt for.** Today it contains `MOCK_MASSED=1` and a placeholder `SESSION_SECRET`. Prompts are driven by `package.json` `cloudflare.bindings` (added: `SESSION_SECRET`, `DATA_KEY`, `ADMIN_EMAIL`). Trim `.dev.vars.example` to those three plus `MASSED_COMPUTE_API_KEY=` so `MOCK_MASSED=1` is never offered as a deployed value (`MOCK_MASSED` stays `"0"` in `vars`).
6. **Migrations on deploy**: set `package.json` `"deploy": "wrangler d1 migrations apply DB --remote && wrangler deploy"` so the button runs them (reference the binding `DB`, not the name). Not changed here because it alters `npm run deploy` for the maintainer.
7. **Follow-up (app side, tiny):** read `#claim=<email>:<code>` in `assets/app.js` on load and `POST /api/auth/admin/verify {email, code}` (see "Claim link" below). No `src/` change is required.

## What is Cloudflare OAuth and what is app-level

| Piece | Mechanism | Who it identifies |
|---|---|---|
| Deploy button | Cloudflare dashboard OAuth/login in your browser; Cloudflare clones the repo into your account and provisions D1/R2 | You, as the Cloudflare account owner |
| `npm run setup` | `wrangler login` (browser OAuth) | You, as the Cloudflare account owner |
| Admin sign-in to the desk | **App-level**: a one-time claim code seeded at setup for your Cloudflare login email, or the emailed code | The email the desk stores as admin |
| Connect Massed Compute | Massed Compute OAuth 2.1 + PKCE | Your Massed account (the lab) |
| Members | Invite by email, email OTP + password | Each member |

Honest limits. A deployed Worker cannot verify "this visitor is the person who deployed me" from Cloudflare by itself: deploying uses Cloudflare's OAuth, but that token lives in your browser or `wrangler`, not in the Worker. "Sign in with Cloudflare" is possible in principle (Cloudflare supports OAuth clients: `dash.cloudflare.com/oauth2/auth`, `/token`, `/userinfo`; clients are created in your account and are private to it unless a publisher domain is verified), but every self-hosted copy would need its own client created with its own redirect URL, plus client id/secret secrets. That is a heavier flow than the claim code, so it is a possible later upgrade, not what ships.

## Prerequisites

- A Massed Compute account you own (the lab). Sign up: https://vm.massedcompute.com/signup?referral=a6Cjx5Rdeg
- A Cloudflare account (Free plan works for Workers, D1, cron). R2 must be enabled (Dashboard, R2; needs a payment method on file even on the free tier).
- Node 20+ for the CLI path.
- For sign-in emails (admin code, member OTP): a sender domain on Cloudflare Email Routing/Email Sending, set as `MAIL_FROM`. Without it the claim code below is how you get in, and members cannot receive OTPs.

## Path A: Deploy to Cloudflare button

1. Click the button in the README (`https://deploy.workers.cloudflare.com/?url=https://github.com/vasanthsreeram/mass-compute-management-ui`). Sign in to Cloudflare in the browser when asked.
2. Cloudflare copies the repo to a GitHub/GitLab repo you own, creates the D1 database and R2 bucket from the config, and prompts for `SESSION_SECRET`, `DATA_KEY`, `ADMIN_EMAIL` (descriptions come from `package.json`).
3. It builds and deploys to `https://<name>.<your-subdomain>.workers.dev`.
4. Open `/app`, choose "I run the lab", enter the admin email you set, and use the emailed code. (If email is not configured yet, run the CLI path's claim step, below.)
5. Set `APP_URL` (Worker settings, Variables) to your public URL so emails link correctly.

## Path B: CLI (`npm run setup`)

```bash
git clone https://github.com/vasanthsreeram/mass-compute-management-ui.git
cd mass-compute-management-ui
npm install
npm run setup -- --dry-run   # print everything, call nothing
npm run setup
```

`scripts/setup.mjs`:

1. `wrangler whoami`; if logged out it runs `wrangler login` (Cloudflare OAuth in your browser).
2. Creates the D1 database `gpu-proxy` and the R2 bucket `<worker>-backups` if absent (no-op if they exist).
3. Writes `wrangler.local.jsonc` (gitignored) with your account id and database id. The maintainer's ids are never used.
4. Applies migrations to the remote D1, deploys, sets secrets (`SESSION_SECRET`, `DATA_KEY` generated only if not already set; `ADMIN_EMAIL` = your Cloudflare login email), sets `APP_URL`, redeploys.
5. Seeds a one-time admin claim code and prints the URL.

Options: `--name`, `--db`, `--bucket`, `--account-id` (required if your login has several accounts), `--admin-email` (required for API-token logins), `--skip-claim`, `--dry-run`. Later deploys: `npx wrangler deploy -c wrangler.local.jsonc`.

### Claim link

The claim is a normal admin-purpose row in `signup_otps` (`code_hash = sha256("<email>:<code>")`, 24 hour expiry, 5 attempts) so the existing `POST /api/auth/admin/verify` accepts it with no server change; `ADMIN_EMAIL` makes the bootstrap eligibility depend on your Cloudflare identity. The script prints `…/app#claim=<email>:<code>` (a fragment, so it never reaches server logs). Until `app.js` reads that fragment (item 7 above), open `/app` and use the admin sign-in; if email is not set up, call the verify endpoint yourself:

```bash
curl -i -X POST https://YOUR-URL/api/auth/admin/verify -H 'content-type: application/json' \
  -d '{"email":"you@example.com","code":"<code from setup>"}'
```

Do not request an emailed code first: that replaces the seeded one (re-run `npm run setup` to mint a new claim).

## Connect Massed Compute

In the app, "Attach Massed Compute" sends you to Massed's own consent page (OAuth 2.1 + PKCE, full scope). Your Massed password never reaches the desk. Revoke any time under Massed, Settings, Connected Apps. If it is revoked the desk shows "Massed connection lost" and emails admins.

## Invite members

Team tab, invite an email with a starting budget, GPU allowlist and machine cap. Members open your desk URL, choose "I'm a lab member", join with the invited email, confirm the emailed 6-digit code, and launch GPUs. They need no Massed account and no Cloudflare account. Massed bills you; the budget is an allocation the desk enforces.

## Backups bucket (R2)

Workspace backups and restores, and a final budget-safe backup before a member's VMs are stopped at $0, are stored in the R2 bucket bound as `BACKUPS` (default `gpu-proxy-backups`). The bucket is private; only the Worker reads it. Per-member quotas are enforced by the desk (see the Backups view for the numbers your build ships with).

Costs of R2 (check https://developers.cloudflare.com/r2/pricing/ for current numbers): storage is about $0.015 per GB-month after a free tier of 10 GB-month; Class A (write/list) operations about $4.50 per million after 1 million free; Class B (read) about $0.36 per million after 10 million free; **egress is free**. A few hundred GB of backups is single-digit dollars per month. Set bucket lifecycle rules in the dashboard to expire old backups. Workers, D1 and cron fit the free plans for a lab-sized team.

## Updating

Re-deploy with `npx wrangler deploy -c wrangler.local.jsonc` after `git pull`, and apply new migrations first: `npx wrangler d1 migrations apply gpu-proxy --remote -c wrangler.local.jsonc`. Never change `DATA_KEY` after launch.
