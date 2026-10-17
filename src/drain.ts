import type { InstanceRow } from "./db";
import { finishDrain } from "./backup";
import { recordVmEvent } from "./ledger";
import { terminateRow } from "./instances";

/**
 * Back up, then kill. A VM with a backup agent is never terminated for budget without a chance to flush:
 *  - a member is "low" when credit <= 10% of their budget (users.budget_cents, the credit at the last grant)
 *    or credit < the reserve (what their running VMs cost for 2 cron ticks), so the final minutes stay paid;
 *  - a low member's healthy VM goes ok -> draining; its next heartbeat says final_backup:true;
 *  - the agent's POST /api/agent/final-done terminates it (see finishDrain);
 *  - the cron is the safety net: terminate at the 10 minute deadline, or at once if the agent went silent for 3 minutes.
 * VMs without a healthy agent keep the old rule: killed when credit hits $0.
 */
export const DRAIN_PCT = 0.1;
export const RESERVE_MS = 10 * 60_000;
export const DRAIN_DEADLINE_MS = 10 * 60_000;
export const HEARTBEAT_STALE_MS = 3 * 60_000;

const DRAINING = ["draining", "final_requested"];

export const heartbeatFresh = (r: Pick<InstanceRow, "last_heartbeat_at">, now: number) =>
  !!r.last_heartbeat_at && now - Date.parse(r.last_heartbeat_at) < HEARTBEAT_STALE_MS;

export async function startDrain(env: Env, row: InstanceRow, reason: "budget" | "user", note: Record<string, unknown> = {}): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE instances SET backup_state = 'draining', drain_started_at = ?, drain_reason = ? WHERE id = ? AND backup_state = 'ok' AND status IN ('launching','running')",
  )
    .bind(new Date().toISOString(), reason, row.id)
    .run();
  if (!res.meta.changes) return false;
  await recordVmEvent(env, {
    kind: "backup_drain", instanceId: row.id, mcUuid: row.mc_uuid, userId: row.user_id, actor: "system",
    productName: row.product_name, rate: row.price_cents_per_hour, detail: { reason, ...note },
  });
  return true;
}

type Counts = { killed: number; failed: number; drained: number };

/** Kill without a confirmed final snapshot. `why` is stored with backup_before_kill:false. */
async function killNoBackup(env: Env, row: InstanceRow, why: string, c: Counts): Promise<void> {
  const user = row.drain_reason === "user";
  const waited = row.drain_started_at ? Math.round((Date.now() - Date.parse(row.drain_started_at)) / 1000) : null;
  try {
    await terminateRow(
      env, row,
      user ? { userId: row.user_id, kind: "user" } : { userId: null, kind: "system" },
      user ? "terminate" : "budget_kill",
      user ? "terminated by user (no backup)" : "budget exhausted",
      { backup_before_kill: false, why, waited_s: waited },
    );
    c.killed += 1;
  } catch (err) {
    c.failed += 1;
    console.error(JSON.stringify({ message: "meter kill failed, will retry", id: row.id, error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * The budget/drain half of the cron tick. `running` are the instances still active after metering.
 * Admin-owned VMs are never budget-drained (admins have no budget), but a user-requested drain is finished for anyone.
 */
export async function drainPass(env: Env, running: InstanceRow[], now: number, canAct: boolean): Promise<Counts> {
  const c: Counts = { killed: 0, failed: 0, drained: 0 };
  if (!canAct || !running.length) return c;
  const owners = [...new Set(running.map((r) => r.user_id))];
  const users = (
    await env.DB.prepare(`SELECT id, role, credit_cents, budget_cents FROM users WHERE id IN (${owners.map(() => "?").join(",")})`)
      .bind(...owners)
      .all<{ id: string; role: string; credit_cents: number; budget_cents: number }>()
  ).results ?? [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const rate = new Map<string, number>();
  for (const r of running) rate.set(r.user_id, (rate.get(r.user_id) ?? 0) + r.price_cents_per_hour);

  for (const inst of running) {
    const u = byId.get(inst.user_id);
    const fresh = await env.DB.prepare("SELECT * FROM instances WHERE id = ?").bind(inst.id).first<InstanceRow>();
    if (!u || !fresh || (fresh.status !== "running" && fresh.status !== "launching")) continue;
    const budgeted = u.role !== "admin";
    const broke = budgeted && u.credit_cents <= 0;
    const reserve = Math.ceil(((rate.get(inst.user_id) ?? 0) * RESERVE_MS) / 3_600_000);
    const low = budgeted && (u.credit_cents <= u.budget_cents * DRAIN_PCT || u.credit_cents < reserve);
    const state = fresh.backup_state;
    try {
      if (state === "done") {
        // Final snapshot confirmed but the terminate call failed earlier: retry.
        await finishDrain(env, fresh);
        c.killed += 1;
      } else if (DRAINING.includes(state)) {
        const started = Date.parse(fresh.drain_started_at ?? "") || now;
        if (fresh.drain_reason === "budget" && !low && !broke) {
          // Credit was topped up mid-drain: stand down.
          await env.DB.prepare("UPDATE instances SET backup_state = 'ok', drain_started_at = NULL, drain_reason = NULL WHERE id = ? AND backup_state IN ('draining','final_requested')").bind(fresh.id).run();
        } else if (!heartbeatFresh(fresh, now)) {
          await killNoBackup(env, fresh, "agent silent for 3 minutes", c);
        } else if (now - started >= DRAIN_DEADLINE_MS) {
          await killNoBackup(env, fresh, "drain deadline reached", c);
        }
      } else if (state === "ok" && (low || broke)) {
        if (heartbeatFresh(fresh, now)) {
          if (await startDrain(env, fresh, "budget", { credit_cents: u.credit_cents, budget_cents: u.budget_cents, reserve_cents: reserve })) c.drained += 1;
        } else if (broke) {
          await killNoBackup(env, fresh, "agent not responding", c);
        }
      } else if (broke) {
        await killNoBackup(env, fresh, "no backup agent", c);
      }
    } catch (err) {
      c.failed += 1;
      console.error(JSON.stringify({ message: "drain step failed, will retry", id: inst.id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  return c;
}
