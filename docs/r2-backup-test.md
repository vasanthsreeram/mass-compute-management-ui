# R2 backup loop: real-cloud test (2026-10-17)

Everything except a real Massed VM was tested for real: a throwaway Worker (`gpu-proxy-r2test`, `MOCK_MASSED=1`, workers.dev only), a real D1 database, a real R2 bucket, and the real `restic` 0.17-series binary from Homebrew on this Mac. All of it has been deleted (see Cleanup). The production worker `gpu-proxy`, its D1 and its bucket were never touched.

## Setup

- Resources: D1 `r2test-gpu-proxy` (migrations 0001-0008 applied remote), R2 `r2test-gpu-proxy-backups` (binding `BACKUPS`), Worker `gpu-proxy-r2test` at `https://gpu-proxy-r2test.s-vasanthrojin.workers.dev`. Secrets SESSION_SECRET, DATA_KEY (random) and ADMIN_EMAIL (dummy; mock returns `dev_code`).
- No Docker daemon was running (CLI present, no OrbStack), so the agent could not run in a Linux container. Instead the **real, served** `gpu-proxy-agent.sh` was run on macOS from a patched copy: only the paths (`/etc/gpu-proxy`, `/var/lib/gpu-proxy`, `/usr/local/bin`, log) and the root check were redirected into a temp dir, and the "download myself to $BIN" line copies the patched copy. Everything else is the shipped logic: `enroll` (piped from stdin, run under both `sh` and `dash`), JSON parsing, `restic init`, restore-on-enroll, `save`, the `run` loop with the heartbeat subshell, `backup_now`, `final_backup`, `final-done`. The no-systemd branch (`nohup ... run &`) was exercised, not the systemd unit files.
- `sh -n` and `dash -n` pass on the agent. shellcheck is not installed, so it was not run.
- Workspace: 5 x 20 MB random files + 50 small text files (97 MiB), plus `.cache/` and `node_modules/` (must be excluded).
- Network: home uplink to Cloudflare measured at about 60 MB/s (speed.cloudflare.com); the Worker restic endpoint is much slower, see numbers.

## Results

| # | Check | Result |
|---|---|---|
| 1 | Enrollment token trades for repo URL + password + `vmc_` credential, repo scoped to `restic/<user_id>/` | PASS |
| 2 | Token single use (second POST /api/agent/enroll) | PASS (403 `bad_token`) |
| 3 | Token expiry (`/api/dev/backdate`), garbage token | PASS (403, 403) |
| 4 | Real agent `enroll` via `curl ... \| sh -s -- enroll` style (stdin pipe), `sh` and `dash` | PASS |
| 5 | Initial backup 101.6 MB | PASS, 121 s (see slowness below) |
| 6 | Incremental backup after editing 3 files + adding 300 KB + 1 file | PASS, 427,608 bytes added, 19.6 s |
| 7 | `restic check` and `restic check --read-data` | PASS (no errors; 14 s and 25 s incl. read-data) |
| 8 | "Second VM" restore: new mock VM, same user, real `enroll` restores latest snapshot into a different home dir; `diff -r` equal (`.cache`, `node_modules` correctly absent) | PASS (enroll+restore 43 s) |
| 9 | Plain `restic restore latest` into fresh dir, `diff -r` equal | PASS, 6.4 s |
| 10 | Cross-user denial: member A credential on B's prefix (GET config, list, POST write) and reverse; `..` / `%2F` path tricks | PASS (403 / 404) |
| 11 | Quota enforced at write time (quota set to 2 MB, 5 MB backup) | PASS (restic got 507; `used_bytes` stayed at 5,200, no leaked reservation) |
| 12 | 100 MB Worker body limit: `restic backup --pack-size 128` of a 130 MB random file | PASS: Worker answers 413 (`too_large`); restic retries with 413/502/connection resets and never succeeds; no bytes stored, no quota leak. With the shipped `--pack-size 32` packs were 30-35 MB and uploaded fine. |
| 13 | Heartbeat every 4 s (test setting), `POST /api/instances/:id/backup` -> real agent does an `on-demand` backup | PASS (snapshot reported 24 s after request) |
| 14 | Budget drain: credit lowered, `POST /api/admin/meter` -> `drained: 2` -> heartbeat `final_backup` -> agent final backup -> `final-done` -> terminate | PASS: both VMs terminated "budget exhausted (backed up)" in 38 s total; events have `backup_before_kill: true` and the snapshot id |
| 15 | Final snapshot contains a file written just before the drain (restored on a third VM, `diff -r` equal) | PASS |
| 16 | Credential dies with the VM (restic 401, heartbeat 401 after terminate) | PASS |
| 17 | `DELETE /api/backups` wipes the prefix in R2 and D1 | PASS (22 objects / 100,452,481 B in 2.3 s; bucket listing empty after) |
| 18 | D1 `backup_objects` / `backup_usage` equal the R2 listing | PASS (26 objects, 100,457,681 B both) |
| 19 | `scripts/backup-smoke.mjs` (local miniflare) | PASS, all checks |

## Numbers

- Initial backup: 101,626,650 bytes processed, 101,660,547 added (random data, incompressible), **121 s** = about 0.8 MB/s, with restic retrying after "connection reset by peer" on two packs.
- Worker upload speed measured with curl: 20 MB POST takes 6.6-7.9 s (about 3 MB/s); a 1 KB POST takes about 1.4 s. So the 121 s is mostly the Worker path (per-request D1 round trips, plus the R2 write), not the home link. Small-object latency also makes `enroll` take 40-60 s (about a dozen sequential tiny requests) and an incremental backup of almost nothing take about 20 s.
- Incremental: 427,608 bytes added for about 300 KB of changes. On-demand with no changes: 2,687 bytes. Final snapshots: 28-35 KB.
- Restore: 97 MiB in 6.4 s.
- R2 at peak: 26 objects, 100,457,681 bytes (12 data packs, 5 index, 5 snapshots, 2 config, 2 keys), well under 1 GB. Estimated storage cost at the code's list price (1.5 cents/GB-month): about 0.15 cents/month, effectively $0 (free tier ignored). Operations: a few hundred Class A/B ops, inside the free tier. Total real cost of this test: $0.
- Wipe, then bucket deleted. Nothing remains.

## Observations / possible issues (not fixed, src/ untouched)

1. Throughput and latency of `PUT` is poor (above). Each object write does 4 sequential D1 queries (select old size, insert-or-ignore usage, atomic reserve, insert object) plus `quotaFor`/`getSetting` lookups. Cutting round trips (single batch) would help; not a correctness bug.
2. Large uploads over the home link saw `connection reset by peer`; restic retried and succeeded. Worth watching on a real Massed VM (datacentre link may differ).
3. `pkill` of the agent loop (SIGTERM) can take up to 5 s to take effect because the shell defers the trap until `sleep 5` ends. Harmless.
4. No bug found in the quota, auth, drain or restore logic. No source files were changed.

## Not tested

- A real Massed VM launch (prod lab has no Massed OAuth connection). Cost of Massed launches: $0, none were made.
- That Massed's `instances_launch` accepts the `command` field and actually executes it at startup on a Massed image (the schema check treats `command` as optional and skips it if absent). This is the biggest unknown.
- The systemd units (`gpu-proxy-agent.service`, `gpu-proxy-shutdown.service`) and the shutdown-time backup on a real Linux VM; the apt/bunzip restic install path (restic was preinstalled here); `getent`, `SUDO_USER`, `chown` ownership of `~/work` for the login user.
- The full agent on Linux (Docker was unavailable).
- The UI for backups (not started per HANDOFF).
- Production Worker limits and latency from a Massed datacentre IP.

## Cleanup (verified)

Worker `gpu-proxy-r2test` deleted, bucket emptied (via the app's own wipe endpoint) and `r2test-gpu-proxy-backups` deleted, D1 `r2test-gpu-proxy` deleted, `wrangler.r2test.jsonc` and temp VM dirs removed. `cf workers list`, `cf r2 buckets list`, `cf d1 list` show nothing named r2test; the old workers.dev URL returns 404. Note: the first resource creation and deploy used wrangler with the OAuth token before the instruction to use `cf` arrived; all later account operations (D1 queries, R2 listing, deletes) used `cf`.

## Finishing the real-VM test (human steps)

1. Deploy to prod (not done by the agent; see BLOCKERS.md for the commands): create bucket `gpu-proxy-backups`, apply migration 0008, `wrangler deploy`.
2. Open https://massedui.vasanth.cloud, sign in as admin (emailed code), click Connect Massed Compute and approve the consent screen (one time, human). Check `GET /api/lab/status` says `connected`, `schema_ok` not false.
3. Make sure the admin has an SSH key saved. In the admin settings confirm `backups_enabled` is true. Note `launchAcceptsCommand` must be true (admin `schema_tools` for `instances_launch` shows `command`); if Massed has no `command` property, the launch carries no bootstrap and the agent must be installed by hand over SSH: `curl -fsSL https://massedui.vasanth.cloud/gpu-proxy-agent.sh | sudo sh -s -- enroll <token>` with a token from a normal launch (tokens only appear in the launch command, so mint via launch).
4. Launch the cheapest SKU from the UI (watch the credit: about the cost of 15-20 minutes).
5. Verify: within about 5 minutes `GET /api/backups` shows the machine with `backup_state: ok` and heartbeats; `ssh ubuntu@<ip>`: `systemctl status gpu-proxy-agent gpu-proxy-shutdown`, `ls ~/work`, `gpu-proxy save`, check a snapshot appears. Write a file, press backup now, confirm a snapshot with tag `on-demand`.
6. Terminate from the UI without `force`: it should wait and report `backup_before_kill: true`. Launch a second VM and confirm `~/work` is restored automatically.
7. Optional drain test: lower a test member's credit near 10 percent of budget and run the meter (`POST /api/admin/meter`) to see the drain.
8. Clean up: Wipe backups for the test member (`DELETE /api/backups`) and confirm no VM is left running in Massed.
