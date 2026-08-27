import type { AuthContext } from "./auth";
import { audit } from "./db";
import { encryptSecret, decryptSecret } from "./crypto";
import { getRemoteInstance, launchInstance, listImages, listInventory, restartInstances, terminateInstances } from "./massed";
import { HttpError, assertCanLaunch } from "./policy";
import type { InstanceRow } from "./db";

export type LaunchBody = {
  productName: string;
  instanceName?: string;
  imageId?: number;
  regionName?: string;
  sshPublicKey?: string;
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

export async function runningCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM instances WHERE user_id = ? AND status IN ('launching','running')",
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function handleLaunch(env: Env, ctx: AuthContext, body: LaunchBody) {
  const productName = body.productName?.trim();
  if (!productName) throw new HttpError(400, "productName required");
  const skus = await listInventory(env);
  const sku = skus.find((s) => s.productName === productName);
  if (!sku) throw new HttpError(400, `Unknown product ${productName}`);
  assertCanLaunch(ctx.user, sku, await runningCount(env, ctx.user.id));

  const images = await listImages(env);
  const imageId = body.imageId ?? pickDefaultImage(images);
  const label = (body.instanceName ?? `${productName}`).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40);
  const instanceName = `rl_${ctx.user.id.slice(0, 8)}_${label}`.slice(0, 60);
  const regionName = body.regionName?.trim() || "any";
  const launched = await launchInstance(env, {
    productName,
    regionName,
    instanceName,
    imageId,
    sshKeys: body.sshPublicKey ? [body.sshPublicKey] : undefined,
  });

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
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

  await env.DB.prepare(
    `INSERT INTO instances (id, mc_uuid, user_id, name, product_name, region_name, price_cents_per_hour, status, ip, username, password_enc, image_id, launched_at, last_metered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      launched.uuid,
      ctx.user.id,
      instanceName,
      productName,
      regionName,
      sku.priceCentsPerHour,
      status,
      ip,
      username,
      passwordEnc,
      imageId ?? null,
      now,
      now,
    )
    .run();
  await audit(env.DB, ctx.user.id, "instance.launch", { id, productName, mc_uuid: launched.uuid });
  return instanceDetail(env, ctx, id);
}

async function loadOwned(env: Env, ctx: AuthContext, id: string): Promise<InstanceRow> {
  const row = await env.DB.prepare("SELECT * FROM instances WHERE id = ?").bind(id).first<InstanceRow>();
  if (!row) throw new HttpError(404, "Instance not found");
  if (row.user_id !== ctx.user.id && ctx.user.role !== "admin") throw new HttpError(404, "Instance not found");
  return row;
}

export async function handleListInstances(env: Env, userId: string) {
  const rows = await env.DB.prepare(
    "SELECT id, mc_uuid, name, product_name, region_name, price_cents_per_hour, status, ip, username, launched_at, terminated_at, last_metered_at FROM instances WHERE user_id = ? ORDER BY launched_at DESC",
  )
    .bind(userId)
    .all();
  return rows.results ?? [];
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
  };
}

export async function handleRestart(env: Env, ctx: AuthContext, id: string) {
  const row = await loadOwned(env, ctx, id);
  if (!activeStatuses().includes(row.status)) throw new HttpError(409, "Instance is not running");
  if (row.mc_uuid) await restartInstances(env, [row.mc_uuid]);
  await env.DB.prepare("UPDATE instances SET status = 'running' WHERE id = ?").bind(id).run();
  await audit(env.DB, ctx.user.id, "instance.restart", { id });
  return { ok: true, id };
}

export async function handleTerminate(env: Env, ctx: AuthContext, id: string) {
  const row = await loadOwned(env, ctx, id);
  if (row.status === "terminated") return { ok: true, id };
  if (row.mc_uuid) await terminateInstances(env, [row.mc_uuid]);
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE instances SET status = 'terminated', terminated_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
  await audit(env.DB, ctx.user.id, "instance.terminate", { id, owner: row.user_id });
  return { ok: true, id };
}
