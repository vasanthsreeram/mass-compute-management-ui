import { audit } from "./db";
import { terminateInstances } from "./massed";

type Running = {
  id: string;
  mc_uuid: string | null;
  user_id: string;
  price_cents_per_hour: number;
  last_metered_at: string;
};

export async function tickMeter(env: Env): Promise<{ billed: number; killed: number }> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const running = await env.DB.prepare(
    "SELECT id, mc_uuid, user_id, price_cents_per_hour, last_metered_at FROM instances WHERE status IN ('launching','running')",
  ).all<Running>();

  let billed = 0;
  let killed = 0;
  const killByUser = new Map<string, string[]>();

  for (const inst of running.results ?? []) {
    const last = Date.parse(inst.last_metered_at);
    if (!Number.isFinite(last) || last >= now) continue;
    const hours = (now - last) / 3_600_000;
    const cents = Math.max(1, Math.ceil(hours * inst.price_cents_per_hour));
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users SET
           credit_cents = CASE WHEN role = 'admin' THEN credit_cents ELSE MAX(0, credit_cents - ?) END,
           spent_cents = spent_cents + ?
         WHERE id = ?`,
      ).bind(cents, cents, inst.user_id),
      env.DB.prepare("UPDATE instances SET last_metered_at = ? WHERE id = ?").bind(nowIso, inst.id),
      env.DB.prepare(
        "INSERT INTO usage_events (id, user_id, instance_id, cents, hours, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), inst.user_id, inst.id, cents, hours, nowIso),
    ]);
    billed += 1;
    const user = await env.DB.prepare("SELECT credit_cents, role FROM users WHERE id = ?")
      .bind(inst.user_id)
      .first<{ credit_cents: number; role: string }>();
    if (user?.role !== "admin" && (user?.credit_cents ?? 0) <= 0) {
      const list = killByUser.get(inst.user_id) ?? [];
      list.push(inst.id);
      killByUser.set(inst.user_id, list);
    }
  }

  for (const [userId, ids] of killByUser) {
    const rows = await env.DB.prepare(
      `SELECT id, mc_uuid FROM instances WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(...ids)
      .all<{ id: string; mc_uuid: string | null }>();
    const uuids = (rows.results ?? []).map((r) => r.mc_uuid).filter((u): u is string => !!u);
    try {
      await terminateInstances(env, uuids);
    } catch (err) {
      console.error(JSON.stringify({ message: "meter kill failed", error: String(err) }));
    }
    const termIso = new Date().toISOString();
    for (const id of ids) {
      await env.DB.prepare(
        "UPDATE instances SET status = 'terminated', terminated_at = ? WHERE id = ?",
      )
        .bind(termIso, id)
        .run();
    }
    await audit(env.DB, userId, "meter.kill", { instanceIds: ids });
    killed += ids.length;
  }

  return { billed, killed };
}
