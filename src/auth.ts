import { HttpError } from "./policy";
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

const OTP_TTL_SEC = 600;
const OTP_MAX_ATTEMPTS = 5;
const DEMO_EMAIL = "demo@massedui.vasanth.cloud";

type Invite = {
  email: string;
  role: "user" | "admin";
  credit_cents: number;
  max_concurrent: number;
  allowed_gpus: string;
};

function normEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Invalid email");
  return email;
}

function isMock(env: Env): boolean {
  return env.MOCK_MASSED === "1";
}

async function otpHash(email: string, code: string): Promise<string> {
  return sha256Hex(`${email}:${code}`);
}

function randomCode(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1_000_000).padStart(6, "0");
}

async function sendOtpEmail(env: Env, email: string, code: string, purpose: "signup" | "admin" = "signup"): Promise<void> {
  const from = env.MAIL_FROM || "noreply@massedui.vasanth.cloud";
  if (!env.EMAIL) throw new HttpError(503, "Email is not configured on this proxy");
  const what = purpose === "admin" ? "admin sign-in code" : "verification code";
  await env.EMAIL.send({
    to: email,
    from: { email: from, name: "Massed Compute desk" },
    subject: `Your ${what}: ${code}`,
    text: `Your Massed Compute desk ${what} is ${code}.\n\nIt expires in 10 minutes. If you did not request it, ignore this email.`,
    html: `<p>Your Massed Compute desk ${what} is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you did not request it, ignore this email.</p>`,
  });
}

/** Fixed-window limiter. Throws 429 once `limit` hits inside `windowSec`. */
export async function throttle(env: Env, key: string, limit: number, windowSec: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT window_start, count FROM rate_limits WHERE key = ?")
    .bind(key)
    .first<{ window_start: number; count: number }>();
  if (!row || now - row.window_start >= windowSec) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 86_400),
      env.DB.prepare("INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)").bind(key, now),
    ]);
    return;
  }
  if (row.count >= limit) {
    const mins = Math.max(1, Math.ceil((windowSec - (now - row.window_start)) / 60));
    throw new HttpError(429, `Too many code requests. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.`, "rate_limited");
  }
  await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").bind(key).run();
}

const CODE_MIN_GAP_SEC = 30;
async function checkCodeRequest(env: Env, email: string, ip: string): Promise<void> {
  const recent = await env.DB.prepare("SELECT created_at FROM signup_otps WHERE email = ?").bind(email).first<{ created_at: string }>();
  if (recent && Date.now() - Date.parse(recent.created_at) < CODE_MIN_GAP_SEC * 1000) {
    throw new HttpError(429, "A code was just sent. Wait half a minute before asking for another.", "rate_limited");
  }
  await throttle(env, `otp:email:${email}`, 5, 3600);
  await throttle(env, `otp:ip:${ip}`, 20, 3600);
}

/** Step 1: email must be whitelisted. Stores the pending password and emails a 6-digit code. */
export async function startSignup(
  env: Env,
  emailRaw: string,
  password: string,
  ip = "unknown",
): Promise<{ sent: true; dev_code?: string }> {
  const email = normEmail(emailRaw);
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  if (await getUserByEmail(env.DB, email)) throw new HttpError(409, "Email already registered");

  const bootstrap =
    (await userCount(env.DB)) === 0 ||
    (env.ADMIN_EMAIL && email === env.ADMIN_EMAIL.trim().toLowerCase());
  const invite = await env.DB.prepare("SELECT email FROM invites WHERE email = ?").bind(email).first();
  if (!invite && !bootstrap) {
    throw new HttpError(403, "This email has not been invited. Ask a team admin to add it.");
  }

  await checkCodeRequest(env, email, ip);
  const code = randomCode();
  const salt = newSalt();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO signup_otps (email, code_hash, password_hash, salt, expires_at, attempts, created_at, purpose)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'signup')`,
  )
    .bind(
      email,
      await otpHash(email, code),
      await hashPassword(password, salt),
      salt,
      Math.floor(Date.now() / 1000) + OTP_TTL_SEC,
      new Date().toISOString(),
    )
    .run();

  if (isMock(env)) {
    console.log(JSON.stringify({ message: "dev otp", email, code }));
    return { sent: true, dev_code: code };
  }
  await sendOtpEmail(env, email, code);
  await audit(env.DB, null, "signup.otp_sent", { email });
  return { sent: true };
}

/** Step 2: verify the code, then create the account with the invite's role and budget. */
export async function finishSignup(env: Env, emailRaw: string, code: string): Promise<UserRow> {
  const email = normEmail(emailRaw);
  const row = await env.DB.prepare("SELECT * FROM signup_otps WHERE email = ?")
    .bind(email)
    .first<{ code_hash: string; password_hash: string; salt: string; expires_at: number; attempts: number; purpose: string }>();
  if (!row || row.purpose !== "signup" || row.expires_at < Math.floor(Date.now() / 1000)) {
    throw new HttpError(400, "Code expired. Request a new one.");
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, "Too many attempts. Request a new code.");
  const ok = await timingSafeEqualStr(await otpHash(email, code.trim()), row.code_hash);
  if (!ok) {
    await env.DB.prepare("UPDATE signup_otps SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    throw new HttpError(400, "Wrong code");
  }
  if (await getUserByEmail(env.DB, email)) throw new HttpError(409, "Email already registered");

  const invite = await env.DB.prepare("SELECT * FROM invites WHERE email = ?").bind(email).first<Invite>();
  const first = (await userCount(env.DB)) === 0;
  const bootstrap = first || (env.ADMIN_EMAIL && email === env.ADMIN_EMAIL.trim().toLowerCase());
  if (!invite && !bootstrap) throw new HttpError(403, "This email has not been invited.");

  const admin = email !== DEMO_EMAIL && (bootstrap || invite?.role === "admin");
  const user: UserRow = {
    id: crypto.randomUUID(),
    email,
    password_hash: row.password_hash,
    salt: row.salt,
    role: admin ? "admin" : "user",
    credit_cents: invite?.credit_cents ?? 0,
    spent_cents: 0,
    allowed_gpus: admin ? JSON.stringify(["*"]) : invite?.allowed_gpus ?? JSON.stringify([]),
    max_concurrent: email === DEMO_EMAIL ? 0 : admin ? Math.max(8, invite?.max_concurrent ?? 8) : invite?.max_concurrent ?? 1,
    created_at: new Date().toISOString(),
  };
  await insertUser(env.DB, user);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM signup_otps WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM invites WHERE email = ?").bind(email),
  ]);
  await audit(env.DB, user.id, "register", { admin, invited: !!invite });
  return user;
}

const ADMIN_REFUSAL = "This email isn't set up as a lab admin. Ask an existing admin to invite it.";

function isBootstrapEmail(env: Env, email: string): boolean {
  return !!env.ADMIN_EMAIL && email === env.ADMIN_EMAIL.trim().toLowerCase();
}

/**
 * Admin sign-in, step 1: email a one-time code. Eligible emails are an existing admin, the bootstrap first
 * user / ADMIN_EMAIL, or an email an admin invited with the admin role. Same disclosure as member sign-up:
 * a refusal tells the caller the address is not an admin here, nothing more.
 */
export async function startAdminLogin(env: Env, emailRaw: string, ip = "unknown"): Promise<{ sent: true; dev_code?: string }> {
  const email = normEmail(emailRaw);
  if (email === DEMO_EMAIL) throw new HttpError(403, ADMIN_REFUSAL, "not_admin");
  const user = await getUserByEmail(env.DB, email);
  if (user) {
    if (user.role !== "admin") throw new HttpError(403, "This account is a lab member. Choose “I'm a lab member” and sign in with your password.", "not_admin");
  } else {
    const invite = await env.DB.prepare("SELECT role FROM invites WHERE email = ?").bind(email).first<{ role: string }>();
    const bootstrap = (await userCount(env.DB)) === 0 || isBootstrapEmail(env, email);
    if (!bootstrap && invite?.role !== "admin") throw new HttpError(403, ADMIN_REFUSAL, "not_admin");
  }

  await checkCodeRequest(env, email, ip);
  const code = randomCode();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO signup_otps (email, code_hash, password_hash, salt, expires_at, attempts, created_at, purpose)
     VALUES (?, ?, '', '', ?, 0, ?, 'admin')`,
  )
    .bind(email, await otpHash(email, code), Math.floor(Date.now() / 1000) + OTP_TTL_SEC, new Date().toISOString())
    .run();

  if (isMock(env)) {
    console.log(JSON.stringify({ message: "dev admin otp", email, code }));
    return { sent: true, dev_code: code };
  }
  await sendOtpEmail(env, email, code, "admin");
  await audit(env.DB, user?.id ?? null, "admin.login_code_sent", { email });
  return { sent: true };
}

/** Admin sign-in, step 2: check the code, then sign in (creating the admin account for a bootstrap or invited email). */
export async function finishAdminLogin(env: Env, emailRaw: string, code: string): Promise<UserRow> {
  const email = normEmail(emailRaw);
  const row = await env.DB.prepare("SELECT * FROM signup_otps WHERE email = ?")
    .bind(email)
    .first<{ code_hash: string; expires_at: number; attempts: number; purpose: string }>();
  if (!row || row.purpose !== "admin" || row.expires_at < Math.floor(Date.now() / 1000)) {
    throw new HttpError(400, "Code expired. Request a new one.");
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, "Too many attempts. Request a new code.", "rate_limited");
  if (!(await timingSafeEqualStr(await otpHash(email, code.trim()), row.code_hash))) {
    await env.DB.prepare("UPDATE signup_otps SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    throw new HttpError(400, "Wrong code");
  }

  let user = await getUserByEmail(env.DB, email);
  if (user && user.role !== "admin") throw new HttpError(403, ADMIN_REFUSAL, "not_admin");
  if (!user) {
    // Re-check eligibility: the invite may have been revoked between the two steps.
    const invite = await env.DB.prepare("SELECT role FROM invites WHERE email = ?").bind(email).first<{ role: string }>();
    const bootstrap = (await userCount(env.DB)) === 0 || isBootstrapEmail(env, email);
    if (!bootstrap && invite?.role !== "admin") throw new HttpError(403, ADMIN_REFUSAL, "not_admin");
    user = {
      id: crypto.randomUUID(),
      email,
      // No password: '!' is not a valid hash, so password login can never succeed for this account.
      password_hash: "!",
      salt: "!",
      role: "admin",
      credit_cents: 0,
      spent_cents: 0,
      allowed_gpus: JSON.stringify(["*"]),
      max_concurrent: 8,
      created_at: new Date().toISOString(),
    };
    await insertUser(env.DB, user);
    await env.DB.prepare("DELETE FROM invites WHERE email = ?").bind(email).run();
    await audit(env.DB, user.id, "register", { admin: true, via: "email_code" });
  }
  await env.DB.prepare("DELETE FROM signup_otps WHERE email = ?").bind(email).run();
  await audit(env.DB, user.id, "admin.login", { via: "email_code" });
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
  opts: { kind?: string; days?: number } = {},
): Promise<{ id: string; token: string; prefix: string; expires_at: string | null }> {
  const secret = bytesToHex(randomBytes(24));
  const token = `gpk_${secret}`;
  const prefix = token.slice(0, 11);
  const key_hash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const expires_at = opts.days ? new Date(Date.now() + opts.days * 86_400_000).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, created_at, expires_at, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, name.slice(0, 80) || "default", prefix, key_hash, new Date().toISOString(), expires_at, opts.kind ?? "manual")
    .run();
  await audit(env.DB, userId, "api_key.create", { id, prefix, kind: opts.kind ?? "manual", expires_at });
  return { id, token, prefix, expires_at };
}

async function userFromApiKey(env: Env, request: Request): Promise<{ user: UserRow; keyId: string } | null> {
  const header = request.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(gpk_[A-Za-z0-9_-]+)$/i);
  if (!m) return null;
  const token = m[1];
  const key_hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT id, user_id, expires_at FROM api_keys WHERE key_hash = ?")
    .bind(key_hash)
    .first<{ id: string; user_id: string; expires_at: string | null }>();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
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
