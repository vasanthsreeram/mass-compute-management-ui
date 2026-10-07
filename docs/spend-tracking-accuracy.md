# Spend tracking: how it works and how accurate it is

**Update (backend build, 2026-10-07):** problems 1, 2, 5, 6 and 7 below are fixed in code (failed kill retries, final settlement on terminate, ghost VMs reconciled each tick, rounding once per VM with carry, watcher ends a VM at the app's terminate time or the gap midpoint). Problem 9 is partly fixed: billing starts when Massed accepts the launch. Balance calibration (suggestion 5) exists as `POST /api/admin/balance`. Still open: 3, 4, 8, 10 and the price-unit check. See [HANDOFF.md](HANDOFF.md).

Reviewed 2026-10-07 from the code (`src/meter.ts`, `src/watch.ts`, `src/instances.ts`, `src/policy.ts`, `src/massed.ts`) and the live D1 database (`gpu-proxy`). Massed exposes no balance, usage or invoice data over its API (see [massed-api-findings.md](massed-api-findings.md)), so everything here is an estimate. Claims marked **verified** come from the code or the database. Claims marked **inferred** or **unverified** are not confirmed against Massed.

## Two separate ledgers

Both run from the same 5-minute cron (`tickMeter` in `src/meter.ts`).

| | Per-tenant meter | Massed watcher |
|---|---|---|
| Tables | `instances`, `usage_events`, `users.credit_cents/spent_cents` | `massed_vms`, `massed_ticks` |
| Covers | VMs launched **through this proxy** | **Every** VM running on the operator's Massed account, however launched |
| Rate used | `price_cents_per_hour` from the inventory **at launch** | `final_price_hr` from `GET /instance` (so discounts show), else the inventory price |
| Purpose | Debit tenant budgets and kill VMs at $0 | Our only history of operator spend |

## Current data (verified, 2026-10-07)

- `massed_ticks`: 4031 ticks from 2026-09-23 to 2026-10-07 (14-day retention), **max running = 0**.
- `massed_vms`: **one** row, a 16-second sample VM (`gpu_1x_A30`, 35c/hr) recorded as 0 hours and 0 cents.
- `instances`, `usage_events`: **empty**. No tenant has launched through the proxy, and `spent_cents` is 0 for all 3 users.

So neither ledger has been compared against real spend yet.

## Ground truth available

- Lifetime top-ups from the dashboard: **$70.00** (see the findings doc). Balance on 2026-10-07 was **$15.35**. If no credits, refunds or coupons were applied, lifetime spend is about **$54.65**. Our watcher only started on 2026-08-27, so it cannot account for older spend.
- The dashboard shows the balance to the cent, so any VM run can be checked by hand: balance before, balance after, versus the watcher's cents for the same VM.

## Accuracy problems found

Ordered by impact on money.

### Under-counting or leaking

1. **Failed kill is recorded as success (`src/meter.ts`, kill loop).** When a tenant hits $0, `terminateInstances` runs inside a `try/catch`. If it throws, the error is logged and the rows are **still marked `terminated`**. The VM keeps running and billing on Massed, and the tenant meter stops counting it. (Verified in code. Fix: only mark terminated on success, retry next tick.)
2. **No final settlement on terminate (`src/instances.ts`, `handleTerminate`).** It sets `terminated_at` but never bills the time since `last_metered_at`, so up to 5 minutes per VM is never charged to the tenant. (Verified in code.)
3. **Short VMs are invisible or recorded as zero.** The watcher samples every 5 minutes, so a VM that starts and ends between ticks is never seen. The one VM in the database lived 16 seconds and was stored as 0 cents. The README states Massed bills a minimum of 1 hour. If so, every short VM is under-counted by up to a full hour. (The minimum is **unverified**.)
4. **History starts at 2026-08-27.** Anything older, and any VM launched and killed between two ticks, is missing.

### Over-counting

5. **Ghost VMs keep metering.** If a VM is terminated outside the proxy (the Massed dashboard, a Massed-side stop, a failed launch), its `instances` row stays `running` and `tickMeter` keeps debiting the tenant. The per-tenant meter never reconciles with the live `/instance` list, even though the watcher already fetches it. (Verified in code.)
6. **Rounding up on every tick.** Both ledgers use `Math.ceil(hours × rate)`, and the tenant meter forces a minimum of 1 cent per tick. A 5-minute tick costs `rate / 12`, rounded up. Worked examples: 57c/hr is 4.75c per tick but billed 5c (+5%), 35c/hr is 2.92c but billed 3c (+3%). The error is up to 1c per tick, which is up to 12c per VM-hour, and it is largest on cheap SKUs. (Verified arithmetic.)
7. **The watcher closes a VM at detection time.** When a VM disappears, it adds the whole gap since `last_seen_at`, but the VM actually ended somewhere inside that gap. That averages 2.5 minutes over-counted per VM. (Verified in code.)

### Wrong in either direction

8. **Price can drift from what Massed charges.** The tenant meter freezes the inventory price at launch. If Massed changes the price, applies a coupon, or bills a different rate (the watcher uses `final_price_hr`), the two ledgers disagree. `launch` also never passes `coupon`.
9. **Start of billing.** The tenant meter starts at our insert time (`launched_at`). Massed's `created` time can differ by seconds to minutes. The watcher back-fills from `created` for newly seen VMs, which is better.
10. **Unknown extra charges.** Storage, stopped VMs, egress or fees, if Massed charges them, appear nowhere in our estimate. **Unverified.**

### Price unit heuristic <a id="price-unit-heuristic"></a>

`dollarsToCents()` and `parseInventory()` treat any number above 20 as already being cents and anything at or below 20 as dollars. The inventory endpoint is verified to return cents (5280 for an 8x B300), so inventory parsing is fine. For running instances, `product.final_price_hr` is read through the same heuristic, but its unit has **not** been observed. If it is dollars, any VM at $20/hr or more (the 8x H100/H200/B200/B300 class, $25 to $53/hr) would be read as 25 to 53 **cents**, an under-count of roughly 100x. Check this the first time an 8-GPU VM runs.

## Realistic accuracy today

- **Long-running VMs (hours or more), correct price, no coupon:** the watcher should be within about 1 to 3%, driven by the per-tick rounding and the end-of-VM gap.
- **Short VMs (under an hour):** unreliable. If the 1-hour minimum is real, the error is large and always an under-count.
- **Tenant budgets:** safe in one direction (they over-charge slightly), but the ghost-VM and failed-kill bugs can drain a budget or leave a VM running unmetered.
- **Total operator spend:** only an estimate. It cannot match the dashboard balance exactly until calibrated.

## Suggested changes

In order of value:

1. Fix the failed-kill handling and add a final settlement on terminate.
2. Reconcile the tenant `instances` rows against the live `/instance` list each tick (mark missing VMs terminated and stop metering).
3. Round once per VM (or per day) instead of per tick, and carry the fractional cents.
4. Sample faster (the cron is 5 minutes) or bill a minimum per VM if the 1-hour minimum is confirmed.
5. Add a **calibration record**: store a manual or scraped balance with a timestamp, compute `balance drop / watcher cents` over each window, and show the error ratio on the admin page.
6. Check the `final_price_hr` unit when the first expensive VM runs.
7. Ask Massed for a balance and transactions endpoint. That removes the need for most of the above.
