import { getSetting, labConnection, setSetting } from "./lab";
import { listMcpTools } from "./massed_oauth";

/**
 * Massed's MCP write tools have no published argument schemas, and we send REST-style names. So we read the
 * real `inputSchema` of each write tool with the lab token, remember which property each of our arguments maps
 * to (renaming when they merely differ in case, underscores or a known alias), and refuse to launch when
 * something we send does not exist or something required is missing. Launching is blocked only on a positive
 * mismatch; if tools/list itself is unreachable the result is "unknown" and we do not block.
 */

/** `optional`: a missing property does not block launches, the caller just leaves the argument out. */
type ArgSpec = { name: string; array?: boolean; aliases?: string[]; optional?: boolean };

const UUIDS: ArgSpec = { name: "instanceUuids", array: true, aliases: ["instanceUuid", "uuids", "uuid", "instanceIds", "instance_uuids"] };
export const EXPECTED: Record<string, ArgSpec[]> = {
  instances_launch: [
    { name: "productName", aliases: ["product", "gpuProduct", "sku"] },
    { name: "regionName", aliases: ["region"] },
    { name: "instanceName", aliases: ["name"] },
    { name: "imageId", aliases: ["image", "vmImageId"] },
    { name: "sshKeys", array: true, aliases: ["sshPublicKeys", "publicKeys", "ssh_public_keys"] },
    // Startup script (backup agent bootstrap). Optional: without it the VM simply runs without backups.
    { name: "command", aliases: ["startupCommand", "startup_command", "commandStartup", "command_startup", "userData", "script"], optional: true },
  ],
  instances_terminate: [UUIDS],
  instances_restart: [UUIDS],
};

type PropSchema = { type?: string | string[] };
type ToolDef = { name: string; inputSchema?: { properties?: Record<string, PropSchema>; required?: string[] } };

export type ToolCheck = {
  present: boolean;
  /** our argument name -> the property Massed actually calls it */
  mapping: Record<string, string>;
  missing: string[];
  type_mismatch: string[];
  required_unsent: string[];
};

export type SchemaCheck = {
  checked_at: string;
  lab_user_id: string;
  /** true = safe to send, false = known mismatch (launch blocked), null = could not read the schema */
  ok: boolean | null;
  problems: string[];
  tools: Record<string, ToolCheck>;
  error?: string;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const typeOf = (p: PropSchema | undefined) => (Array.isArray(p?.type) ? p!.type[0] : p?.type);

export function evaluateSchema(tools: ToolDef[]): { ok: boolean; problems: string[]; tools: Record<string, ToolCheck> } {
  const problems: string[] = [];
  const out: Record<string, ToolCheck> = {};
  for (const [toolName, specs] of Object.entries(EXPECTED)) {
    const tool = tools.find((t) => t.name === toolName);
    const check: ToolCheck = { present: !!tool, mapping: {}, missing: [], type_mismatch: [], required_unsent: [] };
    out[toolName] = check;
    if (!tool) {
      problems.push(`${toolName}: tool not offered`);
      continue;
    }
    const props = tool.inputSchema?.properties ?? {};
    const names = Object.keys(props);
    for (const spec of specs) {
      const hit =
        names.find((n) => n === spec.name) ??
        names.find((n) => norm(n) === norm(spec.name)) ??
        names.find((n) => (spec.aliases ?? []).some((a) => norm(a) === norm(n)));
      if (!hit) {
        if (!spec.optional) check.missing.push(spec.name);
        continue;
      }
      check.mapping[spec.name] = hit;
      const t = typeOf(props[hit]);
      if (t && ((spec.array && t !== "array") || (!spec.array && t === "array"))) check.type_mismatch.push(`${spec.name}→${hit} is ${t}`);
    }
    const sent = new Set(Object.values(check.mapping));
    check.required_unsent = (tool.inputSchema?.required ?? []).filter((r) => !sent.has(r));
    if (check.missing.length) problems.push(`${toolName}: no property for ${check.missing.join(", ")} (schema has ${names.join(", ") || "none"})`);
    if (check.type_mismatch.length) problems.push(`${toolName}: ${check.type_mismatch.join(", ")}`);
    if (check.required_unsent.length) problems.push(`${toolName}: requires ${check.required_unsent.join(", ")} which we do not send`);
  }
  return { ok: problems.length === 0, problems, tools: out };
}

const KEY = "tool_schema";
let memo: { at: number; value: SchemaCheck | null } | null = null;

function parse(raw: string | null): SchemaCheck | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SchemaCheck;
  } catch {
    return null;
  }
}

/** Last stored result (D1, with a 60s in-memory copy). Never touches the network. */
export async function storedSchema(env: Env): Promise<SchemaCheck | null> {
  if (memo && Date.now() - memo.at < 60_000) return memo.value;
  const value = parse(await getSetting(env, KEY));
  memo = { at: Date.now(), value };
  return value;
}

/**
 * Read tools/list with the lab token and store the verdict. Skips when there is no active OAuth connection
 * (the REST fallback does not use MCP arguments). `maxAgeMs` makes it a cheap cached call.
 */
export async function ensureSchema(env: Env, opts: { maxAgeMs?: number; force?: boolean } = {}): Promise<SchemaCheck | null> {
  const conn = await labConnection(env);
  if (!conn || conn.status !== "active") return null;
  const prev = parse(await getSetting(env, KEY));
  const fresh = prev && prev.lab_user_id === conn.userId && Date.now() - Date.parse(prev.checked_at) < (opts.maxAgeMs ?? 0);
  if (!opts.force && fresh) return prev;

  let result: SchemaCheck;
  try {
    const tools = (await listMcpTools(env, conn.userId)) as ToolDef[];
    const ev = evaluateSchema(tools);
    result = { checked_at: new Date().toISOString(), lab_user_id: conn.userId, ok: ev.ok, problems: ev.problems, tools: ev.tools };
  } catch (e) {
    // Could not read it. Keep the last verdict if we have one, otherwise report unknown.
    const error = e instanceof Error ? e.message.slice(0, 200) : "tools/list failed";
    result = prev && prev.lab_user_id === conn.userId
      ? { ...prev, error }
      : { checked_at: new Date().toISOString(), lab_user_id: conn.userId, ok: null, problems: [], tools: {}, error };
  }
  await setSetting(env, KEY, JSON.stringify(result));
  memo = { at: Date.now(), value: result };
  return result;
}

/** Rename our arguments to the property names Massed actually uses. No-op without a stored mapping. */
export async function mapToolArgs(env: Env, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mapping = (await storedSchema(env))?.tools?.[tool]?.mapping;
  if (!mapping) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[mapping[k] ?? k] = v;
  return out;
}

/** True when Massed's launch tool accepts a startup `command` (or we cannot tell: unknown is not a block). */
export async function launchAcceptsCommand(env: Env): Promise<boolean> {
  const s = await storedSchema(env);
  const tool = s?.tools?.instances_launch;
  if (!s || s.ok === null || !tool) return true;
  return !!tool.mapping.command;
}
