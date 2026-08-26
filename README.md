# Mass Compute Management UI

Cloudflare Worker that sits in front of a **single** Massed Compute account key and turns it into a multi-tenant GPU rental desk:

- Email/password auth (Cloudflare Worker + D1, no WorkOS)
- Per-user **credit**, **GPU allowlist**, **concurrent cap**
- Per-user **API keys** (`gpk_…`) for coding agents
- Admin users who can promote other admins, edit permissions, and see each user’s VM history + timestamped usage
- Hourly Massed bill stays on the operator; users spend account credit

**Massed Compute signup (referral):** [https://vm.massedcompute.com/signup?referral=a6Cjx5Rdeg](https://vm.massedcompute.com/signup?referral=a6Cjx5Rdeg)

## Why a proxy

The Massed API key is account-wide. It can list every VM (including passwords), launch any SKU, and terminate the fleet. Users and agents must never see it.

## Admin

The **first registered account** is admin (or the email in `ADMIN_EMAIL`). Admins can:

| Action | UI / API |
|--------|----------|
| Promote / demote admins | Admin → user → Role |
| Set credit (cents) | `PATCH /api/admin/users/:id` |
| Set allowed GPUs (`*` or SKU list) | same |
| Set max concurrent VMs | same |
| See that user’s VMs (launched / terminated times) | Admin detail |
| See timestamped usage (hours, $) | Admin detail |
| See the whole fleet | Admin → Fleet |

You cannot demote yourself or remove the last admin.

## Agent

1. Log in to the UI → **Agent keys** → create a key.
2. Copy `skill/gpu-proxy/` into the agent’s skills folder.
3. Set `GPU_PROXY_URL` and `GPU_PROXY_API_KEY`.

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

Secrets (production):

```bash
npx wrangler secret put MASSED_COMPUTE_API_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DATA_KEY
```

Put the Massed key only in Wrangler secrets, never in git.

## Metering

Cron every 5 minutes: debit `price_cents_per_hour × elapsed` from the owner’s credit. At 0 credit, their running VMs are terminated. Massed still bills the operator (min 1 hour).
