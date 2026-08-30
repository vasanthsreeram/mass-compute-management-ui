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
| Who am I / credit | `GET /api/me` |
| Allowed GPUs | `GET /api/inventory` |
| Match cheapest SKU | `POST /api/match` `{"query":"fine-tune llama 8b cheap"}` |
| List my VMs | `GET /api/instances` |
| Launch | `POST /api/instances` `{"productName":"gpu_1x_a6000","imageId":104}` |
| Get + SSH | `GET /api/instances/:id` |
| Restart | `POST /api/instances/:id/restart` |
| Terminate (destroys disk) | `POST /api/instances/:id/terminate` |
| Usage | `GET /api/usage` |

MCP (same key): `POST $GPU_PROXY_URL/mcp` JSON-RPC `tools/list` / `tools/call`.

## Playbook

1. `GET /api/me`. If `credit_cents` is 0 or `allowed_gpus` is empty, tell the user to ask an admin.
2. Prefer `POST /api/match` with the job in plain language, then launch that SKU. Else `GET /api/inventory` and pick the cheapest that fits.
3. Launch. Show the returned `id`, SKU, `$/hr`.
4. Poll `GET /api/instances/:id` until `ip` is set. Give SSH as `ssh <username>@<ip>`.
5. When the job is done, confirm, then terminate.

## Hard rules

- Never call `vm.massedcompute.com`. The proxy is the only API.
- 402 / 403 are policy, not retries.
- Confirm terminate. There is no pause/snapshot. Terminate wipes the disk.
- Do not store or echo other tenants' machines.
- Min billable unit upstream is 1 hour.
- Never print the Massed account key. You do not have it.
