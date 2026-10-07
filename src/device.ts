import type { AuthContext } from "./auth";
import { createApiKey } from "./auth";
import { bytesToHex, decryptSecret, encryptSecret, randomBytes, sha256Hex } from "./crypto";
import { audit } from "./db";
import { HttpError } from "./policy";

const CODE_TTL_SEC = 600;
const POLL_INTERVAL_SEC = 3;
// No 0/O/1/I so the code can be read aloud.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function tokenDays(env: Env): number {
  const n = Number(env.AGENT_TOKEN_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function newUserCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function normCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");
}

/** Called by the agent. Unauthenticated; returns a code for the human to approve in the browser. */
export async function deviceStart(env: Env, request: Request, deviceName: string) {
  const device_code = bytesToHex(randomBytes(32));
  const user_code = newUserCode();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM device_codes WHERE expires_at < ?").bind(Math.floor(now / 1000) - 3600),
    env.DB.prepare(
      "INSERT INTO device_codes (device_hash, user_code, device_name, status, expires_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    ).bind(
      await sha256Hex(device_code),
      user_code,
      deviceName.replace(/[^\w .@-]/g, "").slice(0, 60) || "agent",
      Math.floor(now / 1000) + CODE_TTL_SEC,
      new Date(now).toISOString(),
    ),
  ]);
  const origin = new URL(request.url).origin;
  return {
    device_code,
    user_code,
    verify_url: `${origin}/app?connect=${user_code}`,
    expires_in: CODE_TTL_SEC,
    interval: POLL_INTERVAL_SEC,
    token_days: tokenDays(env),
  };
}

/** Called by the agent while waiting. The token is handed out exactly once. */
export async function devicePoll(env: Env, deviceCode: string) {
  const hash = await sha256Hex(deviceCode);
  const row = await env.DB.prepare("SELECT * FROM device_codes WHERE device_hash = ?")
    .bind(hash)
    .first<{ status: string; user_id: string | null; token_enc: string | null; expires_at: number }>();
  if (!row) return { status: "expired" };
  if (row.expires_at < Math.floor(Date.now() / 1000)) return { status: "expired" };
  if (row.status === "denied") return { status: "denied" };
  if (row.status !== "approved" || !row.token_enc || !row.user_id) return { status: "pending" };

  const token = await decryptSecret(row.token_enc, env.DATA_KEY);
  await env.DB.prepare("DELETE FROM device_codes WHERE device_hash = ?").bind(hash).run();
  const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(row.user_id)
    .first<{ email: string }>();
  const key = await env.DB.prepare("SELECT expires_at FROM api_keys WHERE key_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ expires_at: string | null }>();
  return { status: "approved", token, email: user?.email ?? "", expires_at: key?.expires_at ?? null };
}

/** Browser: show who is asking before the human approves. */
export async function deviceInfo(env: Env, userCode: string) {
  const row = await env.DB.prepare(
    "SELECT device_name, status, expires_at, created_at FROM device_codes WHERE user_code = ?",
  )
    .bind(normCode(userCode))
    .first<{ device_name: string; status: string; expires_at: number; created_at: string }>();
  if (!row || row.expires_at < Math.floor(Date.now() / 1000)) throw new HttpError(404, "This code is invalid or expired");
  return { device_name: row.device_name, status: row.status, created_at: row.created_at, token_days: tokenDays(env) };
}

/** Browser: the signed-in human approves or denies. Agent tokens can never approve themselves. */
export async function deviceDecide(env: Env, auth: AuthContext, userCode: string, approve: boolean) {
  if (auth.via !== "session") throw new HttpError(403, "Approve from the browser, not with an agent token");
  const code = normCode(userCode);
  const row = await env.DB.prepare("SELECT * FROM device_codes WHERE user_code = ?")
    .bind(code)
    .first<{ device_hash: string; device_name: string; status: string; expires_at: number }>();
  if (!row || row.expires_at < Math.floor(Date.now() / 1000)) throw new HttpError(404, "This code is invalid or expired");
  if (row.status !== "pending") throw new HttpError(409, "This code was already used");

  if (!approve) {
    await env.DB.prepare("UPDATE device_codes SET status = 'denied' WHERE device_hash = ?").bind(row.device_hash).run();
    await audit(env.DB, auth.user.id, "agent.deny", { device: row.device_name });
    return { ok: true };
  }
  const key = await createApiKey(env, auth.user.id, `agent: ${row.device_name}`, {
    kind: "agent",
    days: tokenDays(env),
  });
  await env.DB.prepare(
    "UPDATE device_codes SET status = 'approved', user_id = ?, token_enc = ? WHERE device_hash = ?",
  )
    .bind(auth.user.id, await encryptSecret(key.token, env.DATA_KEY), row.device_hash)
    .run();
  await audit(env.DB, auth.user.id, "agent.approve", { device: row.device_name, expires_at: key.expires_at });
  return { ok: true, expires_at: key.expires_at };
}
