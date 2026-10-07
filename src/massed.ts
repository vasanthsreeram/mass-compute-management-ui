import { MASSED_BASE, massedOrigin, USER_AGENT } from "./config";
import { labConnection } from "./lab";
import { massedTool } from "./massed_oauth";
import { ensureSchema, mapToolArgs } from "./schema";
import { HttpError } from "./policy";

export { MASSED_BASE };

export type GpuSku = {
  productName: string;
  description: string;
  priceCentsPerHour: number;
  vcpu: number;
  ramGib: number;
  storageGb: number;
  capacity: number;
  regions: string[];
};

export type MassedImage = {
  vm_image_id: number;
  vm_image_name: string;
  vm_image_description: string;
};

export type LaunchInput = {
  imageId?: number;
  productName: string;
  regionName: string;
  instanceName: string;
  command?: string;
  sshKeys?: string[];
};

const MOCK_SKUS: GpuSku[] = [
  {
    productName: "gpu_1x_a6000",
    description: "1x RTX A6000",
    priceCentsPerHour: 63,
    vcpu: 6,
    ramGib: 48,
    storageGb: 256,
    capacity: 4,
    regions: ["us-central-3"],
  },
  {
    productName: "gpu_1x_l40",
    description: "1x L40",
    priceCentsPerHour: 99,
    vcpu: 26,
    ramGib: 128,
    storageGb: 625,
    capacity: 2,
    regions: ["us-central-3"],
  },
  {
    productName: "gpu_1x_h100_sxm5",
    description: "1x H100 SXM5",
    priceCentsPerHour: 249,
    vcpu: 26,
    ramGib: 200,
    storageGb: 1250,
    capacity: 1,
    regions: ["us-central-3"],
  },
];

const MOCK_IMAGES: MassedImage[] = [
  { vm_image_id: 104, vm_image_name: "Ubuntu 22.04 CUDA", vm_image_description: "Ubuntu 22.04 with NVIDIA drivers + CUDA" },
  { vm_image_id: 7, vm_image_name: "Art", vm_image_description: "Creative / diffusion stack" },
];

type CacheBox<T> = { at: number; value: T };
const cache = new Map<string, CacheBox<unknown>>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheBox<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function isMock(env: Env): boolean {
  return env.MOCK_MASSED === "1";
}

/**
 * How we reach Massed right now.
 *  - oauth: the lab admin's OAuth grant, over MCP (the only thing OAuth tokens are accepted on)
 *  - rest:  MASSED_COMPUTE_API_KEY on /api/v1, kept for single-operator deployments and as a fallback
 *  - mock:  MOCK_MASSED=1
 * No transport at all is an error, never a silent mock: members must not "launch" fake VMs in production.
 */
export type Transport = { kind: "mock" } | { kind: "oauth"; userId: string } | { kind: "rest" };

export async function resolveTransport(env: Env): Promise<Transport> {
  if (isMock(env)) return { kind: "mock" };
  const conn = await labConnection(env);
  if (conn?.status === "active") return { kind: "oauth", userId: conn.userId };
  if (env.MASSED_COMPUTE_API_KEY) return { kind: "rest" };
  if (conn?.status === "lost") throw new HttpError(409, "The Massed Compute connection was lost. An admin must reconnect.", "lab_lost");
  throw new HttpError(409, "No Massed Compute account is connected. An admin must connect one.", "lab_not_connected");
}

type Rest = { method?: string; path: string; body?: unknown };

async function mcFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${env.MASSED_COMPUTE_API_KEY}`);
  headers.set("User-Agent", USER_AGENT);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${massedOrigin(env)}/api/v1${path}`, { ...init, headers });
}

/** One Massed call, over MCP (oauth) or REST (api key). Both return the same JSON shapes. */
async function massedCall(env: Env, t: Transport, tool: string, args: Record<string, unknown>, rest: Rest): Promise<any> {
  if (t.kind === "oauth") return massedTool(env, t.userId, tool, await mapToolArgs(env, tool, args));
  if (t.kind === "rest") {
    const res = await mcFetch(env, rest.path, {
      method: rest.method ?? "GET",
      body: rest.body === undefined ? undefined : JSON.stringify(rest.body),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      throw new HttpError(res.status >= 500 ? 502 : 422, `Massed ${tool} ${res.status}: ${text}`);
    }
    return res.json().catch(() => ({}));
  }
  throw new HttpError(500, "massedCall on mock transport");
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractUuid(v: unknown): string | null {
  if (typeof v === "string") return UUID_RE.exec(v)?.[0] ?? null;
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  for (const k of ["response", "uuid", "instanceUuid", "instance_uuid", "instance", "runningInstance"]) {
    const hit = extractUuid(o[k]);
    if (hit) return hit;
  }
  return UUID_RE.exec(JSON.stringify(v))?.[0] ?? null;
}

export function parseInventory(payload: unknown): GpuSku[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const inventory = (root.gpu_inventory ?? root) as Record<string, unknown>;
  const out: GpuSku[] = [];
  for (const value of Object.values(inventory)) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const type = (item.instance_type ?? item.product ?? item) as Record<string, unknown>;
    const specs = (type.specs ?? {}) as Record<string, unknown>;
    const name = String(type.name ?? item.name ?? "");
    if (!name) continue;
    const priceRaw = type.price_cents_per_hour ?? type.price_hr ?? type.final_price_hr ?? 0;
    const priceNum = typeof priceRaw === "string" ? Number(priceRaw) : Number(priceRaw);
    const priceCents = priceNum > 20 ? Math.round(priceNum) : Math.round(priceNum * 100);
    const regions = Array.isArray(item.regions_with_capacity_available)
      ? (item.regions_with_capacity_available as Array<Record<string, unknown>>).map((r) => String(r.name ?? r))
      : [];
    out.push({
      productName: name,
      description: String(type.description ?? name),
      priceCentsPerHour: priceCents,
      vcpu: Number(specs.vcpu_count ?? specs.vcpus ?? type.vcpu ?? 0),
      ramGib: Number(specs.memory_gib ?? type.ram ?? 0),
      storageGb: Number(specs.storage_gb ?? type.storage ?? 0),
      capacity: Number(item.capacity_available ?? 0),
      regions,
    });
  }
  return out;
}

export async function listInventory(env: Env): Promise<GpuSku[]> {
  const t = await resolveTransport(env);
  if (t.kind === "mock") return MOCK_SKUS;
  return cached("inventory", 90_000, async () =>
    parseInventory(await massedCall(env, t, "gpu_inventory_list", {}, { path: "/gpu-inventory" })),
  );
}

export async function listImages(env: Env): Promise<MassedImage[]> {
  const t = await resolveTransport(env);
  if (t.kind === "mock") return MOCK_IMAGES;
  return cached("images", 300_000, async () => {
    const data = (await massedCall(env, t, "images_list", {}, { path: "/images" })) as { images?: MassedImage[] };
    return data.images ?? [];
  });
}

/**
 * Refuse to launch when the lab's MCP write tools do not accept the arguments we send. Checked before any
 * row is created, so a launch can never fail half-way on a renamed field. Unknown (tools/list unreachable) does not block.
 */
export async function assertWriteSchema(env: Env): Promise<void> {
  const t = await resolveTransport(env);
  if (t.kind !== "oauth") return;
  const s = await ensureSchema(env, { maxAgeMs: 30 * 60_000 });
  if (s && s.ok === false) {
    throw new HttpError(503, `Massed tool schema changed: ${s.problems.join("; ").slice(0, 400)}`, "tool_schema_changed");
  }
}

/** Whether VM passwords can be read. OAuth/MCP redacts them, so access must be by SSH key. */
export async function canReadPasswords(env: Env): Promise<boolean> {
  const t = await resolveTransport(env);
  return t.kind === "rest" || t.kind === "mock";
}

export async function launchInstance(env: Env, input: LaunchInput): Promise<{ uuid: string; mock: boolean }> {
  const t = await resolveTransport(env);
  if (t.kind === "mock") return { uuid: `mock-${crypto.randomUUID()}`, mock: true };
  const data = await massedCall(env, t, "instances_launch", { ...input }, { method: "POST", path: "/instance/launch", body: input });
  const uuid = extractUuid(data);
  if (!uuid) throw new HttpError(502, "Massed launch returned no instance uuid");
  invalidateMassed("instances");
  return { uuid, mock: false };
}

export async function restartInstances(env: Env, uuids: string[]): Promise<void> {
  const t = await resolveTransport(env);
  if (t.kind === "mock") return;
  const real = uuids.filter((u) => !u.startsWith("mock-"));
  if (!real.length) return;
  await massedCall(env, t, "instances_restart", { instanceUuids: real }, { method: "POST", path: "/instance/restart", body: { instanceUuids: real } });
  invalidateMassed("instances");
}

export async function terminateInstances(env: Env, uuids: string[]): Promise<void> {
  const t = await resolveTransport(env);
  if (t.kind === "mock") return;
  const real = uuids.filter((u) => !u.startsWith("mock-"));
  if (!real.length) return;
  await massedCall(env, t, "instances_terminate", { instanceUuids: real }, { method: "POST", path: "/instance/terminate", body: { instanceUuids: real } });
  invalidateMassed("instances");
}

export type RemoteInstance = {
  uuid: string;
  name: string;
  status: string;
  created: string | null;
  productName: string | null;
  imageName: string | null;
  priceCentsPerHour: number;
  uptimeHours: number;
  accumulatedCents: number;
  ip: string | null;
  username: string | null;
};

function dollarsToCents(raw: unknown): number {
  if (raw == null || raw === "") return 0;
  const n = typeof raw === "string" ? Number(raw) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 20 ? Math.round(n) : Math.round(n * 100);
}

function hoursSince(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t >= Date.now()) return 0;
  return (Date.now() - t) / 3_600_000;
}

export function invalidateMassed(...keys: string[]): void {
  if (!keys.length) cache.clear();
  else for (const k of keys) cache.delete(k);
}

export async function listRunningInstances(env: Env, opts: { fresh?: boolean } = {}): Promise<RemoteInstance[]> {
  const t = await resolveTransport(env);
  if (t.kind === "mock") return [];
  if (opts.fresh) invalidateMassed("instances");
  return cached("instances", 15_000, async () => {
    const data = (await massedCall(env, t, "instances_list", {}, { path: "/instance" })) as { runningInstances?: Record<string, unknown>[] };
    return (data.runningInstances ?? []).map((inst) => {
      const product = (inst.product ?? {}) as Record<string, unknown>;
      const image = (inst.image ?? {}) as Record<string, unknown>;
      const created = inst.created ? String(inst.created) : null;
      const priceCentsPerHour = dollarsToCents(product.final_price_hr) || dollarsToCents(product.price_hr);
      const uptimeHours = hoursSince(created);
      return {
        uuid: String(inst.uuid ?? ""),
        name: String(inst.name ?? ""),
        status: String(inst.status ?? ""),
        created,
        productName: product.name ? String(product.name) : null,
        imageName: image.name ? String(image.name) : null,
        priceCentsPerHour,
        uptimeHours,
        accumulatedCents: Math.round(uptimeHours * priceCentsPerHour),
        ip: inst.ip ? String(inst.ip) : null,
        username: inst.username ? String(inst.username) : null,
      };
    });
  });
}

export async function getBilling(env: Env): Promise<Record<string, unknown> | null> {
  const t = await resolveTransport(env);
  if (t.kind === "mock") return null;
  return cached("billing", 60_000, async () => {
    try {
      return (await massedCall(env, t, "account_billing", {}, { path: "/account/billing" })) as Record<string, unknown>;
    } catch {
      return null;
    }
  });
}

export type MassedBilling = {
  billingMethod: string | null;
  rechargeAmountCents: number;
  rechargeThresholdCents: number;
};

export type MassedAccount = {
  connected: boolean;
  mock: boolean;
  mode: "oauth" | "rest" | "mock" | "none";
  tokenValid: boolean;
  running: number;
  burnCentsPerHour: number;
  accumulatedCents: number;
  longRunning24h: number;
  longRunning7d: number;
  billing: MassedBilling | null;
  instances: RemoteInstance[];
  error: string | null;
};

function parseBilling(raw: Record<string, unknown> | null): MassedBilling | null {
  if (!raw) return null;
  return {
    billingMethod: raw.billingMethod ? String(raw.billingMethod) : null,
    rechargeAmountCents: Number(raw.rechargeAmountCents ?? 0) || 0,
    rechargeThresholdCents: Number(raw.rechargeThresholdCents ?? 0) || 0,
  };
}

export async function getAccountSnapshot(env: Env, opts: { fresh?: boolean } = {}): Promise<MassedAccount> {
  const empty: MassedAccount = {
    connected: false,
    mock: isMock(env),
    mode: "none",
    tokenValid: false,
    running: 0,
    burnCentsPerHour: 0,
    accumulatedCents: 0,
    longRunning24h: 0,
    longRunning7d: 0,
    billing: null,
    instances: [],
    error: null,
  };
  if (isMock(env)) return { ...empty, mock: true, mode: "mock", error: "MOCK_MASSED is on — not talking to Massed." };
  let t: Transport;
  try {
    t = await resolveTransport(env);
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : "Not connected" };
  }
  try {
    const [instances, billingRaw] = await Promise.all([listRunningInstances(env, opts), getBilling(env)]);
    const needPrice = instances.some((i) => !i.priceCentsPerHour && i.productName);
    const price = needPrice
      ? new Map((await listInventory(env)).map((s) => [s.productName, s.priceCentsPerHour]))
      : new Map<string, number>();
    const priced = instances.map((i) => {
      const rate = i.priceCentsPerHour || price.get(i.productName || "") || 0;
      return { ...i, priceCentsPerHour: rate, accumulatedCents: Math.round(i.uptimeHours * rate) };
    });
    return {
      connected: true,
      mock: false,
      mode: t.kind,
      tokenValid: true,
      running: priced.length,
      burnCentsPerHour: priced.reduce((n, i) => n + i.priceCentsPerHour, 0),
      accumulatedCents: priced.reduce((n, i) => n + i.accumulatedCents, 0),
      longRunning24h: priced.filter((i) => i.uptimeHours >= 24).length,
      longRunning7d: priced.filter((i) => i.uptimeHours >= 24 * 7).length,
      billing: parseBilling(billingRaw),
      instances: priced,
      error: null,
    };
  } catch (e) {
    return { ...empty, mode: t.kind, error: e instanceof Error ? e.message : "Massed request failed" };
  }
}

export async function validateToken(env: Env): Promise<boolean> {
  const t = await resolveTransport(env);
  if (t.kind === "mock") return false;
  try {
    await massedCall(env, t, "account_token_validation", {}, { method: "POST", path: "/account/token/validation" });
    return true;
  } catch {
    return false;
  }
}

export type RemoteDetail = { ip?: string; username?: string; password?: string; status?: string };

/** Connection details for one VM. Over OAuth/MCP the password is redacted, so it is never returned. */
export async function getRemoteInstance(env: Env, uuid: string): Promise<RemoteDetail | null> {
  const t = await resolveTransport(env);
  if (t.kind === "mock" || uuid.startsWith("mock-")) {
    return { ip: "203.0.113.10", username: "Ubuntu", password: "mock-password", status: "rented" };
  }
  if (t.kind === "oauth") {
    const vm = (await listRunningInstances(env)).find((i) => i.uuid === uuid);
    if (!vm) return null;
    return { ip: vm.ip ?? undefined, username: vm.username ?? undefined, status: vm.status || undefined };
  }
  const res = await mcFetch(env, `/instance/${uuid}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { runningInstance?: Record<string, unknown> };
  const inst = data.runningInstance;
  if (!inst) return null;
  return {
    ip: inst.ip ? String(inst.ip) : undefined,
    username: inst.username ? String(inst.username) : undefined,
    password: inst.password != null ? String(inst.password) : undefined,
    status: inst.status ? String(inst.status) : undefined,
  };
}
