---
name: gpu-proxy
description: Provision and manage GPU VMs through Massed Compute Management UI (Massed Compute upstream). Use when the user wants a GPU VM, to list inventory, match a cheap SKU, launch, restart, terminate, or check remaining credit. Requires GPU_PROXY_URL and GPU_PROXY_API_KEY.
---

# Massed Compute Management UI

Do **not** call Massed Compute directly. This proxy enforces the user's budget, GPU allowlist, and concurrent cap.

## Env

```
GPU_PROXY_URL=https://<your-worker>
GPU_PROXY_API_KEY=gpk_...
```

Header on every request: `Authorization: Bearer $GPU_PROXY_API_KEY`

## REST

Base: `$GPU_PROXY_URL`

| Action | Call |
|--------|------|
| Who am I / credit / lab status | `GET /api/me` (check `lab.can_launch`) |
| Allowed GPUs | `GET /api/inventory` |
| Match cheapest SKU | `POST /api/match` `{"query":"fine-tune llama 8b cheap"}` |
| List my VMs | `GET /api/instances` |
| Save an SSH public key | `POST /api/ssh-keys` `{"name":"agent","public_key":"ssh-ed25519 AAAA..."}` |
| Launch | `POST /api/instances` `{"productName":"gpu_1x_a6000","imageId":104}` |
| Get + SSH | `GET /api/instances/:id` (`access.ssh_command`) |
| Restart | `POST /api/instances/:id/restart` |
| Terminate (destroys disk) | `POST /api/instances/:id/terminate` |
| Usage | `GET /api/usage` |

MCP (same key): `POST $GPU_PROXY_URL/mcp` JSON-RPC `tools/list` / `tools/call`.

## Playbook

1. `GET /api/me`. If `credit_cents` is 0 or `allowed_gpus` is empty, tell the user to ask an admin.
2. Prefer `POST /api/match` with the job in plain language, then launch that SKU. Else `GET /api/inventory` and pick the cheapest that fits.
3. Launch. Show the returned `id`, SKU, `$/hr`. If the error `code` is `needs_ssh_key`, ask the user for a public key (never a private key) and save it with `POST /api/ssh-keys`, then retry.
4. Poll `GET /api/instances/:id` until `ip` is set. Give `access.ssh_command`. VMs are reached with the saved SSH key; there is no password.
5. When the job is done, confirm, then terminate.

## Backups

VMs launched here come with a backup agent: `~/work` is restored from the member's latest snapshot at start, backed up every 5 minutes, and backed up one last time before the VM is terminated. Keep outputs, checkpoints and code under `~/work`; anything else dies with the VM.

| Action | Call |
|--------|------|
| Backup state, usage, snapshots | `GET /api/backups` |
| Back up a VM now | `POST /api/instances/:id/backup` (or `gpu-proxy save --tag task-end` on the VM) |
| Restore on a VM | `gpu-proxy restore` |
| Terminate without the final backup | `POST /api/instances/:id/terminate` `{"force":true}` |

Terminate waits up to 90 s for the final backup and answers `{"state":"draining"}` if it is still running; the VM is then terminated as soon as the snapshot lands.

### Save at the end of every task

Add a stop hook so work is saved when the agent finishes, not only every 5 minutes. Run these on the VM (they do nothing if the agent is absent; hook formats change, so check the tool's hooks docs if one does not fire).

Claude Code, `~/.claude/settings.json`:

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "gpu-proxy save --tag task-end || true" } ] } ] } }
```

Codex, `~/.codex/config.toml` (notify runs when a turn completes):

```toml
notify = ["sh", "-c", "gpu-proxy save --tag task-end || true"]
```

Cursor, `~/.cursor/hooks.json`:

```json
{ "version": 1, "hooks": { "stop": [ { "command": "gpu-proxy save --tag task-end || true" } ] } }
```

## Hard rules

- Never call `vm.massedcompute.com`. The proxy is the only API.
- 402 / 403 are policy, not retries. 409 means the lab's Massed connection is down: tell the user an admin must reconnect it.
- Confirm terminate. There is no pause/snapshot: terminate wipes the disk. `~/work` is backed up first unless `force:true`.
- Do not store or echo other tenants' machines.
- Min billable unit upstream is 1 hour.
- Never print the Massed account key. You do not have it.
