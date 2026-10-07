import type { AuthContext } from "./auth";
import { bytesToB64url, bytesToHex, decryptSecret, encryptSecret, randomBytes, sha256Hex } from "./crypto";
import { audit } from "./db";
import { massedOrigin, USER_AGENT } from "./config";
import { getSetting, recordConnectionEvent, setSetting } from "./lab";
import { appUrl, emailAdmins } from "./notify";
import { HttpError } from "./policy";

const urls = (env: Env) => {
  const o = massedOrigin(env);
  return {
    authorize: `${o}/oauth/authorize`,
    token: `${o}/api/oauth/token`,
    register: `${o}/api/oauth/register`,
    revoke: `${o}/api/oauth/revoke`,
    mcp: `${o}/api/mcp`,
  };
};

const CLIENT_NAME = "Mass Compute Management UI";
const STATE_TTL_SEC = 600;
const REFRESH_SKEW_SEC = 60;

type Scope = "read" | "full";

type Connection = {
  user_id: string;
  client_id: string;
  access_enc: string;
  refresh_enc: string | null;
  expires_at: number;
  scope: string;
  connected_at: string;
  last_used_at: string | null;
  last_error: string | null;
  status: "active" | "lost";
  lost_at: string | null;
  lost_notified_at: string | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

export function redirectUriFor(request: Request): string {
  return `${new URL(request.url).origin}/api/massed/oauth/callback`;
}

function scopeString(scope: Scope): string {
  return scope === "full" ? "mcp:read mcp:write" : "mcp:read";
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Massed does not verify app names, so register one client per redirect URI and reuse it. */
async function ensureClient(env: Env, redirectUri: string): Promise<string> {
  const known = await env.DB.prepare("SELECT client_id FROM massed_oauth_apps WHERE redirect_uri = ?")
    .bind(redirectUri)
    .first<{ client_id: string }>();
  if (known) return known.client_id;

  const res = await fetch(urls(env).register, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:read mcp:write",
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new HttpError(502, `Massed client registration failed (${res.status}) ${detail} redirect_uri=${redirectUri}`.trim());
  }
  const data = (await res.json()) as { client_id?: string };
  if (!data.client_id) throw new HttpError(502, "Massed client registration returned no client_id");
  await env.DB.prepare("INSERT OR REPLACE INTO massed_oauth_apps (redirect_uri, client_id, created_at) VALUES (?, ?, ?)")
    .bind(redirectUri, data.client_id, new Date().toISOString())
    .run();
  return data.client_id;
}

/** Step 1: build the Massed consent URL. The user approves on Massed's own page. */
export async function startConnect(env: Env, auth: AuthContext, request: Request, returnTo: "app" | "connect" = "connect") {
  // Only admins connect Massed. The grant must be full (mcp:write) because launching goes through it.
  if (auth.user.role !== "admin") throw new HttpError(403, "Only admins can connect Massed Compute");
  const scope: Scope = "full";
  await setSetting(env, "app_origin", new URL(request.url).origin);
  const redirectUri = redirectUriFor(request);
  const clientId = await ensureClient(env, redirectUri);

  const verifier = bytesToB64url(randomBytes(48));
  const challenge = bytesToB64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const state = bytesToHex(randomBytes(24));

  await env.DB.batch([
    env.DB.prepare("DELETE FROM massed_oauth_states WHERE expires_at < ?").bind(nowSec()),
    env.DB.prepare(
      `INSERT INTO massed_oauth_states (state_hash, user_id, verifier_enc, redirect_uri, scope, expires_at, created_at, return_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      await sha256Hex(state),
      auth.user.id,
      await encryptSecret(verifier, env.DATA_KEY),
      redirectUri,
      scope,
      nowSec() + STATE_TTL_SEC,
      new Date().toISOString(),
      returnTo,
    ),
  ]);

  const url = new URL(urls(env).authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopeString(scope));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return { url: url.toString(), scope };
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(urls(env).token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams(params),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    const reason = data.error_description || data.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(reason), { oauth: data.error ?? "token_error", httpStatus: res.status });
  }
  return data;
}

async function saveTokens(env: Env, userId: string, clientId: string, scope: string, t: TokenResponse, keepRefresh?: string | null) {
  const refresh = t.refresh_token ?? keepRefresh ?? null;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO massed_connections (user_id, client_id, access_enc, refresh_enc, expires_at, scope, connected_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET client_id = excluded.client_id, access_enc = excluded.access_enc,
       refresh_enc = excluded.refresh_enc, expires_at = excluded.expires_at, scope = excluded.scope, last_error = NULL,
       status = 'active', lost_at = NULL, lost_notified_at = NULL`,
  )
    .bind(
      userId,
      clientId,
      await encryptSecret(t.access_token!, env.DATA_KEY),
      refresh ? await encryptSecret(refresh, env.DATA_KEY) : null,
      nowSec() + (t.expires_in ?? 3600),
      t.scope || scope,
      now,
    )
    .run();
}

/** Step 2: Massed redirects back with ?code&state. Returns where to send the browser next. */
export async function finishConnect(env: Env, auth: AuthContext, request: Request): Promise<string> {
  const q = new URL(request.url).searchParams;
  let returnTo: string = "connect";
  const back = (params: string) => {
    const p = new URLSearchParams(params);
    if (returnTo === "app") {
      return `/app?${p.has("error") ? `massed_error=${encodeURIComponent(p.get("error")!)}` : "massed=connected"}`;
    }
    return `/connect.html?${params}`;
  };
  const stateParam = q.get("state");
  if (stateParam) {
    const r = await env.DB.prepare("SELECT return_to FROM massed_oauth_states WHERE state_hash = ?").bind(await sha256Hex(stateParam)).first<{ return_to: string }>();
    if (r?.return_to === "app") returnTo = "app";
  }
  if (q.get("error")) return back(`error=${encodeURIComponent(q.get("error_description") || q.get("error") || "denied")}`);

  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) throw new HttpError(400, "Missing code or state");

  const stateHash = await sha256Hex(state);
  const row = await env.DB.prepare("SELECT * FROM massed_oauth_states WHERE state_hash = ?")
    .bind(stateHash)
    .first<{ user_id: string; verifier_enc: string; redirect_uri: string; scope: string; expires_at: number }>();
  await env.DB.prepare("DELETE FROM massed_oauth_states WHERE state_hash = ?").bind(stateHash).run();
  if (!row || row.expires_at < nowSec()) throw new HttpError(400, "Authorization expired. Start again.");
  if (row.user_id !== auth.user.id) throw new HttpError(403, "This authorization belongs to a different user");

  const clientId = await ensureClient(env, row.redirect_uri);
  let tokens: TokenResponse;
  try {
    tokens = await tokenRequest(env, {
      grant_type: "authorization_code",
      code,
      redirect_uri: row.redirect_uri,
      client_id: clientId,
      code_verifier: await decryptSecret(row.verifier_enc, env.DATA_KEY),
    });
  } catch (e) {
    return back(`error=${encodeURIComponent(e instanceof Error ? e.message : "token exchange failed")}`);
  }
  const hadLabAdmin = await getSetting(env, "lab_admin_id");
  await saveTokens(env, auth.user.id, clientId, row.scope, tokens);
  if (!hadLabAdmin) await setSetting(env, "lab_admin_id", auth.user.id);
  await recordConnectionEvent(env, auth.user.id, "connected", { scope: tokens.scope || row.scope });
  await audit(env.DB, auth.user.id, "massed.connect", { scope: tokens.scope || row.scope });
  return back("connected=1");
}

async function loadConnection(env: Env, userId: string): Promise<Connection | null> {
  return env.DB.prepare("SELECT * FROM massed_connections WHERE user_id = ?").bind(userId).first<Connection>();
}

export async function connectionStatus(env: Env, userId: string) {
  const c = await loadConnection(env, userId);
  if (!c) return { connected: false, status: "not_connected" };
  return {
    connected: c.status === "active",
    status: c.status,
    lost_at: c.lost_at,
    scope: c.scope,
    connected_at: c.connected_at,
    last_used_at: c.last_used_at,
    last_error: c.last_error,
    access_expires_at: new Date(c.expires_at * 1000).toISOString(),
    has_refresh_token: !!c.refresh_enc,
  };
}

async function markError(env: Env, userId: string, message: string) {
  await env.DB.prepare("UPDATE massed_connections SET last_error = ? WHERE user_id = ?").bind(message.slice(0, 200), userId).run();
}

/**
 * The grant is gone (revoked on Massed, expired, rejected). Keep the row so the lab status can say
 * "lost since", stop using it, and email the admins once per loss.
 */
async function markLost(env: Env, userId: string, reason: string) {
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `UPDATE massed_connections SET status = 'lost', lost_at = COALESCE(lost_at, ?), last_error = ? WHERE user_id = ? AND status = 'active'`,
  )
    .bind(now, reason.slice(0, 200), userId)
    .run();
  if (!res.meta.changes) return;
  await recordConnectionEvent(env, userId, "lost", { reason: reason.slice(0, 200) });
  await audit(env.DB, userId, "massed.connection_lost", { reason: reason.slice(0, 200) });
  const claimed = await env.DB.prepare(
    "UPDATE massed_connections SET lost_notified_at = ? WHERE user_id = ? AND lost_notified_at IS NULL",
  )
    .bind(now, userId)
    .run();
  if (claimed.meta.changes) {
    const link = `${await appUrl(env)}/app`;
    await emailAdmins(
      env,
      "Massed Compute connection lost",
      `The desk lost its connection to the Massed Compute account.\n\nReason: ${reason.slice(0, 200)}\n\nUntil an admin reconnects, members cannot launch GPUs and spend is not being metered.\n\nReconnect: ${link}`,
    );
  }
}

/** Returns a usable access token, refreshing it when it is about to expire. */
async function accessToken(env: Env, userId: string, forceRefresh = false): Promise<string> {
  const c = await loadConnection(env, userId);
  if (!c) throw new HttpError(409, "Massed account is not connected");
  if (c.status === "lost") throw new HttpError(409, "Massed connection was lost. An admin must reconnect.", "lab_lost");
  if (!forceRefresh && c.expires_at - REFRESH_SKEW_SEC > nowSec()) {
    return decryptSecret(c.access_enc, env.DATA_KEY);
  }
  if (!c.refresh_enc) {
    await recordConnectionEvent(env, userId, "refresh_failed", { reason: "no refresh token" });
    await markLost(env, userId, "Massed access expired and there is no refresh token");
    throw new HttpError(409, "Massed connection expired. Reconnect.");
  }
  const refresh = await decryptSecret(c.refresh_enc, env.DATA_KEY);
  try {
    const t = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: refresh, client_id: c.client_id });
    await saveTokens(env, userId, c.client_id, c.scope, t, refresh);
    await recordConnectionEvent(env, userId, "refreshed", {});
    return t.access_token!;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // Another request may have refreshed first (refresh tokens can rotate). Use its token.
    const again = await loadConnection(env, userId);
    if (again && again.status === "active" && again.expires_at - REFRESH_SKEW_SEC > nowSec() && again.access_enc !== c.access_enc) {
      return decryptSecret(again.access_enc, env.DATA_KEY);
    }
    const httpStatus = (e as { httpStatus?: number }).httpStatus;
    const permanent = (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) || (e as { oauth?: string }).oauth === "invalid_grant";
    await recordConnectionEvent(env, userId, "refresh_failed", { reason, permanent });
    if (!permanent) {
      // Network error or Massed 5xx: do not drop the grant over a blip.
      await markError(env, userId, `Refresh failed: ${reason}`);
      throw new HttpError(503, "Could not reach Massed to refresh the connection. Try again shortly.");
    }
    await markLost(env, userId, `Massed refused the refresh token (${reason})`);
    throw new HttpError(409, "Massed connection was revoked. Reconnect.");
  }
}

async function rpc(env: Env, token: string, method: string, params?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(urls(env).mcp, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const json = text.startsWith("event:") || text.startsWith("data:")
      ? (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5)
      : text;
    body = JSON.parse(json) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

async function callMcp(env: Env, userId: string, method: string, params?: unknown): Promise<Record<string, unknown>> {
  let token = await accessToken(env, userId);
  let out = await rpc(env, token, method, params);
  if (out.status === 401) {
    token = await accessToken(env, userId, true);
    out = await rpc(env, token, method, params);
  }
  if (out.status === 401) {
    await recordConnectionEvent(env, userId, "rejected", {});
    await markLost(env, userId, "Massed rejected the access token");
    throw new HttpError(409, "Massed rejected the connection. Reconnect.");
  }
  await env.DB.prepare("UPDATE massed_connections SET last_used_at = ?, last_error = NULL WHERE user_id = ?")
    .bind(new Date().toISOString(), userId)
    .run();
  if (out.status >= 500) throw new HttpError(503, `Massed returned ${out.status}. Try again shortly.`);
  const err = out.body.error as { message?: string; code?: number } | undefined;
  if (err) throw new HttpError(err.code === 40300 ? 403 : 502, err.message || "Massed MCP error");
  return (out.body.result ?? {}) as Record<string, unknown>;
}

export async function listMcpTools(env: Env, userId: string): Promise<{ name: string; inputSchema?: unknown }[]> {
  const r = await callMcp(env, userId, "tools/list");
  const tools = r.tools as { name: string; inputSchema?: unknown }[] | undefined;
  // An empty or missing list means we could not read it, not that Massed removed every tool.
  if (!Array.isArray(tools) || !tools.length) throw new HttpError(503, "Massed returned no tool list");
  return tools;
}

export async function massedTool(env: Env, userId: string, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await callMcp(env, userId, "tools/call", { name, arguments: args });
  if (result.isError) {
    const text = (result.content as { text?: string }[] | undefined)?.[0]?.text;
    throw new HttpError(502, text || `Massed tool ${name} failed`);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content as { text?: string }[] | undefined)?.[0]?.text;
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text ?? null;
  }
}

export async function disconnect(env: Env, userId: string): Promise<{ ok: true }> {
  const c = await loadConnection(env, userId);
  if (c) {
    for (const enc of [c.refresh_enc, c.access_enc]) {
      if (!enc) continue;
      try {
        await fetch(urls(env).revoke, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: await decryptSecret(enc, env.DATA_KEY), client_id: c.client_id }),
        });
      } catch {
        /* the local row is removed either way */
      }
    }
    await env.DB.prepare("DELETE FROM massed_connections WHERE user_id = ?").bind(userId).run();
    if ((await getSetting(env, "lab_admin_id")) === userId) await env.DB.prepare("DELETE FROM lab_settings WHERE key = 'lab_admin_id'").run();
    await recordConnectionEvent(env, userId, "disconnected", {});
    await audit(env.DB, userId, "massed.disconnect", {});
  }
  return { ok: true };
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} items`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length > 8 ? `${keys.length} entries` : `keys: ${keys.join(", ")}`;
  }
  return String(value);
}

type ProbeRow = { tool: string; ok: boolean; ms: number; summary: string; fields?: string[]; error?: string };

/**
 * Calls every read-only Massed tool with the connected user's token and reports what came back.
 * Values are summarized (counts, field names), not dumped, so no VM passwords or keys leak into the report.
 */
export async function probeConnection(env: Env, userId: string) {
  const status = await connectionStatus(env, userId);
  if (!status.connected) throw new HttpError(409, "Massed account is not connected");

  const catalog = await callMcp(env, userId, "tools/list");
  const tools = ((catalog.tools as { name: string }[] | undefined) ?? []).map((t) => t.name);

  const read: [string, (v: unknown) => { summary: string; fields?: string[] }][] = [
    ["account_token_validation", (v) => ({ summary: describe(v) })],
    ["account_billing", (v) => ({ summary: describe(v), fields: Object.keys((v as object) ?? {}) })],
    ["instances_list", (v) => {
      const list = ((v as { runningInstances?: Record<string, unknown>[] })?.runningInstances) ?? [];
      return { summary: `${list.length} running`, fields: list[0] ? Object.keys(list[0]) : [] };
    }],
    ["ssh_keys_list", (v) => {
      const list = ((v as { sshKeys?: Record<string, unknown>[] })?.sshKeys) ?? [];
      return { summary: `${list.length} keys`, fields: list[0] ? Object.keys(list[0]) : [] };
    }],
    ["gpu_inventory_list", (v) => ({ summary: describe((v as { gpu_inventory?: unknown })?.gpu_inventory ?? v) })],
    ["images_list", (v) => ({ summary: describe((v as { images?: unknown })?.images ?? v) })],
    ["recipes_list", (v) => ({ summary: describe((v as { recipes?: unknown })?.recipes ?? v) })],
  ];

  const results: ProbeRow[] = [];
  for (const [tool, summarize] of read) {
    const t0 = Date.now();
    try {
      const value = await massedTool(env, userId, tool);
      results.push({ tool, ok: true, ms: Date.now() - t0, ...summarize(value) });
    } catch (e) {
      results.push({ tool, ok: false, ms: Date.now() - t0, summary: "", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { status, tools, results };
}
