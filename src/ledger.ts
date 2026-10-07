import { audit } from "./db";

export type Actor = { userId: string | null; apiKeyId?: string | null; kind: "user" | "agent" | "system" };

export async function recordVmEvent(
  env: Env,
  e: {
    kind: string;
    instanceId?: string | null;
    mcUuid?: string | null;
    userId?: string | null;
    apiKeyId?: string | null;
    actor?: string;
    productName?: string | null;
    rate?: number | null;
    detail?: unknown;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO vm_events (id, kind, instance_id, mc_uuid, user_id, api_key_id, actor, product_name, price_cents_per_hour, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      e.kind,
      e.instanceId ?? null,
      e.mcUuid ?? null,
      e.userId ?? null,
      e.apiKeyId ?? null,
      e.actor ?? "user",
      e.productName ?? null,
      e.rate ?? null,
      e.detail === undefined ? null : JSON.stringify(e.detail).slice(0, 1000),
      new Date().toISOString(),
    )
    .run();
}

export type MeterRow = {
  id: string;
  mc_uuid: string | null;
  user_id: string;
  api_key_id: string | null;
  product_name: string;
  price_cents_per_hour: number;
  last_metered_at: string;
  carry_cents: number;
};

/**
 * Bill one VM from its last metered time up to `endMs`.
 *
 * Money is rounded once per VM, not once per tick: each tick bills floor(exact) and carries the
 * fraction to the next tick, so 5-minute ticks on a 57c/hr GPU add up to 57c, not 60c.
 * A `final` settlement (terminate, upstream-gone, budget kill) rounds the remainder to the nearest
 * cent, closes the row and records why. Returns the cents billed, or null when another run already
 * metered this VM (the guarded UPDATE is the lock between cron and a manual tick).
 */
export async function meterInstance(
  env: Env,
  inst: MeterRow,
  endMs: number,
  final?: { reason: string },
): Promise<number | null> {
  const last = Date.parse(inst.last_metered_at);
  if (!Number.isFinite(last)) return 0;
  if (!final && last >= endMs) return 0;
  const hours = Math.max(0, (endMs - last) / 3_600_000);
  const exact = hours * inst.price_cents_per_hour + (inst.carry_cents || 0);
  const cents = final ? Math.round(exact) : Math.floor(exact);
  const carry = final ? 0 : exact - cents;
  const endIso = new Date(Math.max(endMs, last)).toISOString();

  const claim = final
    ? env.DB.prepare(
        `UPDATE instances SET last_metered_at = ?, carry_cents = 0, billed_cents = billed_cents + ?,
           status = 'terminated', terminated_at = ?, end_reason = ?
         WHERE id = ? AND last_metered_at = ? AND status IN ('launching','running')`,
      ).bind(endIso, cents, endIso, final.reason, inst.id, inst.last_metered_at)
    : env.DB.prepare(
        `UPDATE instances SET last_metered_at = ?, carry_cents = ?, billed_cents = billed_cents + ?
         WHERE id = ? AND last_metered_at = ? AND status IN ('launching','running')`,
      ).bind(endIso, carry, cents, inst.id, inst.last_metered_at);
  const res = await claim.run();
  if (!res.meta.changes) return null;

  const stmts: D1PreparedStatement[] = [];
  if (cents > 0) {
    stmts.push(
      env.DB.prepare(
        `UPDATE users SET
           credit_cents = CASE WHEN role = 'admin' THEN credit_cents ELSE MAX(0, credit_cents - ?) END,
           spent_cents = spent_cents + ?
         WHERE id = ?`,
      ).bind(cents, cents, inst.user_id),
    );
  }
  if (cents > 0 || (final && hours > 0)) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO usage_events (id, user_id, instance_id, cents, hours, created_at, api_key_id, product_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), inst.user_id, inst.id, cents, hours, endIso, inst.api_key_id, inst.product_name),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return cents;
}

export { audit };
