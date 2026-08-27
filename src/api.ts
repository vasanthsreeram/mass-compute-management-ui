import { createApiKey, createSession, destroySession, loginUser, publicUser, registerUser, requireAdmin, requireAuth, sessionCookie, clearSessionCookie } from "./auth";
import { audit, getUserById, publicUser as toPublic, type UserRow } from "./db";
import { handleLaunch, handleListInstances, handleRestart, handleTerminate, instanceDetail } from "./instances";
import { getAccountSnapshot, getBilling, listImages, listInventory, listRunningInstances } from "./massed";
import { HttpError, filterInventory, parseGpus } from "./policy";
import { handleMcp } from "./mcp";
import { tickMeter } from "./meter";

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = await request.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function adminCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }

  try {
    if (path === "/health") {
      return json({ ok: true, mock: env.MOCK_MASSED === "1" || !env.MASSED_COMPUTE_API_KEY });
    }

    if (path === "/skill/gpu-proxy/SKILL.md" && method === "GET") {
      const asset = await env.ASSETS.fetch(new URL("/skill.md", request.url));
      return new Response(asset.body, {
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    if (path === "/api/meta" && method === "GET") {
      return json({
        mock: env.MOCK_MASSED === "1" || !env.MASSED_COMPUTE_API_KEY,
      });
    }

    if (path === "/api/auth/register" && method === "POST") {
      const body = await readJson(request);
      const user = await registerUser(env, String(body.email ?? ""), String(body.password ?? ""));
      const token = await createSession(env, user.id);
      return json(
        { user: publicUser(user) },
        { headers: { "Set-Cookie": sessionCookie(token, request) } },
      );
    }

    if (path === "/api/auth/login" && method === "POST") {
      const body = await readJson(request);
      const user = await loginUser(env, String(body.email ?? ""), String(body.password ?? ""));
      const token = await createSession(env, user.id);
      return json(
        { user: publicUser(user) },
        { headers: { "Set-Cookie": sessionCookie(token, request) } },
      );
    }

    if (path === "/api/auth/logout" && method === "POST") {
      await destroySession(env, request);
      return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie(request) } });
    }

    if (path === "/mcp") {
      const auth = await requireAuth(env, request);
      return handleMcp(env, request, auth);
    }

    if (path === "/api/me" && method === "GET") {
      const auth = await requireAuth(env, request);
      const massed = auth.user.role === "admin" ? await getAccountSnapshot(env) : null;
      return json({ user: auth.public, via: auth.via, massed });
    }

    if (path === "/api/inventory" && method === "GET") {
      const auth = await requireAuth(env, request);
      const [skus, images] = await Promise.all([listInventory(env), listImages(env)]);
      return json({ gpus: filterInventory(auth.public, skus), images });
    }

    if (path === "/api/instances" && method === "GET") {
      const auth = await requireAuth(env, request);
      return json({ instances: await handleListInstances(env, auth.user.id) });
    }

    if (path === "/api/instances" && method === "POST") {
      const auth = await requireAuth(env, request);
      const body = await readJson(request);
      const inst = await handleLaunch(env, auth, {
        productName: String(body.productName ?? ""),
        instanceName: body.instanceName ? String(body.instanceName) : undefined,
        imageId: typeof body.imageId === "number" ? body.imageId : undefined,
        regionName: body.regionName ? String(body.regionName) : undefined,
        sshPublicKey: body.sshPublicKey ? String(body.sshPublicKey) : undefined,
      });
      return json({ instance: inst }, { status: 201 });
    }

    const instMatch = path.match(/^\/api\/instances\/([^/]+)(?:\/(restart|terminate))?$/);
    if (instMatch && method === "GET" && !instMatch[2]) {
      const auth = await requireAuth(env, request);
      return json({ instance: await instanceDetail(env, auth, instMatch[1]) });
    }
    if (instMatch?.[2] === "restart" && method === "POST") {
      const auth = await requireAuth(env, request);
      return json(await handleRestart(env, auth, instMatch[1]));
    }
    if (instMatch?.[2] === "terminate" && method === "POST") {
      const auth = await requireAuth(env, request);
      return json(await handleTerminate(env, auth, instMatch[1]));
    }

    if (path === "/api/usage" && method === "GET") {
      const auth = await requireAuth(env, request);
      return json(await usageReport(env, auth.user.id));
    }

    if (path === "/api/keys" && method === "GET") {
      const auth = await requireAuth(env, request);
      const rows = await env.DB.prepare(
        "SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
      )
        .bind(auth.user.id)
        .all();
      return json({ keys: rows.results ?? [] });
    }

    if (path === "/api/keys" && method === "POST") {
      const auth = await requireAuth(env, request);
      const body = await readJson(request);
      const created = await createApiKey(env, auth.user.id, String(body.name ?? "agent"));
      return json({ key: created }, { status: 201 });
    }

    const keyDel = path.match(/^\/api\/keys\/([^/]+)$/);
    if (keyDel && method === "DELETE") {
      const auth = await requireAuth(env, request);
      await env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").bind(keyDel[1], auth.user.id).run();
      await audit(env.DB, auth.user.id, "api_key.revoke", { id: keyDel[1] });
      return json({ ok: true });
    }

    if (path === "/api/admin/catalog" && method === "GET") {
      await requireAdmin(env, request);
      const [gpus, images] = await Promise.all([listInventory(env), listImages(env)]);
      return json({ gpus, images });
    }

    if (path === "/api/admin/users" && method === "GET") {
      const auth = await requireAdmin(env, request);
      const rows = await env.DB.prepare(
        `SELECT u.*,
          (SELECT COUNT(*) FROM instances i WHERE i.user_id = u.id AND i.status IN ('launching','running')) AS running,
          (SELECT COUNT(*) FROM instances i WHERE i.user_id = u.id) AS vm_count
         FROM users u ORDER BY u.created_at DESC`,
      ).all<UserRow & { running: number; vm_count: number }>();
      const users = (rows.results ?? []).map((r) => ({
        ...toPublic(r),
        running: r.running,
        vm_count: r.vm_count,
      }));
      return json({ users });
    }

    const adminUser = path.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (adminUser && method === "GET") {
      await requireAdmin(env, request);
      return json(await adminUserDetail(env, adminUser[1]));
    }

    if (adminUser && method === "PATCH") {
      const auth = await requireAdmin(env, request);
      const body = await readJson(request);
      return json(await adminPatchUser(env, auth.user.id, adminUser[1], body));
    }

    if (path === "/api/admin/usage" && method === "GET") {
      await requireAdmin(env, request);
      const [report, massed] = await Promise.all([usageReport(env, null), getAccountSnapshot(env)]);
      return json({ ...report, massed });
    }

    if (path === "/api/admin/fleet" && method === "GET") {
      await requireAdmin(env, request);
      const rows = await env.DB.prepare(
        `SELECT i.id, i.user_id, u.email, i.name, i.product_name, i.status, i.ip,
                i.price_cents_per_hour, i.launched_at, i.terminated_at, i.last_metered_at
         FROM instances i JOIN users u ON u.id = i.user_id
         ORDER BY i.launched_at DESC LIMIT 200`,
      ).all();
      return json({ instances: rows.results ?? [] });
    }

    if (path === "/api/admin/upstream" && method === "GET") {
      await requireAdmin(env, request);
      const [instances, billing] = await Promise.all([listRunningInstances(env), getBilling(env)]);
      return json({ instances, billing });
    }

    if (path === "/api/admin/meter" && method === "POST") {
      await requireAdmin(env, request);
      const result = await tickMeter(env);
      return json(result);
    }

    if (path.startsWith("/api/")) return err(404, "Not found");

    if (path === "/" || path === "/index.html") {
      return env.ASSETS.fetch(request);
    }
    return env.ASSETS.fetch(request);
  } catch (e) {
    const status = typeof (e as { status?: number }).status === "number" ? (e as { status: number }).status : 400;
    const message = e instanceof Error ? e.message : "Error";
    if (status >= 500) {
      console.error(JSON.stringify({ message: "handler error", error: message, path }));
      return err(500, "Internal error");
    }
    return err(status, message);
  }
}

async function adminUserDetail(env: Env, userId: string) {
  const user = await getUserById(env.DB, userId);
  if (!user) throw new HttpError(404, "User not found");
  const instances = await env.DB.prepare(
    `SELECT id, name, product_name, status, ip, price_cents_per_hour, launched_at, terminated_at, last_metered_at
     FROM instances WHERE user_id = ? ORDER BY launched_at DESC`,
  )
    .bind(userId)
    .all();
  const usage = await env.DB.prepare(
    `SELECT u.id, u.instance_id, u.cents, u.hours, u.created_at, i.name AS instance_name, i.product_name
     FROM usage_events u LEFT JOIN instances i ON i.id = u.instance_id
     WHERE u.user_id = ? ORDER BY u.created_at DESC LIMIT 200`,
  )
    .bind(userId)
    .all();
  const keys = await env.DB.prepare(
    "SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
  )
    .bind(userId)
    .all();
  return {
    user: toPublic(user),
    instances: instances.results ?? [],
    usage: usage.results ?? [],
    keys: keys.results ?? [],
  };
}

async function adminPatchUser(
  env: Env,
  adminId: string,
  userId: string,
  body: Record<string, unknown>,
) {
  const user = await getUserById(env.DB, userId);
  if (!user) throw new HttpError(404, "User not found");

  let role = user.role;
  if (body.role === "admin" || body.role === "user") {
    if (body.role === "user" && user.role === "admin") {
      if (user.id === adminId) throw new HttpError(400, "You cannot demote yourself");
      const n = await adminCount(env);
      if (n <= 1) throw new HttpError(400, "Cannot remove the last admin");
    }
    role = body.role;
  }

  const credit =
    typeof body.credit_cents === "number" && Number.isFinite(body.credit_cents)
      ? Math.max(0, Math.floor(body.credit_cents))
      : user.credit_cents;
  const maxConcurrent =
    typeof body.max_concurrent === "number" && Number.isFinite(body.max_concurrent)
      ? Math.max(0, Math.min(32, Math.floor(body.max_concurrent)))
      : user.max_concurrent;
  let allowed = user.allowed_gpus;
  if (Array.isArray(body.allowed_gpus)) {
    allowed = JSON.stringify(body.allowed_gpus.map(String));
  } else if (typeof body.allowed_gpus === "string") {
    allowed = JSON.stringify(parseGpus(body.allowed_gpus).length ? parseGpus(body.allowed_gpus) : body.allowed_gpus.split(",").map((s) => s.trim()).filter(Boolean));
  }

  await env.DB.prepare(
    "UPDATE users SET role = ?, credit_cents = ?, max_concurrent = ?, allowed_gpus = ? WHERE id = ?",
  )
    .bind(role, credit, maxConcurrent, allowed, userId)
    .run();
  await audit(env.DB, adminId, "admin.user.patch", { userId, role, credit, maxConcurrent, allowed });
  const next = await getUserById(env.DB, userId);
  if (!next) throw new HttpError(404, "User not found");
  return { user: toPublic(next) };
}

type UsageEvent = {
  id: string;
  instance_id: string;
  cents: number;
  hours: number;
  created_at: string;
  instance_name: string | null;
  product_name: string | null;
  email?: string;
};

async function usageReport(env: Env, userId: string | null) {
  const sql = userId
    ? `SELECT u.id, u.instance_id, u.cents, u.hours, u.created_at, i.name AS instance_name, i.product_name
       FROM usage_events u LEFT JOIN instances i ON i.id = u.instance_id
       WHERE u.user_id = ? ORDER BY u.created_at DESC LIMIT 500`
    : `SELECT u.id, u.instance_id, u.cents, u.hours, u.created_at, i.name AS instance_name, i.product_name, usr.email
       FROM usage_events u
       LEFT JOIN instances i ON i.id = u.instance_id
       JOIN users usr ON usr.id = u.user_id
       ORDER BY u.created_at DESC LIMIT 500`;
  const stmt = userId ? env.DB.prepare(sql).bind(userId) : env.DB.prepare(sql);
  const rows = await stmt.all<UsageEvent>();
  const events = rows.results ?? [];
  const spent_cents = events.reduce((n, e) => n + Number(e.cents || 0), 0);
  const hours = events.reduce((n, e) => n + Number(e.hours || 0), 0);
  const bySku = new Map<string, { product_name: string; cents: number; hours: number }>();
  const byUser = new Map<string, { email: string; cents: number; hours: number }>();
  for (const e of events) {
    const sku = e.product_name || "unknown";
    const s = bySku.get(sku) ?? { product_name: sku, cents: 0, hours: 0 };
    s.cents += Number(e.cents || 0);
    s.hours += Number(e.hours || 0);
    bySku.set(sku, s);
    if (e.email) {
      const u = byUser.get(e.email) ?? { email: e.email, cents: 0, hours: 0 };
      u.cents += Number(e.cents || 0);
      u.hours += Number(e.hours || 0);
      byUser.set(e.email, u);
    }
  }
  return {
    events,
    summary: {
      spent_cents,
      hours,
      event_count: events.length,
      by_sku: [...bySku.values()].sort((a, b) => b.cents - a.cents),
      by_user: [...byUser.values()].sort((a, b) => b.cents - a.cents),
    },
  };
}

function cors(_request: Request): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  };
}

export { tickMeter };
