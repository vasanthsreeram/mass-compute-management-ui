import type { AuthContext } from "./auth";
import { audit } from "./db";
import { encryptSecret, decryptSecret } from "./crypto";
import { meterInstance, recordVmEvent, type Actor } from "./ledger";
import {
  assertWriteSchema,
  canReadPasswords,
  getRemoteInstance,
  launchInstance,
  listImages,
  listInventory,
  listRunningInstances,
  restartInstances,
  terminateInstances,
} from "./massed";
import { bootstrapCommand, mintEnrollment, wantBackup } from "./backup";
import { heartbeatFresh, startDrain } from "./drain";
import { HttpError, assertCanLaunch } from "./policy";
import { listSshKeys, parsePublicKey } from "./sshkeys";
import type { InstanceRow } from "./db";

export type LaunchBody = {
  productName: string;
  instanceName?: string;
  imageId?: number;
  regionName?: string;
  /** One extra public key to inject, on top of the keys the member saved. */
  sshPublicKey?: string;
  /** false = no backup agent on this VM (default: on whenever the lab has backups enabled). */
  backups?: boolean;
};

function pickDefaultImage(images: { vm_image_id: number; vm_image_name: string }[]): number | undefined {
  const score = (name: string) => {
    const n = name.toLowerCase();
    let s = 0;
    if (n.includes("ubuntu")) s += 3;
    if (n.includes("cuda")) s += 3;
    if (n.includes("pytorch") || n.includes("torch")) s += 2;
    if (n.includes("22.04") || n.includes("24.04")) s += 1;
    return s;
  };
  const ranked = [...images].sort((a, b) => score(b.vm_image_name) - score(a.vm_image_name));
  return ranked[0]?.vm_image_id;
}

function activeStatuses(): string[] {
  return ["launching", "running"];
}

export function actorOf(ctx: AuthContext): Actor {
  return { userId: ctx.user.id, apiKeyId: ctx.apiKeyId ?? null, kind: ctx.via === "api_key" ? "agent" : "user" };
}

export async function runningCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM instances WHERE user_id = ? AND status IN ('launching','running')",
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const MAX_LAUNCH_KEYS = 5;

/** Saved keys first, then the inline one. Massed MCP redacts passwords, so a key is the only way in. */
async function launchKeys(env: Env, userId: string, inline?: string) {
  const keys: { key: string; fingerprint: string }[] = [];
  if (inline?.trim()) {
    const p = await parsePublicKey(inline);
    keys.push({ key: p.key, fingerprint: p.fingerprint });
  }
  for (const k of await listSshKeys(env, userId)) {
    if (!keys.some((x) => x.fingerprint === k.fingerprint)) keys.push({ key: k.public_key, fingerprint: k.fingerprint });
  }
  return keys.slice(0, MAX_LAUNCH_KEYS);
}

export async function handleLaunch(env: Env, ctx: AuthContext, body: LaunchBody, origin = env.APP_URL) {
  const actor = actorOf(ctx);
  const productName = body.productName?.trim();
  if (!productName) throw new HttpError(400, "productName required");
  const skus = await listInventory(env);
  const sku = skus.find((s) => s.productName === productName);
  if (!sku) throw new HttpError(400, `Unknown product ${productName}`);
  assertCanLaunch(ctx.user, sku, await runningCount(env, ctx.user.id));
  await assertWriteSchema(env);

  const keys = await launchKeys(env, ctx.user.id, body.sshPublicKey);
  if (!keys.length && !(await canReadPasswords(env))) {
    throw new HttpError(400, "Add an SSH public key first. This lab connects to Massed over OAuth, which does not reveal VM passwords.", "needs_ssh_key");
  }

  const images = await listImages(env);
  const imageId = body.imageId ?? pickDefaultImage(images);
  const label = (body.instanceName ?? `${productName}`).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40);
  // The rl_<user> prefix doubles as backup attribution if our D1 row is ever lost.
  const instanceName = `rl_${ctx.user.id.slice(0, 8)}_${label}`.slice(0, 60);
  const regionName = body.regionName?.trim() || "any";

  // Insert first so the launch is attributable and counts against the concurrent cap even if we crash mid-call.
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO instances (id, mc_uuid, user_id, name, product_name, region_name, price_cents_per_hour, status, image_id,
       launched_at, last_metered_at, api_key_id, ssh_fingerprints)
     VALUES (?, NULL, ?, ?, ?, ?, ?, 'launching', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, ctx.user.id, instanceName, productName, regionName, sku.priceCentsPerHour,
      imageId ?? null, now, now, actor.apiKeyId ?? null,
      keys.length ? JSON.stringify(keys.map((k) => k.fingerprint)) : null,
    )
    .run();

  // Backup bootstrap: a single-use 10 minute token in the startup command (command_startup is readable back,
  // so never a long-lived key). The VM trades it for a credential at POST /api/agent/enroll.
  let enrollToken: string | null = null;
  if (await wantBackup(env, body.backups === false)) enrollToken = await mintEnrollment(env, ctx.user.id, id);

  let launched: { uuid: string; mock: boolean };
  try {
    launched = await launchInstance(env, {
      productName,
      regionName,
      instanceName,
      imageId,
      sshKeys: keys.length ? keys.map((k) => k.key) : undefined,
      command: enrollToken ? bootstrapCommand(origin || env.APP_URL, enrollToken) : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("DELETE FROM backup_enrollments WHERE instance_id = ?").bind(id).run();
    await env.DB.prepare("UPDATE instances SET status = 'failed', terminated_at = ?, end_reason = ? WHERE id = ?")
      .bind(new Date().toISOString(), `launch failed: ${msg.slice(0, 150)}`, id)
      .run();
    await recordVmEvent(env, {
      kind: "launch_failed", instanceId: id, userId: ctx.user.id, apiKeyId: actor.apiKeyId, actor: actor.kind,
      productName, rate: sku.priceCentsPerHour, detail: { error: msg.slice(0, 300) },
    });
    const status = (e as { status?: number }).status;
    if (status === 409 || status === 503) throw e;
    throw new HttpError(422, `Massed could not start the VM: ${msg.slice(0, 200)}`, "launch_failed");
  }

  let passwordEnc: string | null = null;
  let ip: string | null = null;
  let username: string | null = null;
  let status = "launching";
  try {
    const remote = await getRemoteInstance(env, launched.uuid);
    if (remote) {
      ip = remote.ip ?? null;
      username = remote.username ?? null;
      if (remote.password) passwordEnc = await encryptSecret(String(remote.password), env.DATA_KEY);
      if (remote.status) status = remote.status === "rented" ? "running" : remote.status;
    }
  } catch {
    /* still record the launch */
  }
  if (launched.mock) {
    status = "running";
    ip = ip ?? "203.0.113.10";
    username = username ?? "Ubuntu";
    passwordEnc = passwordEnc ?? (await encryptSecret("mock-password", env.DATA_KEY));
  }
  if (status !== "launching" && status !== "running") status = "running";

  // Billing starts when Massed accepted the launch, not when the request came in.
  const startedAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE instances SET mc_uuid = ?, status = ?, ip = ?, username = ?, password_enc = ?, last_metered_at = ?, launched_at = ?
     WHERE id = ?`,
  )
    .bind(launched.uuid, status, ip, username, passwordEnc, startedAt, startedAt, id)
    .run();
  await recordVmEvent(env, {
    kind: "launch", instanceId: id, mcUuid: launched.uuid, userId: ctx.user.id, apiKeyId: actor.apiKeyId,
    actor: actor.kind, productName, rate: sku.priceCentsPerHour,
  });
  await audit(env.DB, ctx.user.id, "instance.launch", { id, productName, mc_uuid: launched.uuid, via: ctx.via });
  const detail = await instanceDetail(env, ctx, id);
  // Mock launches never run the command, so tests get the token directly. Never returned for real launches.
  return launched.mock && enrollToken ? { ...detail, dev_enroll_token: enrollToken } : detail;
}

async function loadOwned(env: Env, ctx: AuthContext, id: string): Promise<InstanceRow> {
  const row = await env.DB.prepare("SELECT * FROM instances WHERE id = ?").bind(id).first<InstanceRow>();
  if (!row) throw new HttpError(404, "Instance not found");
  if (row.user_id !== ctx.user.id && ctx.user.role !== "admin") throw new HttpError(404, "Instance not found");
  return row;
}

function parseFingerprints(raw: string | null): string[] {
  try {
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/** How to get in, without ever exposing the password: only whether one exists. */
function accessOf(row: { ip: string | null; username: string | null; has_password: number; ssh_fingerprints: string | null }) {
  const fingerprints = parseFingerprints(row.ssh_fingerprints);
  return {
    method: row.has_password ? "password" : fingerprints.length ? "ssh_key" : "none",
    ssh_command: row.ip ? `ssh ${row.username || "ubuntu"}@${row.ip}` : null,
  };
}

export async function handleListInstances(env: Env, userId: string) {
  const rows = await env.DB.prepare(
    `SELECT id, mc_uuid, name, product_name, region_name, price_cents_per_hour, status, ip, username,
            launched_at, terminated_at, last_metered_at, billed_cents, end_reason, ssh_fingerprints,
            backup_state, last_heartbeat_at, last_backup_at, drain_started_at,
            password_enc IS NOT NULL AS has_password
     FROM instances WHERE user_id = ? ORDER BY launched_at DESC`,
  )
    .bind(userId)
    .all<{ ip: string | null; username: string | null; has_password: number; ssh_fingerprints: string | null } & Record<string, unknown>>();
  return (rows.results ?? []).map(({ has_password, ssh_fingerprints, ...r }) => ({
    ...r,
    ssh_fingerprints: parseFingerprints(ssh_fingerprints),
    access: accessOf({ ip: r.ip, username: r.username, has_password, ssh_fingerprints }),
  }));
}

export async function instanceDetail(env: Env, ctx: AuthContext, id: string) {
  const row = await loadOwned(env, ctx, id);
  const showSecret = row.user_id === ctx.user.id;
  let password: string | null = null;
  if (showSecret && row.password_enc) {
    try {
      password = await decryptSecret(row.password_enc, env.DATA_KEY);
    } catch {
      password = null;
    }
  }
  let fingerprints: string[] = [];
  try {
    fingerprints = row.ssh_fingerprints ? (JSON.parse(row.ssh_fingerprints) as string[]) : [];
  } catch {
    fingerprints = [];
  }
  return {
    id: row.id,
    mc_uuid: row.mc_uuid,
    name: row.name,
    product_name: row.product_name,
    region_name: row.region_name,
    price_cents_per_hour: row.price_cents_per_hour,
    status: row.status,
    ip: row.ip,
    username: row.username,
    password: showSecret ? password : null,
    image_id: row.image_id,
    launched_at: row.launched_at,
    terminated_at: row.terminated_at,
    last_metered_at: row.last_metered_at,
    billed_cents: row.billed_cents,
    end_reason: row.end_reason,
    backup_state: row.backup_state,
    last_heartbeat_at: row.last_heartbeat_at,
    last_backup_at: row.last_backup_at,
    drain_started_at: row.drain_started_at,
    ssh_fingerprints: fingerprints,
    // How to get in: ssh key when we injected one, password only when the lab uses an API key.
    access: {
      method: password ? "password" : fingerprints.length ? "ssh_key" : "none",
      ssh_command: row.ip ? `ssh ${row.username || "ubuntu"}@${row.ip}` : null,
    },
  };
}

export async function handleRestart(env: Env, ctx: AuthContext, id: string) {
  const row = await loadOwned(env, ctx, id);
  const actor = actorOf(ctx);
  if (!activeStatuses().includes(row.status)) throw new HttpError(409, "Instance is not running");
  try {
    if (row.mc_uuid) await restartInstances(env, [row.mc_uuid]);
  } catch (e) {
    await recordVmEvent(env, {
      kind: "restart_failed", instanceId: id, mcUuid: row.mc_uuid, userId: ctx.user.id, apiKeyId: actor.apiKeyId,
      actor: actor.kind, productName: row.product_name, rate: row.price_cents_per_hour,
      detail: { error: e instanceof Error ? e.message.slice(0, 200) : "error" },
    });
    throw e;
  }
  await env.DB.prepare("UPDATE instances SET status = 'running' WHERE id = ?").bind(id).run();
  await recordVmEvent(env, {
    kind: "restart", instanceId: id, mcUuid: row.mc_uuid, userId: ctx.user.id, apiKeyId: actor.apiKeyId,
    actor: actor.kind, productName: row.product_name, rate: row.price_cents_per_hour, detail: { owner: row.user_id },
  });
  await audit(env.DB, ctx.user.id, "instance.restart", { id });
  return { ok: true, id };
}

/**
 * Terminate on Massed first. Only when Massed confirms (or the VM is verifiably already gone) do we
 * settle the final bill and mark the row terminated. A failed call leaves the row running so the
 * meter keeps charging and the next tick retries, instead of leaking an unmetered VM.
 */
export async function terminateRow(
  env: Env,
  row: InstanceRow,
  actor: Actor,
  kind: "terminate" | "budget_kill",
  reason: string,
  /** Merged into the vm_events detail, e.g. { backup_before_kill, snapshot_id, waited_s }. */
  extra: Record<string, unknown> = {},
): Promise<{ settled_cents: number }> {
  if (row.status === "terminated" || row.status === "failed") return { settled_cents: 0 };
  const meta = {
    instanceId: row.id, mcUuid: row.mc_uuid, userId: actor.userId ?? row.user_id, apiKeyId: actor.apiKeyId,
    actor: actor.kind, productName: row.product_name, rate: row.price_cents_per_hour,
  };
  if (row.mc_uuid) {
    try {
      await terminateInstances(env, [row.mc_uuid]);
    } catch (e) {
      let gone = false;
      try {
        gone = !(await listRunningInstances(env, { fresh: true })).some((i) => i.uuid === row.mc_uuid);
      } catch {
        gone = false;
      }
      if (!gone) {
        await recordVmEvent(env, { ...meta, kind: `${kind}_failed`, detail: { error: e instanceof Error ? e.message.slice(0, 200) : "error" } });
        throw e;
      }
    }
  }
  const cents = await meterInstance(env, row, Date.now(), { reason });
  // The VM is gone: its backup credential must stop working (vmAuth also requires a live instance).
  await env.DB.prepare("UPDATE vm_credentials SET revoked_at = ? WHERE instance_id = ? AND revoked_at IS NULL").bind(new Date().toISOString(), row.id).run();
  await recordVmEvent(env, { ...meta, kind, detail: { owner: row.user_id, settled_cents: cents ?? 0, reason, backup_before_kill: false, ...extra } });
  return { settled_cents: cents ?? 0 };
}

const TERMINATE_WAIT_MS = 90_000;

/**
 * Back up, then terminate. A VM with a healthy backup agent is put into `draining` (final_backup:true on its
 * next heartbeat, within ~45 s) and this request polls up to 90 s for the agent's final-done, which terminates
 * the VM. If the snapshot is not confirmed in time it returns { state: "draining" } and the agent (or the cron's
 * 10 minute deadline) finishes the job, so the request never has to outlive the Worker. `force` skips all of it.
 */
export async function handleTerminate(env: Env, ctx: AuthContext, id: string, opts: { force?: boolean } = {}) {
  let row = await loadOwned(env, ctx, id);
  if (row.status === "terminated") return { ok: true, id };
  const hasAgent = row.backup_state !== "none" && heartbeatFresh(row, Date.now());
  if (opts.force || !hasAgent) {
    const why = opts.force ? "forced" : row.backup_state === "none" ? "no backup agent" : "agent not responding";
    const { settled_cents } = await terminateRow(env, row, actorOf(ctx), "terminate", "terminated by user", { backup_before_kill: false, why });
    await audit(env.DB, ctx.user.id, "instance.terminate", { id, owner: row.user_id, via: ctx.via, backup_before_kill: false });
    return { ok: true, id, settled_cents, backup_before_kill: false, state: "terminated" };
  }
  if (row.backup_state === "ok") await startDrain(env, row, "user", { by: ctx.user.id });
  await audit(env.DB, ctx.user.id, "instance.terminate", { id, owner: row.user_id, via: ctx.via, draining: true });
  const t0 = Date.now();
  while (Date.now() - t0 < TERMINATE_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 3000));
    row = (await env.DB.prepare("SELECT * FROM instances WHERE id = ?").bind(id).first<InstanceRow>()) ?? row;
    if (row.status === "terminated") {
      return { ok: true, id, billed_cents: row.billed_cents, backup_before_kill: row.end_reason?.includes("(backed up)") ?? false, state: "terminated", waited_s: Math.round((Date.now() - t0) / 1000) };
    }
  }
  return { ok: true, id, state: "draining", backup_before_kill: null, waited_s: Math.round((Date.now() - t0) / 1000) };
}
