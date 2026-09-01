import { hashPassword, newSalt, randomBytes, bytesToHex, sha256Hex, timingSafeEqualStr } from "./crypto";
import {
  audit,
  getUserByEmail,
  getUserById,
  insertUser,
  publicUser,
  userCount,
  type PublicUser,
  type UserRow,
} from "./db";

const SESSION_TTL_SEC = 60 * 60 * 24 * 14;
const COOKIE = "rl_session";

export type AuthContext = {
  user: UserRow;
  public: PublicUser;
  via: "session" | "api_key";
  apiKeyId?: string;
};

function cookieSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

export function sessionCookie(token: string, request: Request, maxAge = SESSION_TTL_SEC): string {
  const parts = [
    `${COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (cookieSecure(request)) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(request: Request): string {
  return sessionCookie("", request, 0);
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export async function registerUser(
  env: Env,
  emailRaw: string,
  password: string,
): Promise<UserRow> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid email");
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  if (await getUserByEmail(env.DB, email)) throw new Error("Email already registered");

  const n = await userCount(env.DB);
  const isFirst = n === 0;
  const isBootstrap = env.ADMIN_EMAIL && email === env.ADMIN_EMAIL.trim().toLowerCase();
  const isDemo = email === "demo@massedui.vasanth.cloud";
  const admin = !isDemo && (isFirst || isBootstrap);
  const salt = newSalt();
  const password_hash = await hashPassword(password, salt);
  const user: UserRow = {
    id: crypto.randomUUID(),
    email,
    password_hash,
    salt,
    role: admin ? "admin" : "user",
    credit_cents: 0,
    spent_cents: 0,
    allowed_gpus: admin ? JSON.stringify(["*"]) : JSON.stringify([]),
    max_concurrent: isDemo ? 0 : admin ? 8 : 1,
    created_at: new Date().toISOString(),
  };
  await insertUser(env.DB, user);
  await audit(env.DB, user.id, "register", { admin });
  return user;
}

export async function loginUser(env: Env, emailRaw: string, password: string): Promise<UserRow> {
  const user = await getUserByEmail(env.DB, emailRaw.trim().toLowerCase());
  if (!user) throw new Error("Invalid email or password");
  const hash = await hashPassword(password, user.salt);
  if (!(await timingSafeEqualStr(hash, user.password_hash))) throw new Error("Invalid email or password");
  return user;
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const id = bytesToHex(randomBytes(32));
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, userId, expires, new Date().toISOString())
    .run();
  return id;
}

export async function destroySession(env: Env, request: Request): Promise<void> {
  const token = readCookie(request, COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(token).run();
}

async function userFromSession(env: Env, request: Request): Promise<UserRow | null> {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?",
  )
    .bind(token, Math.floor(Date.now() / 1000))
    .first<{ user_id: string }>();
  if (!row) return null;
  return getUserById(env.DB, row.user_id);
}

export async function createApiKey(
  env: Env,
  userId: string,
  name: string,
): Promise<{ id: string; token: string; prefix: string }> {
  const secret = bytesToHex(randomBytes(24));
  const token = `gpk_${secret}`;
  const prefix = token.slice(0, 11);
  const key_hash = await sha256Hex(token);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, name.slice(0, 80) || "default", prefix, key_hash, new Date().toISOString())
    .run();
  await audit(env.DB, userId, "api_key.create", { id, prefix });
  return { id, token, prefix };
}

async function userFromApiKey(env: Env, request: Request): Promise<{ user: UserRow; keyId: string } | null> {
  const header = request.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(gpk_[A-Za-z0-9_-]+)$/i);
  if (!m) return null;
  const token = m[1];
  const key_hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT id, user_id FROM api_keys WHERE key_hash = ?")
    .bind(key_hash)
    .first<{ id: string; user_id: string }>();
  if (!row) return null;
  const user = await getUserById(env.DB, row.user_id);
  if (!user) return null;
  await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), row.id)
    .run();
  return { user, keyId: row.id };
}

export async function requireAuth(env: Env, request: Request): Promise<AuthContext> {
  const key = await userFromApiKey(env, request);
  if (key) return { user: key.user, public: publicUser(key.user), via: "api_key", apiKeyId: key.keyId };
  const session = await userFromSession(env, request);
  if (session) return { user: session, public: publicUser(session), via: "session" };
  throw Object.assign(new Error("Unauthorized"), { status: 401 });
}

export async function requireAdmin(env: Env, request: Request): Promise<AuthContext> {
  const ctx = await requireAuth(env, request);
  if (ctx.user.role !== "admin") {
    throw Object.assign(new Error("Admin only"), { status: 403 });
  }
  return ctx;
}

export { publicUser };
