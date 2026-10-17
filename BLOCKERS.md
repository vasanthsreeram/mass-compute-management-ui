# Blockers

## 1. Massed OAuth consent (human, one time)

The production lab (`https://massedui.vasanth.cloud`) has no Massed Compute OAuth connection, so no real VM can be launched (launch, restart, terminate and inventory all go through the lab account). An admin must sign in and approve Massed's consent screen once. This cannot be done by an agent.

Steps: open https://massedui.vasanth.cloud/app, sign in as admin (emailed code), click Connect Massed Compute, approve in the Massed consent page. It returns to `/app?massed=connected`. Verify `GET /api/lab/status` -> `state: connected`.

Until this is done the real-VM part of the R2 backup test is blocked (see `docs/r2-backup-test.md`, "Finishing the real-VM test"). Everything else was tested against real R2/D1/restic on 2026-10-17 with a throwaway Worker, which is deleted.

## 2. Deploy to production (decision for the owner; NOT done)

Production does not have the backup code deployed: bucket `gpu-proxy-backups` does not exist and migration `0008_r2_backups.sql` is not applied (as of 2026-10-17; `wrangler.jsonc` already has the `BACKUPS` binding, so a deploy without the bucket will fail until it is created). With no bucket binding backups simply stay off, so deploying is low risk, but it changes the live desk. Commands (run from the repo root; OAuth for the account `7efeb52e...`):

```sh
export CLOUDFLARE_ACCOUNT_ID=7efeb52ec5727a903edd8ef7ae8eb925
# 1. bucket
~/.bun/bin/cf r2 buckets create gpu-proxy-backups        # or: npx wrangler r2 bucket create gpu-proxy-backups
# 2. migration (also applies any of 0005-0007 not yet live); wrangler tracks d1_migrations, a raw `cf d1 query` would not
npx wrangler d1 migrations apply gpu-proxy --remote
# 3. deploy
npx wrangler deploy        # or `npm run deploy`
# 4. check
curl -s https://massedui.vasanth.cloud/health
```

Note: `cf migrate` converts a Wrangler project to cf config; it does not apply D1 migrations. Rollback: redeploy the previous version (`npx wrangler rollback`); migration 0008 only adds columns/tables.

## 3. Auth token expiry

The `cf` OAuth token expires about 21:13 SGT on 2026-10-17; Cloudflare steps were all finished before then.
