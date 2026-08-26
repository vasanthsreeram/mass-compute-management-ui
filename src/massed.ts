export const MASSED_BASE = "https://vm.massedcompute.com/api/v1";

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

function mockEnabled(env: Env): boolean {
  if (env.MOCK_MASSED === "1") return true;
  return !env.MASSED_COMPUTE_API_KEY;
}

async function mcFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${env.MASSED_COMPUTE_API_KEY}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${MASSED_BASE}${path}`, { ...init, headers });
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
  if (mockEnabled(env)) return MOCK_SKUS;
  const res = await mcFetch(env, "/gpu-inventory");
  if (!res.ok) throw new Error(`massed inventory ${res.status}`);
  return parseInventory(await res.json());
}

export async function listImages(env: Env): Promise<MassedImage[]> {
  if (mockEnabled(env)) return MOCK_IMAGES;
  const res = await mcFetch(env, "/images");
  if (!res.ok) throw new Error(`massed images ${res.status}`);
  const data = (await res.json()) as { images?: MassedImage[] };
  return data.images ?? [];
}

export async function launchInstance(
  env: Env,
  input: LaunchInput,
): Promise<{ uuid: string; mock: boolean }> {
  if (mockEnabled(env)) {
    return { uuid: `mock-${crypto.randomUUID()}`, mock: true };
  }
  const res = await mcFetch(env, "/instance/launch", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`massed launch ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { response?: string };
  if (!data.response) throw new Error("massed launch missing uuid");
  return { uuid: data.response, mock: false };
}

export async function restartInstances(env: Env, uuids: string[]): Promise<void> {
  if (mockEnabled(env)) return;
  const res = await mcFetch(env, "/instance/restart", {
    method: "POST",
    body: JSON.stringify({ instanceUuids: uuids }),
  });
  if (!res.ok) throw new Error(`massed restart ${res.status}`);
}

export async function terminateInstances(env: Env, uuids: string[]): Promise<void> {
  if (mockEnabled(env)) return;
  const real = uuids.filter((u) => !u.startsWith("mock-"));
  if (!real.length) return;
  const res = await mcFetch(env, "/instance/terminate", {
    method: "POST",
    body: JSON.stringify({ instanceUuids: real }),
  });
  if (!res.ok) throw new Error(`massed terminate ${res.status}`);
}

export async function getRemoteInstance(
  env: Env,
  uuid: string,
): Promise<{ ip?: string; username?: string; password?: string; status?: string } | null> {
  if (mockEnabled(env) || uuid.startsWith("mock-")) {
    return {
      ip: "203.0.113.10",
      username: "Ubuntu",
      password: "mock-password",
      status: "rented",
    };
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
