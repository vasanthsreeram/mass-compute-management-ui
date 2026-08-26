---
name: gpu-proxy
description: Provision and manage GPU VMs through the Rackline proxy (Massed Compute upstream). Use when the user wants a GPU VM, to list inventory, launch, restart, terminate, or check remaining credit. Requires GPU_PROXY_URL and GPU_PROXY_API_KEY.
---

# Rackline GPU proxy

Do **not** call Massed Compute directly. This proxy enforces the user's budget, GPU allowlist, and concurrent cap.

Copy this folder into your agent's skills directory, then set:

```
GPU_PROXY_URL=https://<your-worker>
GPU_PROXY_API_KEY=gpk_...
```

## Auth

`Authorization: Bearer $GPU_PROXY_API_KEY`

## Tools (REST)

Base: `$GPU_PROXY_URL`

- `GET /api/me` — credit, allowlist, concurrent cap
- `GET /api/inventory` — SKUs this key may rent
- `GET /api/instances` — this user's VMs
- `POST /api/instances` — launch `{ "productName", "imageId?", "instanceName?", "regionName?", "sshPublicKey?" }`
- `GET /api/instances/:id` — details including SSH user/password (owner only)
- `POST /api/instances/:id/restart`
- `POST /api/instances/:id/terminate` — **destroys disk**
- `GET /api/usage` — timestamped debit events

Same tools over MCP: `POST $GPU_PROXY_URL/mcp` with the Bearer key.

## Playbook

1. `GET /api/me`. If `credit_cents` is 0 or `allowed_gpus` is empty, tell the user to ask an admin.
2. `GET /api/inventory`. Pick the cheapest SKU that fits the workload.
3. Launch. Show the returned `id`, SKU, `$/hr`.
4. Poll `GET /api/instances/:id` until `ip` is set. Give SSH as `ssh <username>@<ip>`.
5. When the job is done, confirm, then terminate.

## Hard rules

- Never call `vm.massedcompute.com`. The proxy is the only API.
- 402 / 403 are policy, not retries.
- Confirm terminate. There is no pause/snapshot.
- Do not store or echo other tenants' machines.
