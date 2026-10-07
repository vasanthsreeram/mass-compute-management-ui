import { audit } from "./db";
import type { InstanceRow } from "./db";
import { terminateRow } from "./instances";
import { meterInstance, recordVmEvent } from "./ledger";
import { getAccountSnapshot, isMock } from "./massed";
import { ensureSchema } from "./schema";
import { snapshotMassed } from "./watch";

// A VM that Massed has not listed yet may just be slow to appear. Only call it gone after this long.
const GHOST_GRACE_MS = 3 * 60_000;
// A launch row with no Massed uuid this old never got a VM (worker died mid-launch).
const STALE_LAUNCH_MS = 10 * 60_000;

export type TickResult = {
  billed: number;
  killed: number;
  kill_failed: number;
  reconciled: number;
  stale_launches: number;
  upstream_ok: boolean;
  watch: Awaited<ReturnType<typeof snapshotMassed>> | null;
};

/**
 * One 5-minute pass, in this order:
 *  1. read the live VM list once
 *  2. reconcile: rows whose VM is gone upstream stop metering (final settlement at the estimated end)
 *  3. meter what is still running (rounded once per VM, fractional cents carried)
 *  4. kill VMs of members at $0. A failed kill leaves the VM "running" and is retried next tick.
 *  5. feed the same live list to the Massed watcher
 * If the lab is not connected we still bill known VMs (they are still running upstream) but skip
 * reconcile and kills, since we cannot see or act on Massed.
 */
export async function tickMeter(env: Env): Promise<TickResult> {
  const now = Date.now();
  const snap = await getAccountSnapshot(env, { fresh: true });
  const upstreamOk = snap.connected;
  const canAct = upstreamOk || isMock(env);
  // Cached (30 min): re-reads the MCP write-tool schemas so a Massed change is caught before the next launch.
  if (snap.mode === "oauth") await ensureSchema(env, { maxAgeMs: 30 * 60_000 }).catch(() => null);
  const live = new Set(snap.instances.map((i) => i.uuid));

  const active = (
    await env.DB.prepare("SELECT * FROM instances WHERE status IN ('launching','running')").all<InstanceRow>()
  ).results ?? [];

  let reconciled = 0;
  let staleLaunches = 0;
  const running: InstanceRow[] = [];
  for (const inst of active) {
    const launchedMs = Date.parse(inst.launched_at);
    if (!inst.mc_uuid) {
      if (now - launchedMs > STALE_LAUNCH_MS) {
        await env.DB.prepare("UPDATE instances SET status = 'failed', terminated_at = ?, end_reason = 'launch never completed' WHERE id = ? AND mc_uuid IS NULL")
          .bind(new Date(now).toISOString(), inst.id)
          .run();
        await recordVmEvent(env, { kind: "stale_launch", instanceId: inst.id, userId: inst.user_id, apiKeyId: inst.api_key_id, actor: "system", productName: inst.product_name });
        staleLaunches += 1;
      }
      continue;
    }
    if (upstreamOk && !live.has(inst.mc_uuid) && now - launchedMs > GHOST_GRACE_MS) {
      // Gone upstream (killed in the Massed dashboard, expired, never started). End it between the last meter and now.
      const last = Date.parse(inst.last_metered_at);
      const endMs = Number.isFinite(last) ? last + (now - last) / 2 : now;
      const cents = await meterInstance(env, inst, endMs, { reason: "gone upstream" });
      if (cents !== null) {
        await recordVmEvent(env, { kind: "gone_upstream", instanceId: inst.id, mcUuid: inst.mc_uuid, userId: inst.user_id, apiKeyId: inst.api_key_id, actor: "system", productName: inst.product_name, rate: inst.price_cents_per_hour, detail: { settled_cents: cents } });
        reconciled += 1;
      }
      continue;
    }
    running.push(inst);
  }

  let billed = 0;
  const owners = new Set<string>();
  for (const inst of running) {
    const cents = await meterInstance(env, inst, now);
    if (cents) billed += 1;
    owners.add(inst.user_id);
  }

  let killed = 0;
  let killFailed = 0;
  if (canAct && owners.size) {
    const ids = [...owners];
    const broke = await env.DB.prepare(
      `SELECT id FROM users WHERE id IN (${ids.map(() => "?").join(",")}) AND role != 'admin' AND credit_cents <= 0`,
    )
      .bind(...ids)
      .all<{ id: string }>();
    const brokeIds = new Set((broke.results ?? []).map((r) => r.id));
    for (const inst of running.filter((r) => brokeIds.has(r.user_id))) {
      const fresh = await env.DB.prepare("SELECT * FROM instances WHERE id = ?").bind(inst.id).first<InstanceRow>();
      if (!fresh || (fresh.status !== "running" && fresh.status !== "launching")) continue;
      try {
        await terminateRow(env, fresh, { userId: null, kind: "system" }, "budget_kill", "budget exhausted");
        killed += 1;
      } catch (err) {
        killFailed += 1;
        console.error(JSON.stringify({ message: "meter kill failed, will retry", id: inst.id, error: err instanceof Error ? err.message : String(err) }));
      }
    }
    if (killed || killFailed) await audit(env.DB, null, "meter.kill", { killed, killFailed });
  }

  let watch: TickResult["watch"] = null;
  try {
    watch = await snapshotMassed(env, snap);
  } catch (err) {
    console.error(JSON.stringify({ message: "massed watch failed", error: String(err) }));
  }

  return { billed, killed, kill_failed: killFailed, reconciled, stale_launches: staleLaunches, upstream_ok: upstreamOk, watch };
}
