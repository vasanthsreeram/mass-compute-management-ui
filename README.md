# Massed Compute Management UI

A Cloudflare Worker in front of **one lab Massed Compute account**. An admin connects it with "Login with Massed Compute" (OAuth 2.1 + PKCE). Teammates sign up by invite, with no Massed account, and launch GPUs on the lab account through the desk, inside the budget, GPU allowlist and concurrency cap you give them. Agents use per-user API keys (`gpk_…`). Nobody but the admin's grant ever touches Massed credentials.

**Massed Compute signup (referral):** [https://vm.massedcompute.com/signup?referral=a6Cjx5Rdeg](https://vm.massedcompute.com/signup?referral=a6Cjx5Rdeg)

## What it does

- **Lab account:** one admin's OAuth grant (full scope) carries every Massed call over MCP. `MASSED_COMPUTE_API_KEY` is only a fallback for single-operator setups. If the grant is lost, the desk shows it lab-wide and emails the admins. See `docs/HANDOFF.md`.
- **SSH-key launches:** members save a public key; it is injected at launch (Massed MCP redacts VM passwords)
- **Tracking:** every launch/restart/terminate/failure with its actor (user or agent key), spend per user / key / SKU, burn over time, VMs launched outside the app flagged "unattributed", recharge-setting history, connection events, manual balance calibration
- Email + password auth on the Worker (D1 sessions, no WorkOS)
- Per-user **proxy budget**, **GPU allowlist**, **concurrent cap**
- **Match:** describe a job; Workers AI (`@cf/meta/llama-3.1-8b-instruct-fast`) picks the cheapest live SKU that fits
- Per-user API keys for coding agents, plus a copy-skill
- Admins can promote other admins, edit permissions, and see VM + usage history
- Overview for admins reads the **live Massed account** (token check, running VMs, $/hr burn, recharge settings)
- Usage tab: timestamped proxy metering, by SKU and by user

### What the Massed API key actually returns

Official REST (`/api/v1`) + MCP (`account_billing`, `instances_list`, …) — Massed’s own `mc-cost-control` skill:

| Can | Cannot |
|-----|--------|
| Validate token | Wallet / credit **balance** |
| GPU inventory + prices + stock | Past / terminated VMs |
| Running VMs (name, SKU, `created`, status) | Recharge **history** / invoices |
| Accrued $ on **currently running** VMs = uptime × $/hr | Ledger of old spend |
| Billing **settings** (card vs crypto, recharge amount + threshold) | |
| Images, SSH keys, coupons, launch / restart / terminate | |
| MCP setup **recipes** | |

Overview never invents a $1000 (or any) Massed wallet. Tenant “proxy budget” in Admin is an allocation you set here.

Deeper notes: [Massed API, MCP, OAuth and dashboard findings](docs/massed-api-findings.md) and [how accurate our spend tracking is](docs/spend-tracking-accuracy.md).

## Why a proxy

The Massed API key is account-wide. It can list every VM (including passwords), launch any SKU, and terminate the fleet. Users and agents must never see it. This Worker is the tenant layer.

Massed still bills the operator. Tenant “proxy budget” is an allocation you set in Admin — it is not the Massed wallet.

## Admin

The **first registered account** is admin (or the email in `ADMIN_EMAIL`). Admins can:

| Action | Where |
|--------|--------|
| Promote / demote admins | Admin → user → Role |
| Set proxy budget (cents) | `PATCH /api/admin/users/:id` |
| Set allowed GPUs (`*` or SKU list) | same |
| Set max concurrent VMs | same |
| See that user’s VMs (launched / terminated times) | Admin detail |
| See timestamped usage | Usage tab + admin detail |
| See the whole proxy fleet | Admin → Fleet |
| See live Massed VMs | Overview + Admin → Massed account |

You cannot demote yourself or remove the last admin. Admins skip the proxy-budget check; Massed bills the real account.

## Agent

1. Log in → **Keys** → create a key.
2. Click **Copy for agent** (fills this desk’s URL; includes the new key if you just created one).
3. Paste into the agent, or save as `gpu-proxy/SKILL.md` in its skills folder.

REST and `POST /mcp` use the same key. The agent only sees *that user’s* inventory and machines.

## Local

```bash
cp .dev.vars.example .dev.vars
# SESSION_SECRET and DATA_KEY: long random strings
# MOCK_MASSED=1 skips live Massed calls
npm install
npx wrangler d1 migrations apply gpu-proxy --local
npm run dev
```

Open `http://127.0.0.1:8787`. The landing page is `/`, the app is `/app`.

**Live:** https://massedui.vasanth.cloud  
Demo login (\$0 proxy budget, cannot launch): `demo@massedui.vasanth.cloud` / `demo-zero`

Production secrets (Wrangler only — never git):

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DATA_KEY
```

Optional single-operator fallback: `npx wrangler secret put MASSED_COMPUTE_API_KEY` (REST; the only way to read VM passwords). Set `APP_URL` in `wrangler.jsonc` to your public URL (used in emails). `MOCK_MASSED` must stay `"0"`; it is a dev-only flag.

Self-hosting: deploy the Worker, apply the migrations, sign up as the first user (becomes admin), open **Fleet → Connect Massed Compute**.

## Metering

Cron every 5 minutes, in this order:

1. Read the live VM list from Massed once (through the lab connection).
2. **Reconcile:** a VM we billed that is gone upstream (killed in the Massed dashboard, never started) stops metering and is settled at the estimated end.
3. **Meter:** debit `price × elapsed` per VM, rounded once per VM with the fractional cent carried to the next tick.
4. **Budget kill:** a member at $0 has their VMs terminated on Massed. The row is marked terminated only if Massed confirms; otherwise it keeps metering and retries next tick. Admins are not killed by proxy budget.
5. **Massed watch:** upsert every running VM (joined to our users, or flagged unattributed), record the burn tick and any recharge-setting change. That is our history, since Massed returns no past usage.

Terminating through the app does a final settlement. Massed still bills the lab (min 1 hour, not enforced in our estimate). Everything here is an estimate until calibrated against the balance on Massed's billing page (admins can enter it under calibration).

## Security

- Never commit `.dev.vars`, `.massed-key`, or Wrangler secrets.
- Do not log the Massed key or tenant VM passwords.
- `POST /mcp` and `/api/*` (except auth + meta) require a session cookie or `gpk_` key.

See [SECURITY.md](./SECURITY.md) and [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
