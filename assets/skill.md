---
name: gpu-proxy
description: Provision and manage GPU VMs through Massed Compute Management UI (Massed Compute upstream). Use when the user wants a GPU VM, to list inventory, launch, restart, terminate, or check remaining credit. Requires GPU_PROXY_URL and GPU_PROXY_API_KEY.
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

| Action | Call |
|--------|------|
| Who am I / credit | `GET /api/me` |
| Allowed GPUs | `GET /api/inventory` |
| List my VMs | `GET /api/instances` |
| Launch | `POST /api/instances` `{"productName":"gpu_1x_a6000","imageId":104}` |
| Get + SSH | `GET /api/instances/:id` |
| Restart | `POST /api/instances/:id/restart` |
| Terminate (destroys disk) | `POST /api/instances/:id/terminate` |
| Usage | `GET /api/usage` |

MCP (same key): `POST $GPU_PROXY_URL/mcp` JSON-RPC `tools/list` / `tools/call`.

## Rules

1. Check `/api/me` and `/api/inventory` before launch. If the SKU is missing, stop — the user is not allowed that GPU.
2. 402 = not enough credit. Do not retry launch.
3. Confirm with the human before terminate. Terminate wipes the disk.
4. Never print the Massed account key. You do not have it.
5. Min billable unit upstream is 1 hour.
