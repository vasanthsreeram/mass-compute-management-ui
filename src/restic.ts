import { quotaFor, vmAuth } from "./backup";

/**
 * restic REST server API v2 on the BACKUPS R2 bucket, at /restic/<user_id>/…, keys restic/<user_id>/….
 * Auth is HTTP Basic with the VM credential; the credential only works for its own user's prefix.
 * Sizes are tracked in D1 (backup_objects / backup_usage), which also serves the list calls, so a
 * `restic backup` never has to page through R2. Quota is checked atomically before every write.
 */

/** Workers cap request bodies at 100 MB; stay under it. restic packs are 16-32 MB with --pack-size 32. */
export const MAX_OBJECT_BYTES = 95 * 1024 * 1024;
const TYPES = new Set(["data", "keys", "locks", "snapshots", "index"]);
const ID_RE = /^[0-9a-f]{64}$/;

const reply = (status: number, body: BodyInit | null = null, headers: Record<string, string> = {}) => new Response(body, { status, headers });
const fail = (status: number, message: string, code: string) =>
  reply(status, JSON.stringify({ error: message, code }), { "Content-Type": "application/json" });

function objectKey(userId: string, parts: string[]): string | null {
  if (parts.length === 1 && parts[0] === "config") return `restic/${userId}/config`;
  if (parts.length === 2 && TYPES.has(parts[0]) && ID_RE.test(parts[1])) return `restic/${userId}/${parts[0]}/${parts[1]}`;
  return null;
}

export async function handleRestic(env: Env, request: Request): Promise<Response> {
  if (!env.BACKUPS) return fail(503, "Backups are not enabled on this desk", "backups_disabled");
  const url = new URL(request.url);
  const [, , userId, ...parts] = url.pathname.split("/").filter((p, i) => i < 2 || p !== "").map(decodeURIComponent);
  const auth = await vmAuth(env, request);
  if (!auth) return reply(401, null, { "WWW-Authenticate": 'Basic realm="gpu-proxy restic"' });
  if (!userId || auth.userId !== userId) return fail(403, "This credential cannot access that repository", "wrong_prefix");

  const method = request.method;
  // POST /restic/<user>/?create=true (restic init). The repository is just a prefix, so there is nothing to make.
  if (!parts.length) return method === "POST" || method === "HEAD" || method === "GET" ? reply(200) : reply(405);

  // List: GET /restic/<user>/<type>/
  if (parts.length === 1 && TYPES.has(parts[0]) && method === "GET") return list(env, userId, parts[0], request);

  const key = objectKey(userId, parts);
  if (!key) return fail(404, "Not found", "not_found");

  if (method === "HEAD" || method === "GET") {
    const range = request.headers.get("Range");
    if (method === "HEAD") {
      const head = await env.BACKUPS.head(key);
      return head ? reply(200, null, { "Content-Length": String(head.size), "Accept-Ranges": "bytes" }) : reply(404);
    }
    const obj = await env.BACKUPS.get(key, range ? { range: request.headers } : undefined);
    if (!obj) return reply(404);
    const h: Record<string, string> = { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes" };
    if (range && obj.range) {
      const r = obj.range as { offset?: number; length?: number; suffix?: number };
      const offset = r.suffix !== undefined ? Math.max(0, obj.size - r.suffix) : r.offset ?? 0;
      const length = r.suffix !== undefined ? Math.min(r.suffix, obj.size) : r.length ?? obj.size - offset;
      h["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${obj.size}`;
      h["Content-Length"] = String(length);
      return reply(206, (obj as R2ObjectBody).body, h);
    }
    h["Content-Length"] = String(obj.size);
    return reply(200, (obj as R2ObjectBody).body, h);
  }

  if (method === "POST") return put(env, userId, key, parts[0] === "config", request);
  if (method === "DELETE") return remove(env, userId, key);
  return reply(405);
}

async function list(env: Env, userId: string, type: string, request: Request): Promise<Response> {
  const prefix = `restic/${userId}/${type}/`;
  const rows = await env.DB.prepare("SELECT key, size FROM backup_objects WHERE user_id = ? AND key >= ? AND key < ? ORDER BY key")
    .bind(userId, prefix, `${prefix}\u{10ffff}`)
    .all<{ key: string; size: number }>();
  const items = (rows.results ?? []).map((r) => ({ name: r.key.slice(prefix.length), size: r.size }));
  const v2 = (request.headers.get("Accept") ?? "").includes("application/vnd.x.restic.rest.v2");
  return reply(200, JSON.stringify(v2 ? items : items.map((i) => i.name)), {
    "Content-Type": v2 ? "application/vnd.x.restic.rest.v2" : "application/json",
  });
}

async function put(env: Env, userId: string, key: string, isConfig: boolean, request: Request): Promise<Response> {
  const size = Number(request.headers.get("Content-Length"));
  if (!request.headers.has("Content-Length") || !Number.isInteger(size) || size < 0) return fail(411, "Content-Length required", "length_required");
  if (size > MAX_OBJECT_BYTES) return fail(413, `Object larger than ${MAX_OBJECT_BYTES} bytes; use --pack-size 32 or less`, "too_large");

  const old = await env.DB.prepare("SELECT size FROM backup_objects WHERE key = ?").bind(key).first<{ size: number }>();
  // The repository config holds the key check; never overwrite it.
  if (isConfig && old) return fail(403, "Repository already initialised", "exists");
  const delta = size - (old?.size ?? 0);
  const now = new Date().toISOString();
  const quota = await quotaFor(env, userId);

  await env.DB.prepare("INSERT OR IGNORE INTO backup_usage (user_id, used_bytes, updated_at) VALUES (?, 0, ?)").bind(userId, now).run();
  // Atomic reserve: the UPDATE only applies while the new total fits inside the quota.
  const reserve = await env.DB.prepare("UPDATE backup_usage SET used_bytes = used_bytes + ?1, updated_at = ?2 WHERE user_id = ?3 AND used_bytes + ?1 <= ?4")
    .bind(delta, now, userId, quota)
    .run();
  if (!reserve.meta.changes) {
    console.log(JSON.stringify({ message: "restic quota", userId, key, size, quota }));
    return fail(507, "Backup quota exceeded. Delete old data or ask an admin for more space.", "quota_exceeded");
  }

  try {
    let body: ReadableStream | string = "";
    if (size > 0 && request.body) {
      const fixed = new FixedLengthStream(size);
      request.body.pipeTo(fixed.writable).catch(() => {});
      body = fixed.readable;
    }
    const stored = await env.BACKUPS.put(key, body);
    if (stored?.size !== size) throw new Error(`stored ${stored?.size} bytes, expected ${size}`);
  } catch (e) {
    await env.DB.prepare("UPDATE backup_usage SET used_bytes = MAX(0, used_bytes - ?) WHERE user_id = ?").bind(delta, userId).run();
    console.error(JSON.stringify({ message: "restic put failed", userId, key, size, error: e instanceof Error ? e.message : String(e) }));
    return fail(500, "Upload failed", "upload_failed");
  }
  await env.DB.prepare(
    "INSERT INTO backup_objects (key, user_id, size, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET size = excluded.size, updated_at = excluded.updated_at",
  )
    .bind(key, userId, size, now)
    .run();
  console.log(JSON.stringify({ message: "restic put", userId, key, size, delta }));
  return reply(200);
}

async function remove(env: Env, userId: string, key: string): Promise<Response> {
  const old = await env.DB.prepare("SELECT size FROM backup_objects WHERE key = ?").bind(key).first<{ size: number }>();
  const head = await env.BACKUPS.head(key);
  if (!head && !old) return reply(404);
  await env.BACKUPS.delete(key);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM backup_objects WHERE key = ?").bind(key),
    env.DB.prepare("UPDATE backup_usage SET used_bytes = MAX(0, used_bytes - ?), updated_at = ? WHERE user_id = ?").bind(old?.size ?? head?.size ?? 0, new Date().toISOString(), userId),
  ]);
  console.log(JSON.stringify({ message: "restic delete", userId, key, size: old?.size ?? head?.size ?? 0 }));
  return reply(200);
}
