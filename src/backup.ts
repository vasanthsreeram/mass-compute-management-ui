import type { AuthContext } from "./auth";
import { audit, getUserById, type InstanceRow } from "./db";
import { deriveSecret, bytesToHex, randomBytes, sha256Hex } from "./crypto";
import { getSetting, setSetting } from "./lab";
import { HttpError } from "./policy";
import { recordVmEvent } from "./ledger";
import { terminateRow } from "./instances";
import { launchAcceptsCommand } from "./schema";

/**
 * R2 backups. Each member has a restic repository at restic/<user_id>/ in the BACKUPS bucket, served by this
 * Worker (src/restic.ts). A VM never holds R2 keys or a long-lived gpk_ key: the launch command carries a
 * single-use enrollment token, which the VM trades for a credential bound to that user's prefix and that instance.
 */

export const ENROLL_TTL_MS = 10 * 60_000;
export const HEARTBEAT_SECONDS = 45;
export const DEFAULT_QUOTA_BYTES = 5 * 1024 ** 3;
/** R2 storage price, cents per GB-month (1 GB = 1e9 bytes), for the "estimated cost" numbers. */
export const PRICE_CENTS_PER_GB_MONTH = 1.5;
const DEFAULT_WORK_DIR = "~/work";

export const estMonthlyCents = (bytes: number) => Math.round((bytes / 1e9) * PRICE_CENTS_PER_GB_MONTH * 10000) / 10000;

/** The bucket exists (binding) and an admin has not switched backups off. */
export async function backupsEnabled(env: Env): Promise<boolean> {
  return !!env.BACKUPS && (await getSetting(env, "backups_enabled")) !== "0";
}

export async function defaultQuota(env: Env): Promise<number> {
  const v = Number(await getSetting(env, "backup_default_quota_bytes"));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_QUOTA_BYTES;
}

export async function quotaFor(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT backup_quota_bytes AS q FROM users WHERE id = ?").bind(userId).first<{ q: number | null }>();
  return row?.q ?? (await defaultQuota(env));
}

export async function usedBytes(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT used_bytes AS n FROM backup_usage WHERE user_id = ?").bind(userId).first<{ n: number }>();
  return Math.max(0, row?.n ?? 0);
}

/** Server-side restic password per member. The Worker can re-derive it (so it can decrypt): client-side-only encryption is future work. */
export function resticPassword(env: Env, userId: string): Promise<string> {
  return deriveSecret(env.DATA_KEY, "gpu-proxy-restic-v1", `restic:${userId}`);
}

/** Mint the single-use enrollment token for a VM we are about to launch. Only its hash is stored. */
export async function mintEnrollment(env: Env, userId: string, instanceId: string): Promise<string> {
  const token = `gpe_${bytesToHex(randomBytes(24))}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO backup_enrollments (token_hash, user_id, instance_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(token), userId, instanceId, Math.floor((now + ENROLL_TTL_MS) / 1000), new Date(now).toISOString())
    .run();
  return token;
}

export function bootstrapCommand(origin: string, token: string): string {
  return `curl -fsSL ${origin.replace(/\/+$/, "")}/gpu-proxy-agent.sh | sh -s -- enroll ${token}`;
}

/** Whether this launch should carry the bootstrap command: binding, lab switch, per-launch opt-out, and Massed accepting `command`. */
export async function wantBackup(env: Env, optOut: boolean): Promise<boolean> {
  return !optOut && (await backupsEnabled(env)) && (await launchAcceptsCommand(env));
}

// ---- VM credential auth (restic Basic auth, agent Bearer) ----------------------------------------------------

export type VmAuth = { userId: string; instanceId: string };

export async function vmAuth(env: Env, request: Request): Promise<VmAuth | null> {
  const h = request.headers.get("Authorization") ?? "";
  let cred = "";
  const basic = h.match(/^Basic\s+(.+)$/i);
  const bearer = h.match(/^Bearer\s+(vmc_[A-Za-z0-9_-]+)$/i);
  if (basic) {
    try {
      cred = atob(basic[1]).split(":").slice(1).join(":");
    } catch {
      return null;
    }
  } else if (bearer) cred = bearer[1];
  if (!/^vmc_[A-Za-z0-9_-]+$/.test(cred)) return null;
  // Only a credential for a live instance works; terminate also stamps revoked_at.
  return env.DB.prepare(
    `SELECT c.user_id AS userId, c.instance_id AS instanceId FROM vm_credentials c
     JOIN instances i ON i.id = c.instance_id
     WHERE c.cred_hash = ? AND c.revoked_at IS NULL AND i.status IN ('launching','running')`,
  )
    .bind(await sha256Hex(cred))
    .first<VmAuth>();
}

async function requireVm(env: Env, request: Request): Promise<VmAuth & { row: InstanceRow }> {
  const a = await vmAuth(env, request);
  if (!a) throw new HttpError(401, "Invalid or revoked VM credential", "bad_credential");
  const row = await env.DB.prepare("SELECT * FROM instances WHERE id = ?").bind(a.instanceId).first<InstanceRow>();
  if (!row) throw new HttpError(401, "Invalid or revoked VM credential", "bad_credential");
  return { ...a, row };
}

// ---- Agent API -----------------------------------------------------------------------------------------------

/** POST /api/agent/enroll {token, hostname?, ...hints}: trade the single-use token for the VM credential + restic settings. */
export async function agentEnroll(env: Env, body: Record<string, unknown>, origin: string) {
  const token = String(body.token ?? "");
  if (!/^gpe_[0-9a-f]{48}$/.test(token)) throw new HttpError(400, "Bad enrollment token", "bad_token");
  const hash = await sha256Hex(token);
  const now = new Date();
  // Atomic single use: the first UPDATE to flip used_at wins, everything else sees 0 changes.
  const claim = await env.DB.prepare(
    "UPDATE backup_enrollments SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(now.toISOString(), hash, Math.floor(now.getTime() / 1000))
    .run();
  if (!claim.meta.changes) throw new HttpError(403, "Enrollment token is invalid, expired or already used", "bad_token");
  const enr = await env.DB.prepare("SELECT user_id, instance_id FROM backup_enrollments WHERE token_hash = ?")
    .bind(hash)
    .first<{ user_id: string; instance_id: string }>();
  const inst = enr && (await env.DB.prepare("SELECT * FROM instances WHERE id = ?").bind(enr.instance_id).first<InstanceRow>());
  if (!enr || !inst || !["launching", "running"].includes(inst.status)) throw new HttpError(403, "That machine is no longer running", "bad_token");

  const cred = `vmc_${bytesToHex(randomBytes(24))}`;
  const iso = now.toISOString();
  await env.DB.batch([
    // One live credential per instance: a re-enroll replaces the old one.
    env.DB.prepare("UPDATE vm_credentials SET revoked_at = ? WHERE instance_id = ? AND revoked_at IS NULL").bind(iso, inst.id),
    env.DB.prepare("INSERT INTO vm_credentials (cred_hash, user_id, instance_id, created_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(cred), inst.user_id, inst.id, iso),
    env.DB.prepare("UPDATE instances SET backup_state = 'ok', last_heartbeat_at = ? WHERE id = ? AND backup_state = 'none'").bind(iso, inst.id),
  ]);
  await recordVmEvent(env, { kind: "backup_enrolled", instanceId: inst.id, mcUuid: inst.mc_uuid, userId: inst.user_id, actor: "system", productName: inst.product_name, detail: { hostname: String(body.hostname ?? "").slice(0, 80) } });

  const host = new URL(origin);
  return {
    repository: `rest:${host.protocol}//vm:${cred}@${host.host}/restic/${inst.user_id}/`,
    credential: cred,
    password: await resticPassword(env, inst.user_id),
    heartbeat_seconds: HEARTBEAT_SECONDS,
    backup_seconds: 300,
    work_dir: DEFAULT_WORK_DIR,
    host_tag: "workspace",
    quota_bytes: await quotaFor(env, inst.user_id),
    instance_id: inst.id,
  };
}

/** POST /api/agent/heartbeat: liveness, and the way the desk talks back ({final_backup, backup_now}). */
export async function agentHeartbeat(env: Env, request: Request) {
  const { row } = await requireVm(env, request);
  const now = new Date().toISOString();
  const finalBackup = row.backup_state === "draining" || row.backup_state === "final_requested";
  await env.DB.prepare(
    `UPDATE instances SET last_heartbeat_at = ?, backup_requested = 0,
       backup_state = CASE WHEN backup_state = 'draining' THEN 'final_requested' ELSE backup_state END
     WHERE id = ?`,
  )
    .bind(now, row.id)
    .run();
  return { final_backup: finalBackup, backup_now: row.backup_requested === 1 };
}

/** POST /api/agent/backup {snapshot_id, bytes_added, total_bytes, tag}: one finished snapshot. */
export async function agentBackup(env: Env, request: Request, body: Record<string, unknown>) {
  const { row } = await requireVm(env, request);
  const snapshot = String(body.snapshot_id ?? "").slice(0, 80);
  if (!snapshot) throw new HttpError(400, "snapshot_id required");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO backups (id, user_id, instance_id, snapshot_id, tag, bytes_added, total_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), row.user_id, row.id, snapshot, String(body.tag ?? "").slice(0, 40) || null, n(body.bytes_added), n(body.total_bytes), now),
    env.DB.prepare("UPDATE instances SET last_backup_at = ? WHERE id = ?").bind(now, row.id),
  ]);
  return { ok: true };
}

/** POST /api/agent/final-done {snapshot_id}: the last snapshot landed, so the VM may be terminated now. */
export async function agentFinalDone(env: Env, request: Request, ctx: ExecutionContext) {
  const { row } = await requireVm(env, request);
  if (row.backup_state !== "draining" && row.backup_state !== "final_requested") {
    throw new HttpError(409, "No final backup was requested", "not_draining");
  }
  const snap = await env.DB.prepare(
    "SELECT snapshot_id, created_at FROM backups WHERE instance_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(row.id, row.drain_started_at ?? row.last_heartbeat_at ?? "")
    .first<{ snapshot_id: string; created_at: string }>();
  if (!snap) throw new HttpError(409, "Report the snapshot with /api/agent/backup first", "no_snapshot");
  const claim = await env.DB.prepare(
    "UPDATE instances SET backup_state = 'done' WHERE id = ? AND backup_state IN ('draining','final_requested')",
  )
    .bind(row.id)
    .run();
  if (claim.meta.changes) ctx.waitUntil(finishDrain(env, { ...row, backup_state: "done" }).catch((e) => console.error(JSON.stringify({ message: "final-done terminate failed, cron will retry", id: row.id, error: String(e) }))));
  return { ok: true, terminating: true, snapshot_id: snap.snapshot_id };
}

/** Terminate a drained VM whose final snapshot is confirmed; used by final-done and as the cron's retry for state `done`. */
export async function finishDrain(env: Env, row: InstanceRow): Promise<void> {
  const snap = await env.DB.prepare("SELECT snapshot_id FROM backups WHERE instance_id = ? ORDER BY created_at DESC LIMIT 1").bind(row.id).first<{ snapshot_id: string }>();
  const waited = row.drain_started_at ? Math.round((Date.now() - Date.parse(row.drain_started_at)) / 1000) : null;
  const user = row.drain_reason === "user";
  await terminateRow(
    env, row,
    user ? { userId: row.user_id, kind: "user" } : { userId: null, kind: "system" },
    user ? "terminate" : "budget_kill",
    user ? "terminated by user (backed up)" : "budget exhausted (backed up)",
    { backup_before_kill: true, snapshot_id: snap?.snapshot_id ?? null, waited_s: waited },
  );
}

// ---- Member / admin API --------------------------------------------------------------------------------------

export async function listBackups(env: Env, userId: string) {
  const [used, quota, snaps, machines] = await Promise.all([
    usedBytes(env, userId),
    quotaFor(env, userId),
    env.DB.prepare(
      `SELECT b.id, b.snapshot_id, b.instance_id, i.name AS instance_name, b.tag, b.bytes_added, b.total_bytes, b.created_at
       FROM backups b LEFT JOIN instances i ON i.id = b.instance_id WHERE b.user_id = ? ORDER BY b.created_at DESC LIMIT 50`,
    ).bind(userId).all(),
    env.DB.prepare(
      `SELECT id AS instance_id, name, status, backup_state, last_heartbeat_at, last_backup_at, backup_requested, drain_started_at
       FROM instances WHERE user_id = ? AND (status IN ('launching','running') OR backup_state != 'none')
       ORDER BY launched_at DESC LIMIT 20`,
    ).bind(userId).all(),
  ]);
  const snapshots = snaps.results ?? [];
  return {
    enabled: await backupsEnabled(env),
    used_bytes: used,
    quota_bytes: quota,
    est_monthly_cents: estMonthlyCents(used),
    price_cents_per_gb_month: PRICE_CENTS_PER_GB_MONTH,
    last_backup_at: (snapshots[0]?.created_at as string | undefined) ?? null,
    snapshots,
    machines: machines.results ?? [],
    restore_command: "gpu-proxy restore",
  };
}

/** POST /api/instances/:id/backup: ask the VM's agent for a backup at its next heartbeat (within ~45 s). */
export async function requestBackup(env: Env, ctx: AuthContext, id: string) {
  const row = await env.DB.prepare("SELECT * FROM instances WHERE id = ?").bind(id).first<InstanceRow>();
  if (!row || (row.user_id !== ctx.user.id && ctx.user.role !== "admin")) throw new HttpError(404, "Instance not found");
  if (!["launching", "running"].includes(row.status)) throw new HttpError(409, "Instance is not running");
  if (row.backup_state === "none") throw new HttpError(409, "This machine has no backup agent (yet).", "no_agent");
  await env.DB.prepare("UPDATE instances SET backup_requested = 1 WHERE id = ?").bind(id).run();
  return { ok: true, id, requested: true, heartbeat_seconds: HEARTBEAT_SECONDS };
}

/** Delete every object under a member's prefix and zero their usage. Running agents will re-init the repo on their next backup. */
export async function wipeBackups(env: Env, userId: string): Promise<{ deleted_objects: number; freed_bytes: number }> {
  const prefix = `restic/${userId}/`;
  const before = await usedBytes(env, userId);
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BACKUPS.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await env.BACKUPS.delete(page.objects.map((o) => o.key));
    deleted += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM backup_objects WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM backups WHERE user_id = ?").bind(userId),
    env.DB.prepare("INSERT INTO backup_usage (user_id, used_bytes, updated_at) VALUES (?, 0, ?) ON CONFLICT(user_id) DO UPDATE SET used_bytes = 0, updated_at = excluded.updated_at").bind(userId, new Date().toISOString()),
  ]);
  await audit(env.DB, userId, "backup.wipe", { deleted, freed_bytes: before });
  return { deleted_objects: deleted, freed_bytes: before };
}

export async function adminBackups(env: Env) {
  const def = await defaultQuota(env);
  const rows = await env.DB.prepare(
    `SELECT u.id AS user_id, u.email, u.backup_quota_bytes AS quota_override, COALESCE(b.used_bytes, 0) AS used_bytes,
       (SELECT MAX(created_at) FROM backups WHERE user_id = u.id) AS last_backup_at,
       (SELECT COUNT(*) FROM backups WHERE user_id = u.id) AS snapshot_count
     FROM users u LEFT JOIN backup_usage b ON b.user_id = u.id ORDER BY used_bytes DESC, u.email`,
  ).all<{ user_id: string; email: string; quota_override: number | null; used_bytes: number; last_backup_at: string | null; snapshot_count: number }>();
  const members = (rows.results ?? []).map((r) => ({
    user_id: r.user_id,
    email: r.email,
    used_bytes: Math.max(0, r.used_bytes),
    quota_bytes: r.quota_override ?? def,
    quota_override: r.quota_override,
    est_monthly_cents: estMonthlyCents(Math.max(0, r.used_bytes)),
    last_backup_at: r.last_backup_at,
    snapshot_count: r.snapshot_count,
  }));
  const total = members.reduce((a, m) => a + m.used_bytes, 0);
  return {
    enabled: await backupsEnabled(env),
    default_quota_bytes: def,
    price_cents_per_gb_month: PRICE_CENTS_PER_GB_MONTH,
    total_used_bytes: total,
    total_est_monthly_cents: estMonthlyCents(total),
    members,
  };
}

/** PATCH /api/admin/users/:id/backup-quota {quota_bytes: number | null}. null = back to the lab default. */
export async function setUserQuota(env: Env, adminId: string, userId: string, body: Record<string, unknown>) {
  if (!(await getUserById(env.DB, userId))) throw new HttpError(404, "User not found");
  const raw = body.quota_bytes;
  if (raw !== null && !(typeof raw === "number" && Number.isFinite(raw) && raw >= 0)) throw new HttpError(400, "quota_bytes must be a number of bytes or null");
  const q = raw === null ? null : Math.floor(raw as number);
  await env.DB.prepare("UPDATE users SET backup_quota_bytes = ? WHERE id = ?").bind(q, userId).run();
  await audit(env.DB, adminId, "backup.quota", { userId, quota_bytes: q });
  return { user_id: userId, quota_bytes: q ?? (await defaultQuota(env)), quota_override: q };
}

/** Lab settings handled next to members_see_team_spend in /api/admin/settings. */
export async function patchBackupSettings(env: Env, adminId: string, body: Record<string, unknown>) {
  if (typeof body.backups_enabled === "boolean") {
    await setSetting(env, "backups_enabled", body.backups_enabled ? "1" : "0");
    await audit(env.DB, adminId, "settings.backups_enabled", { value: body.backups_enabled });
  }
  if (body.backup_default_quota_bytes !== undefined) {
    const v = Number(body.backup_default_quota_bytes);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, "backup_default_quota_bytes must be a number of bytes");
    await setSetting(env, "backup_default_quota_bytes", String(Math.floor(v)));
    await audit(env.DB, adminId, "settings.backup_default_quota_bytes", { value: Math.floor(v) });
  }
}

export async function backupSettings(env: Env) {
  return { backups_enabled: await backupsEnabled(env), backup_default_quota_bytes: await defaultQuota(env) };
}

/** MOCK_MASSED only: push a timestamp into the past so tests can exercise expiry / stale-heartbeat paths. */
export async function devBackdate(env: Env, body: Record<string, unknown>) {
  const id = String(body.instance_id ?? "");
  const secs = Math.max(0, Number(body.seconds) || 0);
  const iso = new Date(Date.now() - secs * 1000).toISOString();
  if (body.what === "enrollment") {
    await env.DB.prepare("UPDATE backup_enrollments SET expires_at = ? WHERE instance_id = ?").bind(Math.floor(Date.now() / 1000) - 1, id).run();
  } else if (body.what === "heartbeat") {
    await env.DB.prepare("UPDATE instances SET last_heartbeat_at = ? WHERE id = ?").bind(iso, id).run();
  } else if (body.what === "drain") {
    await env.DB.prepare("UPDATE instances SET drain_started_at = ? WHERE id = ?").bind(iso, id).run();
  } else throw new HttpError(400, "what: enrollment | heartbeat | drain");
  return { ok: true };
}
