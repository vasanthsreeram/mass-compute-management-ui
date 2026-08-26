import type { PublicUser, UserRow } from "./db";
import { publicUser } from "./db";
import type { GpuSku } from "./massed";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function parseGpus(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function gpuAllowed(user: UserRow | PublicUser, productName: string): boolean {
  const list = "allowed_gpus" in user && Array.isArray(user.allowed_gpus)
    ? user.allowed_gpus
    : parseGpus((user as UserRow).allowed_gpus);
  if (list.includes("*")) return true;
  return list.includes(productName);
}

export function filterInventory(user: UserRow | PublicUser, skus: GpuSku[]): GpuSku[] {
  return skus.filter((s) => gpuAllowed(user, s.productName));
}

export function assertCanLaunch(
  user: UserRow,
  sku: GpuSku,
  runningCount: number,
): PublicUser {
  const pub = publicUser(user);
  if (!gpuAllowed(pub, sku.productName)) {
    throw new HttpError(403, `GPU ${sku.productName} is not on your allowlist`);
  }
  if (runningCount >= user.max_concurrent) {
    throw new HttpError(403, `Concurrent VM cap reached (${user.max_concurrent})`);
  }
  if (user.credit_cents < sku.priceCentsPerHour) {
    throw new HttpError(402, "Not enough credit for one hour of this GPU");
  }
  return pub;
}
