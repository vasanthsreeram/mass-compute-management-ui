# Massed Compute Management UI

A Cloudflare Worker in front of **one** Massed Compute account key. People log in, rent GPUs, and stay inside the budget and SKU allowlist you give them. Agents use per-user API keys (`gpk_…`). They never see the Massed key.

**Massed Compute signup (referral):** [https://vm.massedcompute.com/signup?referral=a6Cjx5Rdeg](https://vm.massedcompute.com/signup?referral=a6Cjx5Rdeg)

## What it does

- Email + password auth on the Worker (D1 sessions, no WorkOS)
- Per-user **proxy budget**, **GPU allowlist**, **concurrent cap**
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

1. Log in → **Agent keys** → create a key.
2. Copy `skill/gpu-proxy/` into the agent’s skills folder.
3. Set `GPU_PROXY_URL` (your Worker origin) and `GPU_PROXY_API_KEY`.

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

Open `http://127.0.0.1:8787`.

Production secrets (Wrangler only — never git):

```bash
npx wrangler secret put MASSED_COMPUTE_API_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DATA_KEY
```

`MOCK_MASSED` must be `"0"` in `wrangler.jsonc` for live Massed inventory and Overview.

## Metering

Cron every 5 minutes: debit `price_cents_per_hour × elapsed` from a tenant’s proxy budget. At 0, their running VMs are terminated. Admins are not killed by proxy budget. Massed still bills the operator (min 1 hour).

## Security

- Never commit `.dev.vars`, `.massed-key`, or Wrangler secrets.
- Do not log the Massed key or tenant VM passwords.
- `POST /mcp` and `/api/*` (except auth + meta) require a session cookie or `gpk_` key.

See [SECURITY.md](./SECURITY.md) and [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
