import { getAccountSnapshot } from "./massed";

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
};

function hoursBetween(fromIso: string, toMs: number): number {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t) || t >= toMs) return 0;
  return (toMs - t) / 3_600_000;
}

async function runBatch(env: Env, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += 40) {
    await env.DB.batch(stmts.slice(i, i + 40));
  }
}

export async function snapshotMassed(env: Env): Promise<{
  running: number;
  burnCentsPerHour: number;
  opened: number;
  closed: number;
  error: string | null;
}> {
  const snap = await getAccountSnapshot(env);
  if (!snap.connected) {
    return { running: 0, burnCentsPerHour: 0, opened: 0, closed: 0, error: snap.error };
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const known = await env.DB.prepare("SELECT * FROM massed_vms").all<Watched>();
  const byId = new Map((known.results ?? []).map((r) => [r.uuid, r]));
  const liveIds = new Set(snap.instances.map((i) => i.uuid).filter(Boolean));
  const stmts: D1PreparedStatement[] = [];
  let opened = 0;
  let closed = 0;

  for (const inst of snap.instances) {
    if (!inst.uuid) continue;
    const prev = byId.get(inst.uuid);
    const rate = inst.priceCentsPerHour || prev?.price_cents_per_hour || 0;
    if (!prev) {
      const hours = inst.uptimeHours || hoursBetween(inst.created || nowIso, now);
      const cents = Math.max(0, Math.ceil(hours * rate));
      stmts.push(
        env.DB.prepare(
          `INSERT INTO massed_vms (uuid, name, product_name, image_name, price_cents_per_hour, massed_created_at,
            first_seen_at, last_seen_at, ended_at, hours, cents, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        ).bind(
          inst.uuid,
          inst.name || inst.uuid,
          inst.productName,
          inst.imageName,
          rate,
          inst.created,
          nowIso,
          nowIso,
          hours,
          cents,
          inst.status || "rented",
        ),
      );
      opened += 1;
      continue;
    }
    const hours = hoursBetween(prev.last_seen_at, now);
    const cents = Math.max(0, Math.ceil(hours * rate));
    stmts.push(
      env.DB.prepare(
        `UPDATE massed_vms SET name = ?, product_name = ?, image_name = ?, price_cents_per_hour = ?,
           last_seen_at = ?, hours = hours + ?, cents = cents + ?, status = ?, ended_at = NULL
         WHERE uuid = ?`,
      ).bind(
        inst.name || prev.name,
        inst.productName ?? prev.product_name,
        inst.imageName ?? prev.image_name,
        rate,
        nowIso,
        hours,
        cents,
        inst.status || prev.status,
        inst.uuid,
      ),
    );
  }

  for (const prev of byId.values()) {
    if (prev.ended_at || liveIds.has(prev.uuid)) continue;
    const hours = hoursBetween(prev.last_seen_at, now);
    const cents = Math.max(0, Math.ceil(hours * prev.price_cents_per_hour));
    stmts.push(
      env.DB.prepare(
        `UPDATE massed_vms SET last_seen_at = ?, hours = hours + ?, cents = cents + ?, ended_at = ?, status = 'ended'
         WHERE uuid = ? AND ended_at IS NULL`,
      ).bind(nowIso, hours, cents, nowIso, prev.uuid),
    );
    closed += 1;
  }

  const cutoff = new Date(now - 14 * 24 * 3_600_000).toISOString();
  stmts.push(
    env.DB.prepare(
      "INSERT INTO massed_ticks (id, taken_at, running, burn_cents_per_hour, watch_cents) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), nowIso, snap.running, snap.burnCentsPerHour, snap.accumulatedCents),
  );
  stmts.push(env.DB.prepare("DELETE FROM massed_ticks WHERE taken_at < ?").bind(cutoff));

  if (stmts.length) await runBatch(env, stmts);
  return {
    running: snap.running,
    burnCentsPerHour: snap.burnCentsPerHour,
    opened,
    closed,
    error: null,
  };
}

export async function massedWatchReport(env: Env) {
  const [vms, ticks, totals] = await Promise.all([
    env.DB.prepare(
      `SELECT uuid, name, product_name, image_name, price_cents_per_hour, massed_created_at,
              first_seen_at, last_seen_at, ended_at, hours, cents, status
       FROM massed_vms ORDER BY last_seen_at DESC LIMIT 200`,
    ).all(),
    env.DB.prepare(
      "SELECT id, taken_at, running, burn_cents_per_hour, watch_cents FROM massed_ticks ORDER BY taken_at DESC LIMIT 288",
    ).all(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(cents),0) AS cents, COALESCE(SUM(hours),0) AS hours, COUNT(*) AS n FROM massed_vms",
    ).first<{ cents: number; hours: number; n: number }>(),
  ]);
  return {
    vms: vms.results ?? [],
    ticks: ticks.results ?? [],
    summary: {
      cents: Number(totals?.cents || 0),
      hours: Number(totals?.hours || 0),
      vm_count: Number(totals?.n || 0),
    },
  };
}
