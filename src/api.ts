import { createSession, finishSignup, startSignup, destroySession, loginUser, publicUser, requireAdmin, requireAuth, sessionCookie, clearSessionCookie } from "./auth";
import { audit, getUserById, publicUser as toPublic, type UserRow } from "./db";
import { deviceDecide, deviceInfo, devicePoll, deviceStart } from "./device";
import { handleLaunch, handleListInstances, handleRestart, handleTerminate, instanceDetail } from "./instances";
import { getAccountSnapshot, getBilling, isMock, listImages, listInventory, listRunningInstances } from "./massed";
import { designateLabAdmin, getSetting, labStatus, setSetting } from "./lab";
import { ensureSchema } from "./schema";
import { onboardingState, saveOnboarding } from "./onboarding";
import { addSshKey, deleteSshKey, listSshKeys } from "./sshkeys";
import {
  addBalanceEntry, attributeVm, balanceEstimate, billingHistory, burnSeries, calibrationReport, connectionHistory, usageReport, vmEventsReport,
} from "./track";
import { recommendSetup } from "./match";
import { HttpError, filterInventory, parseGpus } from "./policy";
import { handleMcp } from "./mcp";
import { connectionStatus, disconnect, finishConnect, probeConnection, startConnect } from "./massed_oauth";
import { tickMeter } from "./meter";
import { massedWatchReport } from "./watch";

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function err(status: number, message: string, code?: string): Response {
  return json(code ? { error: message, code } : { error: message }, { status });
}

/** Massed not connected / lost is a normal state, not a crash: lists come back empty and `lab` says why. */
async function orEmptyWhenOffline<T extends object>(env: Env, empty: T, fn: () => Promise<T>): Promise<T | (T & { lab: unknown })> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { status?: number }).status === 409) return { ...empty, lab: await labStatus(env, false) };
    throw e;
  }
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
      return json({ ok: true, mock: isMock(env) });
    }

    if (path === "/skill/gpu-proxy/SKILL.md" && method === "GET") {
      const asset = await env.ASSETS.fetch(new URL("/skill.md", request.url));
      return new Response(asset.body, {
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    if (path === "/api/meta" && method === "GET") {
      return json({ mock: isMock(env) });
    }

    if (path === "/api/auth/register" && method === "POST") {
      const body = await readJson(request);
      return json(await startSignup(env, String(body.email ?? ""), String(body.password ?? "")));
    }

    if (path === "/api/auth/verify" && method === "POST") {
      const body = await readJson(request);
      const user = await finishSignup(env, String(body.email ?? ""), String(body.code ?? ""));
      const token = await createSession(env, user.id);
      return json(
        { user: publicUser(user) },
        { headers: { "Set-Cookie": sessionCookie(token, request) } },
      );
    }

    if (path === "/api/cli/start" && method === "POST") {
      const body = await readJson(request);
      return json(await deviceStart(env, request, String(body.name ?? "agent")));
    }
    if (path === "/api/cli/poll" && method === "POST") {
      const body = await readJson(request);
      return json(await devicePoll(env, String(body.device_code ?? "")));
    }
    if (path === "/api/cli/info" && method === "GET") {
      await requireAuth(env, request);
      return json(await deviceInfo(env, url.searchParams.get("code") ?? ""));
    }
    if (path === "/api/cli/decide" && method === "POST") {
      const auth = await requireAuth(env, request);
      const body = await readJson(request);
      return json(await deviceDecide(env, auth, String(body.code ?? ""), body.approve === true));
    }

    if (path === "/gpu-proxy.sh" && method === "GET") {
      const asset = await env.ASSETS.fetch(new URL("/gpu-proxy.sh", request.url));
      const text = (await asset.text()).replaceAll("__GPU_PROXY_URL__", url.origin);
      return new Response(text, { headers: { "Content-Type": "text/x-shellscript; charset=utf-8" } });
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
      return json({
        user: auth.public,
        via: auth.via,
        mock: isMock(env),
        lab: await labStatus(env, false),
      });
    }

    if (path === "/api/account" && method === "GET") {
      const auth = await requireAuth(env, request);
      if (auth.user.role !== "admin") return json({ massed: null });
      return json({ massed: await getAccountSnapshot(env) });
    }

    if (path === "/api/inventory" && method === "GET") {
      const auth = await requireAuth(env, request);
      return json(
        await orEmptyWhenOffline(env, { gpus: [] as unknown[], images: [] as unknown[] }, async () => {
          const [skus, images] = await Promise.all([listInventory(env), listImages(env)]);
          return { gpus: filterInventory(auth.public, skus), images };
        }),
      );
    }

    if (path === "/api/match" && method === "POST") {
      const auth = await requireAuth(env, request);
      const body = await readJson(request);
      return json(await recommendSetup(env, auth.public, String(body.query ?? body.text ?? "")));
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
        "SELECT id, name, key_prefix, kind, created_at, last_used_at, expires_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
      )
        .bind(auth.user.id)
        .all();
      return json({ keys: rows.results ?? [] });
    }

    const keyDel = path.match(/^\/api\/keys\/([^/]+)$/);
    if (keyDel && method === "DELETE") {
      const auth = await requireAuth(env, request);
      await env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").bind(keyDel[1], auth.user.id).run();
      await audit(env.DB, auth.user.id, "api_key.revoke", { id: keyDel[1] });
      return json({ ok: true });
    }

    if (path === "/api/team" && method === "GET") {
      const auth = await requireAuth(env, request);
      return json(await teamOverview(env, auth.user.role === "admin", auth.user.id));
    }

    if (path === "/api/team/invites" && method === "POST") {
      const auth = await requireAdmin(env, request);
      const body = await readJson(request);
      return json(await createInvite(env, auth.user.id, body), { status: 201 });
    }

    const inviteDel = path.match(/^\/api\/team\/invites\/([^/]+)$/);
    if (inviteDel && method === "DELETE") {
      const auth = await requireAdmin(env, request);
      const email = decodeURIComponent(inviteDel[1]).toLowerCase();
      await env.DB.prepare("DELETE FROM invites WHERE email = ?").bind(email).run();
      await audit(env.DB, auth.user.id, "team.invite.revoke", { email });
      return json({ ok: true });
    }

    if (path === "/api/admin/settings" && method === "GET") {
      await requireAdmin(env, request);
      return json({ members_see_team_spend: await membersSeeTeamSpend(env) });
    }
    if (path === "/api/admin/settings" && method === "PATCH") {
      const auth = await requireAdmin(env, request);
      const body = await readJson(request);
      if (typeof body.members_see_team_spend === "boolean") {
        await setSetting(env, "members_see_team_spend", body.members_see_team_spend ? "1" : "0");
        await audit(env.DB, auth.user.id, "settings.members_see_team_spend", { value: body.members_see_team_spend });
      }
      return json({ members_see_team_spend: await membersSeeTeamSpend(env) });
    }

    if (path === "/api/admin/audit" && method === "GET") {
      await requireAdmin(env, request);
      const rows = await env.DB.prepare(
        `SELECT a.id, a.action, a.detail, a.created_at, u.email
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.created_at DESC LIMIT 60`,
      ).all();
      return json({ events: rows.results ?? [] });
    }

    if (path === "/api/admin/catalog" && method === "GET") {
      await requireAdmin(env, request);
      return json(
        await orEmptyWhenOffline(env, { gpus: [] as unknown[], images: [] as unknown[] }, async () => {
          const [gpus, images] = await Promise.all([listInventory(env), listImages(env)]);
          return { gpus, images };
        }),
      );
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
      const [report, massed, watch] = await Promise.all([
        usageReport(env, null),
        getAccountSnapshot(env),
        massedWatchReport(env).catch(() => ({
          vms: [],
          ticks: [],
          summary: { cents: 0, hours: 0, vm_count: 0, unattributed_cents: 0, unattributed_vm_count: 0, unattributed_running: 0 },
        })),
      ]);
      return json({
        ...report,
        summary: { ...report.summary, unattributed_cents: watch.summary.unattributed_cents },
        massed: { ...massed, ...(await balanceEstimate(env)) },
        watch,
      });
    }

    if (path === "/api/admin/fleet" && method === "GET") {
      await requireAdmin(env, request);
      const rows = await env.DB.prepare(
        `SELECT i.id, i.mc_uuid, i.user_id, u.email, i.name, i.product_name, i.status, i.ip,
                i.price_cents_per_hour, i.launched_at, i.terminated_at, i.last_metered_at, i.billed_cents, i.end_reason, i.api_key_id
         FROM instances i JOIN users u ON u.id = i.user_id
         ORDER BY i.launched_at DESC LIMIT 200`,
      ).all();
      return json({ instances: rows.results ?? [] });
    }

    if (path === "/api/admin/upstream" && method === "GET") {
      await requireAdmin(env, request);
      return json(
        await orEmptyWhenOffline(env, { instances: [] as unknown[], billing: null as unknown }, async () => {
          const [instances, billing] = await Promise.all([listRunningInstances(env), getBilling(env)]);
          return { instances, billing };
        }),
      );
    }

    if (path === "/api/admin/meter" && method === "POST") {
      await requireAdmin(env, request);
      return json(await tickMeter(env));
    }

    // "Connect Massed Compute": admins link the lab's Massed account over OAuth (full scope, needed to launch).
    if (path === "/api/massed/connection" && method === "GET") {
      const auth = await requireAdmin(env, request);
      return json(await connectionStatus(env, auth.user.id));
    }
    if (path === "/api/massed/connect" && method === "POST") {
      const auth = await requireAdmin(env, request);
      const body = await readJson(request);
      return json(await startConnect(env, auth, request, body.return_to === "app" ? "app" : "connect"));
    }
    if (path === "/api/massed/oauth/callback" && method === "GET") {
      const auth = await requireAdmin(env, request);
      const next = await finishConnect(env, auth, request);
      // Read the MCP write-tool schemas now, so a mismatch shows up on the lab status before anyone launches.
      await ensureSchema(env, { force: true }).catch(() => null);
      return Response.redirect(new URL(next, url.origin).toString(), 302);
    }
    if (path === "/api/massed/disconnect" && method === "POST") {
      const auth = await requireAdmin(env, request);
      return json(await disconnect(env, auth.user.id));
    }
    if (path === "/api/massed/probe" && method === "GET") {
      const auth = await requireAdmin(env, request);
      return json(await probeConnection(env, auth.user.id));
    }

    // Lab-wide Massed status (everyone) and which admin's connection is "the lab account" (admins).
    if (path === "/api/lab/status" && method === "GET") {
      const auth = await requireAuth(env, request);
      const isAdmin = auth.user.role === "admin";
      return json({ ...(await labStatus(env, isAdmin)), ...(isAdmin ? await balanceEstimate(env) : {}) });
    }
    if (path === "/api/lab/schema-check" && method === "POST") {
      await requireAdmin(env, request);
      await ensureSchema(env, { force: true });
      return json(await labStatus(env, true));
    }
    if (path === "/api/lab/designate" && method === "POST") {
      const auth = await requireAdmin(env, request);
      const body = await readJson(request);
      return json(await designateLabAdmin(env, auth.user.id, String(body.user_id ?? auth.user.id)));
    }

    // Which optional features exist, so the UI can switch them on.
    if (path === "/api/ui/capabilities" && method === "GET") {
      await requireAuth(env, request);
      return json({
        onboarding: true,
        ssh_keys: true,
        balance: true,
        lab_status: true,
        vm_events: true,
        burn_series: true,
        attribution: true,
      });
    }

    // SSH public keys (the only way into a VM when the lab connects over OAuth).
    if ((path === "/api/ssh-keys" || path === "/api/me/ssh-keys") && method === "GET") {
      const auth = await requireAuth(env, request);
      return json({ keys: await listSshKeys(env, auth.user.id) });
    }
    if ((path === "/api/ssh-keys" || path === "/api/me/ssh-keys") && method === "POST") {
      const auth = await requireAuth(env, request);
      const body = await readJson(request);
      const key = await addSshKey(env, auth.user.id, String(body.name ?? ""), String(body.public_key ?? body.publicKey ?? ""));
      return json({ key }, { status: 201 });
    }
    const sshDel = path.match(/^\/api\/(?:me\/)?ssh-keys\/([^/]+)$/);
    if (sshDel && method === "DELETE") {
      const auth = await requireAuth(env, request);
      await deleteSshKey(env, auth.user.id, decodeURIComponent(sshDel[1]));
      return json({ ok: true });
    }

    // First-run tutorial.
    if ((path === "/api/onboarding" || path === "/api/me/onboarding") && method === "GET") {
      const auth = await requireAuth(env, request);
      return json(await onboardingState(env, auth.user.id, auth.user.role === "admin"));
    }
    if ((path === "/api/onboarding" || path === "/api/me/onboarding") && method === "POST") {
      const auth = await requireAuth(env, request);
      await saveOnboarding(env, auth.user.id, await readJson(request));
      return json(await onboardingState(env, auth.user.id, auth.user.role === "admin"));
    }

    // Tracking.
    if (path === "/api/events" && method === "GET") {
      const auth = await requireAuth(env, request);
      return json(await vmEventsReport(env, auth.user.id, Number(url.searchParams.get("limit")) || 100));
    }
    if (path === "/api/admin/events" && method === "GET") {
      await requireAdmin(env, request);
      const user = url.searchParams.get("user_id");
      return json(await vmEventsReport(env, user, Number(url.searchParams.get("limit")) || 200));
    }
    if (path === "/api/admin/burn" && method === "GET") {
      await requireAdmin(env, request);
      return json(await burnSeries(env, Number(url.searchParams.get("hours")) || 24, Number(url.searchParams.get("bucket_minutes")) || 5));
    }
    if (path === "/api/admin/billing-history" && method === "GET") {
      await requireAdmin(env, request);
      return json(await billingHistory(env));
    }
    if (path === "/api/admin/connection-events" && method === "GET") {
      await requireAdmin(env, request);
      return json(await connectionHistory(env));
    }
    if (path === "/api/admin/calibration" && method === "GET") {
      await requireAdmin(env, request);
      return json(await calibrationReport(env));
    }
    if (path === "/api/admin/balance" && method === "POST") {
      const auth = await requireAdmin(env, request);
      return json(await addBalanceEntry(env, auth.user.id, await readJson(request)), { status: 201 });
    }
    const attr = path.match(/^\/api\/admin\/vms\/([^/]+)\/attribute$/);
    if (attr && method === "POST") {
      const auth = await requireAdmin(env, request);
      const body = await readJson(request);
      return json(await attributeVm(env, auth.user.id, decodeURIComponent(attr[1]), body.user_id ? String(body.user_id) : null));
    }

    if (path.startsWith("/api/")) return err(404, "Not found");

    // Landing page at "/", the app at "/app" and "/app/*" (assets use html_handling "none", so paths are exact).
    if (path === "/" && (method === "GET" || method === "HEAD")) {
      const connect = url.searchParams.get("connect");
      if (connect) return Response.redirect(`${url.origin}/app?connect=${encodeURIComponent(connect)}`, 302);
      const landing = await env.ASSETS.fetch(new Request(new URL("/landing.html", url), request));
      if (landing.ok) return landing;
      return Response.redirect(`${url.origin}/app`, 302);
    }
    if (path === "/app" || path.startsWith("/app/")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }
    return env.ASSETS.fetch(request);
  } catch (e) {
    const status = typeof (e as { status?: number }).status === "number" ? (e as { status: number }).status : 400;
    const message = e instanceof Error ? e.message : "Error";
    // 503 messages are written for the user ("tool schema changed", "could not reach Massed"); other 5xx stay hidden.
    if (status >= 500 && status !== 503) {
      console.error(JSON.stringify({ message: "handler error", error: message, path }));
      return err(500, "Internal error");
    }
    return err(status, message, (e as { code?: string }).code);
  }
}

/** Lab setting: may non-admin members see each other's budget and spend? Default no. */
async function membersSeeTeamSpend(env: Env): Promise<boolean> {
  return (await getSetting(env, "members_see_team_spend")) === "1";
}

async function teamOverview(env: Env, isAdmin: boolean, callerId: string) {
  // Admins always see everything. Members see only their own money unless an admin opened it up.
  const spendVisible = isAdmin || (await membersSeeTeamSpend(env));
  const hide = (userId: string) => !spendVisible && userId !== callerId;
  const members = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.credit_cents, u.spent_cents, u.max_concurrent, u.allowed_gpus, u.created_at,
      (SELECT COUNT(*) FROM instances i WHERE i.user_id = u.id AND i.status IN ('launching','running')) AS running,
      (SELECT COALESCE(SUM(i.price_cents_per_hour),0) FROM instances i WHERE i.user_id = u.id AND i.status IN ('launching','running')) AS burn_cents_per_hour
     FROM users u ORDER BY u.role = 'admin' DESC, u.created_at ASC`,
  ).all();
  const invites = isAdmin
    ? await env.DB.prepare("SELECT email, role, credit_cents, max_concurrent, allowed_gpus, created_at FROM invites ORDER BY created_at DESC").all()
    : { results: [] };
  const running = await env.DB.prepare(
    `SELECT i.id, i.user_id, u.email, i.name, i.product_name, i.region_name, i.status, i.price_cents_per_hour, i.launched_at
     FROM instances i JOIN users u ON u.id = i.user_id
     WHERE i.status IN ('launching','running') ORDER BY i.launched_at DESC`,
  ).all();
  return {
    spend_visible: spendVisible,
    members: (members.results ?? []).map((m) =>
      hide(String(m.id)) ? { ...m, credit_cents: null, spent_cents: null, burn_cents_per_hour: null } : m,
    ),
    invites: invites.results ?? [],
    running: (running.results ?? []).map((r) => (hide(String(r.user_id)) ? { ...r, price_cents_per_hour: null } : r)),
  };
}

async function createInvite(env: Env, adminId: string, body: Record<string, unknown>) {
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Invalid email");
  if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) {
    throw new HttpError(409, "That person already has an account");
  }
  const credit = Math.max(0, Math.floor(Number(body.credit_cents) || 0));
  const cap = Math.max(0, Math.min(32, Math.floor(Number(body.max_concurrent ?? 1))));
  const role = body.role === "admin" ? "admin" : "user";
  const gpus = Array.isArray(body.allowed_gpus) && body.allowed_gpus.length ? body.allowed_gpus.map(String) : ["*"];
  await env.DB.prepare(
    `INSERT OR REPLACE INTO invites (email, role, credit_cents, max_concurrent, allowed_gpus, invited_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(email, role, credit, cap, JSON.stringify(gpus), adminId, new Date().toISOString())
    .run();
  await audit(env.DB, adminId, "team.invite", { email, role, credit, cap });
  return { invite: { email, role, credit_cents: credit, max_concurrent: cap } };
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

function cors(_request: Request): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  };
}

export { tickMeter };
