import { audit } from "./db";
import { HttpError } from "./policy";

type UsageEvent = {
  id: string;
  instance_id: string;
  cents: number;
  hours: number;
  created_at: string;
  instance_name: string | null;
  product_name: string | null;
  api_key_id: string | null;
  email?: string;
};

/**
 * Spend as the app metered it. Aggregates come from SQL over all time; `events` is the latest 3000 rows
 * for charts. Per-key rows exist only for VMs launched with a gpk_ key; browser launches have no key.
 */
export async function usageReport(env: Env, userId: string | null) {
  const where = userId ? "WHERE u.user_id = ?" : "";
  const bind = <T extends D1PreparedStatement>(s: T) => s;
  const q = (sql: string) => (userId ? env.DB.prepare(sql).bind(userId) : bind(env.DB.prepare(sql)));

  const [rows, total, bySku, byUser, byKey] = await Promise.all([
    q(
      `SELECT u.id, u.instance_id, u.cents, u.hours, u.created_at, u.api_key_id,
              COALESCE(u.product_name, i.product_name) AS product_name, i.name AS instance_name, usr.email
       FROM usage_events u
       LEFT JOIN instances i ON i.id = u.instance_id
       JOIN users usr ON usr.id = u.user_id
       ${where} ORDER BY u.created_at DESC LIMIT 3000`,
    ).all<UsageEvent>(),
    q(`SELECT COALESCE(SUM(u.cents),0) AS cents, COALESCE(SUM(u.hours),0) AS hours, COUNT(*) AS n FROM usage_events u ${where}`).first<{ cents: number; hours: number; n: number }>(),
    q(
      `SELECT COALESCE(u.product_name, i.product_name, 'unknown') AS product_name, SUM(u.cents) AS cents, SUM(u.hours) AS hours
       FROM usage_events u LEFT JOIN instances i ON i.id = u.instance_id ${where}
       GROUP BY 1 ORDER BY cents DESC`,
    ).all<{ product_name: string; cents: number; hours: number }>(),
    q(
      `SELECT usr.id AS user_id, usr.email, SUM(u.cents) AS cents, SUM(u.hours) AS hours
       FROM usage_events u JOIN users usr ON usr.id = u.user_id ${where}
       GROUP BY usr.id ORDER BY cents DESC`,
    ).all<{ user_id: string; email: string; cents: number; hours: number }>(),
    q(
      `SELECT u.api_key_id, k.name, k.kind, k.key_prefix, usr.email, SUM(u.cents) AS cents, SUM(u.hours) AS hours
       FROM usage_events u
       JOIN users usr ON usr.id = u.user_id
       LEFT JOIN api_keys k ON k.id = u.api_key_id
       ${where ? `${where} AND` : "WHERE"} u.api_key_id IS NOT NULL
       GROUP BY u.api_key_id ORDER BY cents DESC`,
    ).all<{ api_key_id: string; name: string | null; kind: string | null; key_prefix: string | null; email: string; cents: number; hours: number }>(),
  ]);

  const keys = (byKey.results ?? []).map((k) => ({
    api_key_id: k.api_key_id,
    agent: k.name ?? "revoked key",
    kind: k.kind ?? "manual",
    key_prefix: k.key_prefix,
    email: k.email,
    cents: Number(k.cents || 0),
    hours: Number(k.hours || 0),
  }));
  const events = rows.results ?? [];
  return {
    events: userId ? events.map(({ email: _e, ...rest }) => rest) : events,
    summary: {
      spent_cents: Number(total?.cents || 0),
      hours: Number(total?.hours || 0),
      event_count: Number(total?.n || 0),
      by_sku: (bySku.results ?? []).map((r) => ({ ...r, cents: Number(r.cents || 0), hours: Number(r.hours || 0) })),
      by_user: userId ? [] : (byUser.results ?? []).map((r) => ({ ...r, cents: Number(r.cents || 0), hours: Number(r.hours || 0) })),
      by_key: keys,
      by_agent: keys.filter((k) => k.kind === "agent"),
    },
  };
}

/** Every launch, restart, terminate and failure with who did it. Admins see all; members see their own. */
export async function vmEventsReport(env: Env, userId: string | null, limit = 200) {
  const n = Math.min(500, Math.max(1, Math.floor(limit)));
  const sql = `SELECT e.id, e.kind, e.instance_id, e.mc_uuid, e.user_id, usr.email, e.api_key_id, k.name AS api_key_name,
                      e.actor, e.product_name, e.price_cents_per_hour, e.detail, e.created_at
               FROM vm_events e
               LEFT JOIN users usr ON usr.id = e.user_id
               LEFT JOIN api_keys k ON k.id = e.api_key_id
               ${userId ? "WHERE e.user_id = ?" : ""} ORDER BY e.created_at DESC LIMIT ${n}`;
  const rows = await (userId ? env.DB.prepare(sql).bind(userId) : env.DB.prepare(sql)).all();
  return { events: rows.results ?? [] };
}

/** Account burn over time from the 5-minute ticks, optionally bucketed (hours per bucket). */
export async function burnSeries(env: Env, hours = 24, bucketMinutes = 5) {
  const since = new Date(Date.now() - Math.min(720, Math.max(1, hours)) * 3_600_000).toISOString();
  const bucket = Math.max(5, Math.floor(bucketMinutes));
  const rows = await env.DB.prepare(
    `SELECT taken_at, running, burn_cents_per_hour, attributed_burn_cents_per_hour, unattributed_burn_cents_per_hour, unattributed_running
     FROM massed_ticks WHERE taken_at >= ? ORDER BY taken_at ASC`,
  )
    .bind(since)
    .all<{ taken_at: string; running: number; burn_cents_per_hour: number; attributed_burn_cents_per_hour: number; unattributed_burn_cents_per_hour: number; unattributed_running: number }>();
  const list = rows.results ?? [];
  if (bucket <= 5) return { bucket_minutes: 5, points: list };
  const out = new Map<number, { taken_at: string; running: number; burn_cents_per_hour: number; unattributed_burn_cents_per_hour: number; n: number }>();
  for (const r of list) {
    const key = Math.floor(Date.parse(r.taken_at) / (bucket * 60_000));
    const b = out.get(key) ?? { taken_at: new Date(key * bucket * 60_000).toISOString(), running: 0, burn_cents_per_hour: 0, unattributed_burn_cents_per_hour: 0, n: 0 };
    b.running += r.running;
    b.burn_cents_per_hour += r.burn_cents_per_hour;
    b.unattributed_burn_cents_per_hour += r.unattributed_burn_cents_per_hour;
    b.n += 1;
    out.set(key, b);
  }
  return {
    bucket_minutes: bucket,
    points: [...out.values()].map((b) => ({
      taken_at: b.taken_at,
      running: Math.round(b.running / b.n),
      burn_cents_per_hour: Math.round(b.burn_cents_per_hour / b.n),
      unattributed_burn_cents_per_hour: Math.round(b.unattributed_burn_cents_per_hour / b.n),
    })),
  };
}

export async function billingHistory(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT billing_method, recharge_amount_cents, recharge_threshold_cents, taken_at FROM billing_snapshots ORDER BY taken_at DESC LIMIT 100",
  ).all();
  return { snapshots: rows.results ?? [] };
}

export async function connectionHistory(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT e.id, e.kind, e.detail, e.created_at, u.email
     FROM connection_events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.created_at DESC LIMIT 100`,
  ).all();
  return { events: rows.results ?? [] };
}

/**
 * Manual balance readings. Massed exposes no balance, so an admin types in the figure from Massed's billing page.
 * Between two readings: expected drop = what our watcher estimated over the same window; ratio = actual / estimated.
 * `topup_cents` is money added between the previous reading and this one (recharges), so it is not counted as spend.
 */
export async function addBalanceEntry(env: Env, adminId: string, body: Record<string, unknown>) {
  const balance = Math.round(Number(body.balance_cents));
  if (!Number.isFinite(balance) || balance < 0) throw new HttpError(400, "balance_cents must be a non-negative number");
  const topup = Math.max(0, Math.round(Number(body.topup_cents) || 0));
  let takenAt = new Date().toISOString();
  if (body.taken_at) {
    const t = Date.parse(String(body.taken_at));
    if (!Number.isFinite(t) || t > Date.now() + 60_000) throw new HttpError(400, "taken_at must be a past ISO date");
    takenAt = new Date(t).toISOString();
  }
  const total = await env.DB.prepare("SELECT COALESCE(SUM(cents),0) AS c FROM massed_vms").first<{ c: number }>();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO balance_entries (id, admin_id, balance_cents, topup_cents, note, watch_cents_total, taken_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, adminId, balance, topup, body.note ? String(body.note).slice(0, 200) : null, Number(total?.c || 0), takenAt, new Date().toISOString())
    .run();
  await audit(env.DB, adminId, "balance.entry", { id, balance_cents: balance, topup_cents: topup });
  return calibrationReport(env);
}

export async function calibrationReport(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT b.id, b.balance_cents, b.topup_cents, b.note, b.watch_cents_total, b.taken_at, u.email
     FROM balance_entries b LEFT JOIN users u ON u.id = b.admin_id ORDER BY b.taken_at ASC`,
  ).all<{ id: string; balance_cents: number; topup_cents: number; note: string | null; watch_cents_total: number; taken_at: string; email: string | null }>();
  const list = rows.results ?? [];
  const entries = list.map((e, i) => {
    const prev = list[i - 1];
    if (!prev) return { ...e, window: null };
    const actual = prev.balance_cents + e.topup_cents - e.balance_cents;
    const estimated = e.watch_cents_total - prev.watch_cents_total;
    return {
      ...e,
      window: {
        from: prev.taken_at,
        actual_spend_cents: actual,
        estimated_spend_cents: estimated,
        // >1 means Massed charged more than we estimated.
        ratio: estimated > 0 ? Math.round((actual / estimated) * 1000) / 1000 : null,
      },
    };
  });
  const latest = entries[entries.length - 1] ?? null;
  const current = await env.DB.prepare("SELECT COALESCE(SUM(cents),0) AS c FROM massed_vms").first<{ c: number }>();
  return {
    entries: entries.reverse(),
    latest_balance_cents: latest?.balance_cents ?? null,
    latest_at: latest?.taken_at ?? null,
    // Last typed balance minus what we estimated since then. A guess, not a ledger.
    estimated_balance_cents: latest ? latest.balance_cents - (Number(current?.c || 0) - latest.watch_cents_total) : null,
  };
}

/** Admin assigns a VM launched outside the app to a member, so its spend counts toward them. */
export async function attributeVm(env: Env, adminId: string, uuid: string, userId: string | null) {
  const vm = await env.DB.prepare("SELECT uuid FROM massed_vms WHERE uuid = ?").bind(uuid).first();
  if (!vm) throw new HttpError(404, "Unknown VM");
  if (userId) {
    const u = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
    if (!u) throw new HttpError(404, "Unknown user");
    await env.DB.prepare("UPDATE massed_vms SET user_id = ?, attribution = 'manual' WHERE uuid = ?").bind(userId, uuid).run();
  } else {
    await env.DB.prepare("UPDATE massed_vms SET user_id = NULL, instance_id = NULL, api_key_id = NULL, attribution = 'unattributed' WHERE uuid = ?").bind(uuid).run();
  }
  await audit(env.DB, adminId, "vm.attribute", { uuid, userId });
  return { ok: true };
}

/**
 * Money-left estimate for the Overview card. It is NOT Massed's balance (Massed does not expose one): it is the last
 * balance an admin typed in, minus what the watcher estimated spent since. Null until an admin enters a balance.
 */
export async function balanceEstimate(env: Env) {
  const r = await calibrationReport(env);
  return {
    balance_cents_estimate: r.estimated_balance_cents,
    balance_cents_last_entry: r.latest_balance_cents,
    balance_as_of: r.latest_at,
    balance_source: "manual_entry_minus_estimated_spend",
  };
}
