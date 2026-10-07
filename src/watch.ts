import { getAccountSnapshot, type MassedAccount } from "./massed";

type Watched = {
  uuid: string;
  name: string;
  product_name: string | null;
  image_name: string | null;
  price_cents_per_hour: number;
  massed_created_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  ended_at: string | null;
  hours: number;
  cents: number;
  status: string;
  instance_id: string | null;
  user_id: string | null;
  api_key_id: string | null;
  attribution: string;
};

type Ours = { id: string; mc_uuid: string; user_id: string; api_key_id: string | null; terminated_at: string | null };

type Attr = { attribution: "app" | "name_tag" | "manual" | "unattributed"; user_id: string | null; instance_id: string | null; api_key_id: string | null };

const TICK_RETENTION_DAYS = 30;

function hoursBetweenMs(fromMs: number, toMs: number): number {
  return Number.isFinite(fromMs) && toMs > fromMs ? (toMs - fromMs) / 3_600_000 : 0;
}

async function runBatch(env: Env, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += 40) {
    await env.DB.batch(stmts.slice(i, i + 40));
  }
}

/**
 * Join a Massed VM to one of our users.
 *  1. app:      we launched it, so an `instances` row holds its uuid
 *  2. name_tag: the VM name starts rl_<first 8 of user id>_ (backup if the row is missing)
 *  3. manual:   an admin assigned it (never overwritten)
 *  4. otherwise unattributed, i.e. launched outside the app and billing with no budget attached
 */
function attribute(uuid: string, name: string, prev: Watched | undefined, ours: Map<string, Ours>, usersByPrefix: Map<string, string>): Attr {
  if (prev?.attribution === "manual") {
    return { attribution: "manual", user_id: prev.user_id, instance_id: prev.instance_id, api_key_id: prev.api_key_id };
  }
  const row = ours.get(uuid);
  if (row) return { attribution: "app", user_id: row.user_id, instance_id: row.id, api_key_id: row.api_key_id };
  const m = /^rl_([0-9a-f]{8})_/.exec(name);
  const uid = m ? usersByPrefix.get(m[1]) : undefined;
  if (uid) return { attribution: "name_tag", user_id: uid, instance_id: null, api_key_id: null };
  return { attribution: "unattributed", user_id: null, instance_id: null, api_key_id: null };
}

export async function snapshotMassed(env: Env, snapIn?: MassedAccount): Promise<{
  running: number;
  burnCentsPerHour: number;
  opened: number;
  closed: number;
  unattributed: number;
  error: string | null;
}> {
  const snap = snapIn ?? (await getAccountSnapshot(env, { fresh: true }));
  if (!snap.connected) {
    return { running: 0, burnCentsPerHour: 0, opened: 0, closed: 0, unattributed: 0, error: snap.error };
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const [known, oursRows, users] = await Promise.all([
    env.DB.prepare("SELECT * FROM massed_vms").all<Watched>(),
    env.DB.prepare("SELECT id, mc_uuid, user_id, api_key_id, terminated_at FROM instances WHERE mc_uuid IS NOT NULL").all<Ours>(),
    env.DB.prepare("SELECT id FROM users").all<{ id: string }>(),
  ]);
  const byId = new Map((known.results ?? []).map((r) => [r.uuid, r]));
  const ours = new Map((oursRows.results ?? []).map((r) => [r.mc_uuid, r]));
  const usersByPrefix = new Map((users.results ?? []).map((u) => [u.id.slice(0, 8), u.id]));
  const liveIds = new Set(snap.instances.map((i) => i.uuid).filter(Boolean));
  const stmts: D1PreparedStatement[] = [];
  let opened = 0;
  let closed = 0;
  let unattributedRunning = 0;
  let unattributedBurn = 0;

  for (const inst of snap.instances) {
    if (!inst.uuid) continue;
    const prev = byId.get(inst.uuid);
    const rate = inst.priceCentsPerHour || prev?.price_cents_per_hour || 0;
    const name = inst.name || prev?.name || inst.uuid;
    const a = attribute(inst.uuid, name, prev, ours, usersByPrefix);
    if (a.attribution === "unattributed") {
      unattributedRunning += 1;
      unattributedBurn += rate;
    }
    if (!prev) {
      const hours = inst.uptimeHours || hoursBetweenMs(Date.parse(inst.created || nowIso), now);
      const exact = hours * rate;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO massed_vms (uuid, name, product_name, image_name, price_cents_per_hour, massed_created_at,
            first_seen_at, last_seen_at, ended_at, hours, cents, cents_exact, status, instance_id, user_id, api_key_id, attribution)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          inst.uuid, name, inst.productName, inst.imageName, rate, inst.created, nowIso, nowIso,
          hours, Math.round(exact), exact, inst.status || "rented", a.instance_id, a.user_id, a.api_key_id, a.attribution,
        ),
      );
      opened += 1;
      continue;
    }
    const hours = hoursBetweenMs(Date.parse(prev.last_seen_at), now);
    const add = hours * rate;
    stmts.push(
      env.DB.prepare(
        `UPDATE massed_vms SET name = ?, product_name = ?, image_name = ?, price_cents_per_hour = ?,
           last_seen_at = ?, hours = hours + ?, cents_exact = cents_exact + ?, cents = CAST(ROUND(cents_exact + ?) AS INTEGER),
           status = ?, ended_at = NULL, instance_id = ?, user_id = ?, api_key_id = ?, attribution = ?
         WHERE uuid = ?`,
      ).bind(
        name, inst.productName ?? prev.product_name, inst.imageName ?? prev.image_name, rate, nowIso, hours, add, add,
        inst.status || prev.status, a.instance_id, a.user_id, a.api_key_id, a.attribution, inst.uuid,
      ),
    );
  }

  for (const prev of byId.values()) {
    if (prev.ended_at || liveIds.has(prev.uuid)) continue;
    // It vanished somewhere between the last two samples. If the app ended it we know when; otherwise assume the middle.
    const seen = Date.parse(prev.last_seen_at);
    let endMs = seen + (now - seen) / 2;
    const term = ours.get(prev.uuid)?.terminated_at;
    if (term) {
      const t = Date.parse(term);
      if (Number.isFinite(t) && t >= seen && t <= now) endMs = t;
    }
    const hours = hoursBetweenMs(seen, endMs);
    const add = hours * prev.price_cents_per_hour;
    stmts.push(
      env.DB.prepare(
        `UPDATE massed_vms SET last_seen_at = ?, hours = hours + ?, cents_exact = cents_exact + ?,
           cents = CAST(ROUND(cents_exact + ?) AS INTEGER), ended_at = ?, status = 'ended'
         WHERE uuid = ? AND ended_at IS NULL`,
      ).bind(new Date(endMs).toISOString(), hours, add, add, new Date(endMs).toISOString(), prev.uuid),
    );
    closed += 1;
  }

  stmts.push(
    env.DB.prepare(
      `INSERT INTO massed_ticks (id, taken_at, running, burn_cents_per_hour, watch_cents,
         attributed_burn_cents_per_hour, unattributed_burn_cents_per_hour, unattributed_running)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), nowIso, snap.running, snap.burnCentsPerHour, snap.accumulatedCents,
      snap.burnCentsPerHour - unattributedBurn, unattributedBurn, unattributedRunning,
    ),
  );
  stmts.push(
    env.DB.prepare("DELETE FROM massed_ticks WHERE taken_at < ?").bind(
      new Date(now - TICK_RETENTION_DAYS * 24 * 3_600_000).toISOString(),
    ),
  );

  // Recharge amount / threshold: store a row only when something changed.
  if (snap.billing) {
    const b = snap.billing;
    const last = await env.DB.prepare(
      "SELECT billing_method, recharge_amount_cents, recharge_threshold_cents FROM billing_snapshots ORDER BY taken_at DESC LIMIT 1",
    ).first<{ billing_method: string | null; recharge_amount_cents: number; recharge_threshold_cents: number }>();
    if (
      !last ||
      last.billing_method !== b.billingMethod ||
      last.recharge_amount_cents !== b.rechargeAmountCents ||
      last.recharge_threshold_cents !== b.rechargeThresholdCents
    ) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO billing_snapshots (id, billing_method, recharge_amount_cents, recharge_threshold_cents, taken_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(crypto.randomUUID(), b.billingMethod, b.rechargeAmountCents, b.rechargeThresholdCents, nowIso),
      );
    }
  }

  if (stmts.length) await runBatch(env, stmts);
  return {
    running: snap.running,
    burnCentsPerHour: snap.burnCentsPerHour,
    opened,
    closed,
    unattributed: unattributedRunning,
    error: null,
  };
}

export async function massedWatchReport(env: Env) {
  const [vms, ticks, totals, unattr] = await Promise.all([
    env.DB.prepare(
      `SELECT v.uuid, v.name, v.product_name, v.image_name, v.price_cents_per_hour, v.massed_created_at,
              v.first_seen_at, v.last_seen_at, v.ended_at, v.hours, v.cents, v.status,
              v.attribution, v.user_id, v.instance_id, v.api_key_id, u.email
       FROM massed_vms v LEFT JOIN users u ON u.id = v.user_id
       ORDER BY v.last_seen_at DESC LIMIT 200`,
    ).all(),
    env.DB.prepare(
      `SELECT id, taken_at, running, burn_cents_per_hour, watch_cents,
              attributed_burn_cents_per_hour, unattributed_burn_cents_per_hour, unattributed_running
       FROM massed_ticks ORDER BY taken_at DESC LIMIT 288`,
    ).all(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(cents),0) AS cents, COALESCE(SUM(hours),0) AS hours, COUNT(*) AS n FROM massed_vms",
    ).first<{ cents: number; hours: number; n: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(cents),0) AS cents, COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END),0) AS running
       FROM massed_vms WHERE attribution = 'unattributed'`,
    ).first<{ cents: number; n: number; running: number }>(),
  ]);
  return {
    vms: vms.results ?? [],
    ticks: ticks.results ?? [],
    summary: {
      cents: Number(totals?.cents || 0),
      hours: Number(totals?.hours || 0),
      vm_count: Number(totals?.n || 0),
      unattributed_cents: Number(unattr?.cents || 0),
      unattributed_vm_count: Number(unattr?.n || 0),
      unattributed_running: Number(unattr?.running || 0),
    },
  };
}
