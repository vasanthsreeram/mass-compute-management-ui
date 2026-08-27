import type { PublicUser } from "./db";
import type { GpuSku } from "./massed";
import { listInventory } from "./massed";
import { filterInventory, HttpError } from "./policy";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

export type MatchPick = {
  sku: GpuSku;
  reason: string;
  inStock: boolean;
};

export type MatchResult = {
  query: string;
  model: string;
  pick: MatchPick | null;
  alternatives: MatchPick[];
};

type AiRun = {
  run: (model: string, input: Record<string, unknown>) => Promise<{ response?: string } | string>;
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}/hr`;
}

function wantsGpu(query: string): boolean {
  return /gpu|vram|cuda|h100|a100|a6000|a5000|l40|l4\b|rtx|llama|qwen|mistral|sdxl|flux|whisper|train|fine-?tun|inferenc|diffusion|comfy|ollama/i.test(
    query,
  );
}

function vramHintGb(query: string): number | null {
  const m = query.match(/(\d+)\s*gb(?:\s*vram)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 8 && n <= 192 ? n : null;
}

function isCpuSku(s: GpuSku): boolean {
  return /^cpu_/i.test(s.productName) || /\bepyc\b|\bcpu\b/i.test(s.description) && !/gpu|rtx|a100|h100|l40|a30|a6000/i.test(s.description);
}

function vramFromSku(s: GpuSku): number | null {
  const m = `${s.productName} ${s.description}`.match(/(\d+)\s*gb/i);
  return m ? Number(m[1]) : null;
}

function constrain(skus: GpuSku[], query: string): GpuSku[] {
  let out = skus;
  if (wantsGpu(query)) out = out.filter((s) => !isCpuSku(s));
  const vram = vramHintGb(query);
  if (vram) {
    const withVram = out.filter((s) => {
      const g = vramFromSku(s);
      return g == null || g >= vram;
    });
    if (withVram.length) out = withVram;
  }
  return out.length ? out : skus;
}

function cheapest(skus: GpuSku[]): GpuSku | undefined {
  const stock = skus.filter((s) => s.capacity > 0).sort((a, b) => a.priceCentsPerHour - b.priceCentsPerHour);
  return stock[0] ?? [...skus].sort((a, b) => a.priceCentsPerHour - b.priceCentsPerHour)[0];
}

function compact(skus: GpuSku[]): string {
  const inStock = skus.filter((s) => s.capacity > 0).sort((a, b) => a.priceCentsPerHour - b.priceCentsPerHour);
  const rest = skus.filter((s) => s.capacity <= 0).sort((a, b) => a.priceCentsPerHour - b.priceCentsPerHour);
  const lines = [...inStock, ...rest.slice(0, 15)].map(
    (s) =>
      `${s.productName} | ${s.description} | ${money(s.priceCentsPerHour)} | ${s.vcpu} vCPU | ${s.ramGib} GiB RAM | ${s.storageGb} GB disk | stock ${s.capacity}`,
  );
  return lines.join("\n");
}

function skuInText(text: string, skus: GpuSku[]): GpuSku | undefined {
  const lower = text.toLowerCase();
  const hits = skus.filter((s) => lower.includes(s.productName.toLowerCase()));
  if (!hits.length) return undefined;
  return hits.sort((a, b) => a.priceCentsPerHour - b.priceCentsPerHour)[0];
}

function parseJson(text: string): { productName?: string; reason?: string; alternatives?: unknown } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(text.slice(start, end + 1)) as { productName?: string; reason?: string; alternatives?: unknown };
  } catch {
    return {};
  }
}

function lookup(skus: GpuSku[], name: string | undefined): GpuSku | undefined {
  if (!name) return undefined;
  const want = name.trim().toLowerCase();
  return skus.find((s) => s.productName.toLowerCase() === want)
    ?? skus.find((s) => s.productName.toLowerCase().includes(want) || s.description.toLowerCase().includes(want));
}

function asPick(sku: GpuSku, reason: string): MatchPick {
  return { sku, reason, inStock: sku.capacity > 0 };
}

export async function recommendSetup(env: Env, user: PublicUser, queryRaw: string): Promise<MatchResult> {
  const query = queryRaw.trim().slice(0, 2000);
  if (query.length < 3) throw new HttpError(400, "Describe the task in a bit more detail");

  const allSkus = await listInventory(env);
  const allowed = filterInventory(user, allSkus);
  if (!allowed.length) throw new HttpError(403, "No GPUs on your allowlist");
  const skus = constrain(allowed, query);

  const catalog = compact(skus);
  const ai = (env as Env & { AI?: AiRun }).AI;
  if (!ai?.run) throw new HttpError(503, "Workers AI is not bound");

  const system = `You pick the cheapest Massed Compute SKU that can do the user's job.
Rules:
- Only use productName values from the catalog.
- Prefer in-stock (stock > 0). If none in stock fit, pick the cheapest fit and say it is out of stock.
- Cheapest that actually fits beats a fancier GPU.
- CPU SKUs are ok only if the user does not need a GPU.
- Reply with JSON only, no markdown:
{"productName":"gpu_1x_…","reason":"one or two sentences","alternatives":["sku","sku"]}`;

  const userMsg = `Task:\n${query}\n\nCatalog:\n${catalog}`;

  let raw = "";
  try {
    const out = await ai.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      temperature: 0.2,
      max_tokens: 400,
    });
    raw = typeof out === "string" ? out : String(out?.response ?? "");
  } catch (e) {
    throw new HttpError(502, e instanceof Error ? `Workers AI: ${e.message}` : "Workers AI failed");
  }

  const parsed = parseJson(raw);
  const primary = lookup(skus, parsed.productName) ?? skuInText(raw, skus);
  const altNames = Array.isArray(parsed.alternatives) ? parsed.alternatives.map(String) : [];
  const alts = altNames
    .map((n) => lookup(skus, n))
    .filter((s): s is GpuSku => !!s && s.productName !== primary?.productName);

  let pick: MatchPick | null = primary
    ? asPick(primary, parsed.reason || "Cheapest catalog match for that task.")
    : null;

  if (!pick) {
    const fallback = cheapest(skus);
    if (fallback) pick = asPick(fallback, "Cheapest in-stock SKU that fits those constraints.");
  }

  const alternatives = alts.slice(0, 3).map((s) => asPick(s, "Also considered."));
  return { query, model: MODEL, pick, alternatives };
}
