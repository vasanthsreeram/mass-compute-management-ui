# Contributing

Thanks for helping with **Massed Compute Management UI**.

## Ground rules

- Keep the Massed account key out of git, issues, and screenshots.
- Do not add a public deployment URL to the README or the app. Each operator hosts their own Worker.
- Tenant VM passwords and `gpk_` keys are secrets. Don’t print them in logs or tests.
- Match the existing light-brown UI and short, plain copy.

## Setup

```bash
git clone https://github.com/vasanthsreeram/mass-compute-management-ui.git
cd mass-compute-management-ui
cp .dev.vars.example .dev.vars
npm install
npx wrangler d1 migrations apply gpu-proxy --local
npm run dev
```

Use `MOCK_MASSED=1` unless you have your own Massed key in `.dev.vars`.

## PRs

1. One concern per PR (UI, metering, docs, …).
2. Don’t commit `node_modules`, `.wrangler`, `.dev.vars`, `.massed-key`, `.prod-pw`, `.session-secret`, `.data-key`.
3. If you change `/api/*` or the dashboard, say how you tested (local `wrangler dev` is enough).
4. MIT license on the contribution.

## Code map

| Path | Role |
|------|------|
| `src/massed.ts` | Massed REST client (never expose the key) |
| `src/api.ts` | HTTP routes |
| `src/auth.ts` / `src/policy.ts` | Sessions, API keys, GPU + budget rules |
| `src/meter.ts` | Cron debit + terminate-at-zero |
| `assets/` | Dashboard |
| `skill/gpu-proxy/` | Copy-skill for agents |

Questions belong in GitHub issues. Don’t open an issue that includes credentials.
