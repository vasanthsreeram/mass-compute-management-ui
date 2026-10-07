import { audit } from "./db";
import { HttpError } from "./policy";
import { storedSchema } from "./schema";

/**
 * "The lab account" is ONE admin's Massed OAuth connection. Every Massed call the app makes
 * (inventory, launch, terminate, billing, the cron watcher) goes through it.
 *
 * Which admin: `lab_settings.lab_admin_id` if set (POST /api/lab/designate, or the first admin to
 * connect), otherwise the earliest-connected admin with an active grant. There is deliberately no
 * silent failover: switching accounts changes who gets billed, so an admin must choose it.
 */

export type LabConnection = { userId: string; email: string; status: "active" | "lost"; scope: string };

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM lab_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lab_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, new Date().toISOString())
    .run();
}

export async function recordConnectionEvent(env: Env, userId: string | null, kind: string, detail: unknown = {}) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO connection_events (id, user_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      crypto.randomUUID(),
      userId,
      kind,
      JSON.stringify(detail),
      new Date().toISOString(),
    ),
    env.DB.prepare("DELETE FROM connection_events WHERE created_at < ?").bind(
      new Date(Date.now() - 90 * 86_400_000).toISOString(),
    ),
  ]);
}

export async function labConnection(env: Env): Promise<LabConnection | null> {
  const designated = await getSetting(env, "lab_admin_id");
  const base = `SELECT c.user_id AS userId, u.email, c.status, c.scope
                FROM massed_connections c JOIN users u ON u.id = c.user_id AND u.role = 'admin'`;
  if (designated) {
    const row = await env.DB.prepare(`${base} WHERE c.user_id = ?`).bind(designated).first<LabConnection>();
    if (row) return row;
  }
  return env.DB.prepare(`${base} WHERE c.status = 'active' ORDER BY c.connected_at ASC LIMIT 1`).first<LabConnection>();
}

export async function designateLabAdmin(env: Env, byAdminId: string, targetUserId: string) {
  const target = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(targetUserId).first<{ role: string }>();
  if (!target) throw new HttpError(404, "Unknown user");
  if (target.role !== "admin") throw new HttpError(400, "Only an admin can be the lab account", "not_admin");
  const c = await env.DB.prepare(
    `SELECT c.status FROM massed_connections c JOIN users u ON u.id = c.user_id AND u.role = 'admin' WHERE c.user_id = ?`,
  )
    .bind(targetUserId)
    .first<{ status: string }>();
  if (!c) throw new HttpError(409, "That admin has not connected Massed Compute", "no_connection");
  if (c.status !== "active") throw new HttpError(409, "That admin's connection is lost. They need to reconnect first.", "connection_lost");
  await setSetting(env, "lab_admin_id", targetUserId);
  await recordConnectionEvent(env, byAdminId, "designated", { lab_admin_id: targetUserId });
  await audit(env.DB, byAdminId, "lab.designate", { lab_admin_id: targetUserId });
  return labStatus(env, true);
}

export type LabState = "connected" | "lost" | "not_connected" | "api_key" | "mock";

/**
 * Lab-wide status. Members get the state only; admins also see who owns the connection.
 * `can_launch` is false whenever no transport would work, so the UI can pause the launch button.
 */
export async function labStatus(env: Env, isAdmin: boolean) {
  const conn = await labConnection(env);
  const hasKey = !!env.MASSED_COMPUTE_API_KEY;
  const mock = env.MOCK_MASSED === "1";
  let state: LabState;
  if (mock) state = "mock";
  else if (conn?.status === "active") state = "connected";
  else if (hasKey) state = "api_key";
  else if (conn?.status === "lost") state = "lost";
  else state = "not_connected";

  const row = conn
    ? await env.DB.prepare("SELECT connected_at, last_used_at, last_error, lost_at, expires_at, scope FROM massed_connections WHERE user_id = ?")
        .bind(conn.userId)
        .first<{ connected_at: string; last_used_at: string | null; last_error: string | null; lost_at: string | null; expires_at: number; scope: string }>()
    : null;

  const message: Record<LabState, string> = {
    connected: "Connected to Massed Compute.",
    mock: "Mock mode: no real Massed calls are made.",
    api_key: conn?.status === "lost"
      ? "The Massed OAuth connection was lost. Using the operator API key instead. An admin should reconnect."
      : "Using the operator API key. Connect an admin's Massed account to switch to OAuth.",
    lost: "The connection to Massed Compute was lost. Launching and metering are paused until an admin reconnects.",
    not_connected: "No Massed Compute account is connected yet. An admin needs to connect one.",
  };

  // Only meaningful over OAuth/MCP: the REST fallback does not send MCP tool arguments.
  const schema = state === "connected" ? await storedSchema(env) : null;
  const schemaBlocked = schema?.ok === false;
  const out: Record<string, unknown> = {
    state,
    healthy: (state === "connected" || state === "mock" || state === "api_key") && !schemaBlocked,
    can_launch: state !== "lost" && state !== "not_connected" && !schemaBlocked,
    message: schemaBlocked ? "Massed changed its launch API. Launching is paused until the desk is updated." : message[state],
    schema_ok: schema ? schema.ok : null,
    lost_since: conn?.status === "lost" ? row?.lost_at ?? null : null,
  };
  if (isAdmin) {
    Object.assign(out, {
      lab_admin: conn ? { user_id: conn.userId, email: conn.email } : null,
      scope: row?.scope ?? null,
      connected_at: row?.connected_at ?? null,
      last_used_at: row?.last_used_at ?? null,
      last_error: row?.last_error ?? null,
      access_expires_at: row ? new Date(row.expires_at * 1000).toISOString() : null,
      api_key_fallback: hasKey,
      schema_problems: schema?.problems ?? [],
      schema_checked_at: schema?.checked_at ?? null,
      schema_error: schema?.error ?? null,
      schema_tools: schema?.tools ?? null,
      admins_connected: (
        await env.DB.prepare(
          `SELECT c.user_id, u.email, c.status FROM massed_connections c JOIN users u ON u.id = c.user_id AND u.role = 'admin'`,
        ).all()
      ).results,
    });
  }
  return out;
}
