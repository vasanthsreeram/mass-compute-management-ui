import type { AuthContext } from "./auth";
import { handleLaunch, handleListInstances, handleRestart, handleTerminate, instanceDetail } from "./instances";
import { listImages, listInventory } from "./massed";
import { filterInventory } from "./policy";

type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };

const TOOLS = [
  {
    name: "inventory_list",
    description: "List GPUs this user is allowed to rent, with live price and stock.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "images_list",
    description: "List VM images available at launch.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "account_me",
    description: "Show remaining credit, GPU allowlist, and concurrent cap.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "instances_list",
    description: "List this user's VMs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "instances_get",
    description: "Get one VM by id, including SSH details.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "instances_launch",
    description: "Launch a GPU VM. Costs money against this user's credit.",
    inputSchema: {
      type: "object",
      properties: {
        productName: { type: "string" },
        instanceName: { type: "string" },
        imageId: { type: "number" },
        regionName: { type: "string" },
        sshPublicKey: { type: "string" },
      },
      required: ["productName"],
    },
  },
  {
    name: "instances_restart",
    description: "Restart one of this user's VMs.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "instances_terminate",
    description: "Destroy a VM. Disk is gone. Confirm with the user first.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "usage_get",
    description: "Recent usage events (when, which VM, cents).",
    inputSchema: { type: "object", properties: {} },
  },
];

function ok(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function fail(id: unknown, code: number, message: string, http = 200): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status: http });
}

function textResult(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

export async function handleMcp(env: Env, request: Request, ctx: AuthContext): Promise<Response> {
  if (request.method === "GET") {
    return new Response(null, { status: 405 });
  }
  let body: Rpc;
  try {
    body = (await request.json()) as Rpc;
  } catch {
    return fail(null, -32700, "Parse error", 400);
  }
  const id = body.id;
  const method = body.method ?? "";
  const params = body.params ?? {};

  try {
    if (method === "initialize") {
      return ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mass-compute-management-ui", version: "1.0.0" },
      });
    }
    if (method === "notifications/initialized" || method === "ping") {
      return ok(id, {});
    }
    if (method === "tools/list") {
      return ok(id, { tools: TOOLS });
    }
    if (method === "tools/call") {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(env, ctx, name, args);
      return ok(id, textResult(result));
    }
    return fail(id, -32601, `Unknown method ${method}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : 200;
    return fail(id, -32000, message, status === 401 || status === 403 ? status : 200);
  }
}

async function callTool(
  env: Env,
  ctx: AuthContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "inventory_list": {
      const skus = filterInventory(ctx.public, await listInventory(env));
      return skus;
    }
    case "images_list":
      return listImages(env);
    case "account_me":
      return ctx.public;
    case "instances_list":
      return handleListInstances(env, ctx.user.id);
    case "instances_get":
      return instanceDetail(env, ctx, String(args.id ?? ""));
    case "instances_launch":
      return handleLaunch(env, ctx, {
        productName: String(args.productName ?? ""),
        instanceName: args.instanceName ? String(args.instanceName) : undefined,
        imageId: typeof args.imageId === "number" ? args.imageId : undefined,
        regionName: args.regionName ? String(args.regionName) : "any",
        sshPublicKey: args.sshPublicKey ? String(args.sshPublicKey) : undefined,
      });
    case "instances_restart":
      return handleRestart(env, ctx, String(args.id ?? ""));
    case "instances_terminate":
      return handleTerminate(env, ctx, String(args.id ?? ""));
    case "usage_get": {
      const rows = await env.DB.prepare(
        "SELECT id, instance_id, cents, hours, created_at FROM usage_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
      )
        .bind(ctx.user.id)
        .all();
      return rows.results ?? [];
    }
    default:
      throw Object.assign(new Error(`Unknown tool ${name}`), { status: 400 });
  }
}
