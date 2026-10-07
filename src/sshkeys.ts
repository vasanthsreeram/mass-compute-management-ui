import { audit } from "./db";
import { HttpError } from "./policy";

const KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+([A-Za-z0-9+/]+={0,3})(?:\s+(.*))?$/;
const MAX_KEYS = 10;

export type SshKeyRow = { id: string; name: string; public_key: string; fingerprint: string; created_at: string };

async function fingerprint(b64: string): Promise<string> {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let s = "";
  for (const b of digest) s += String.fromCharCode(b);
  return `SHA256:${btoa(s).replace(/=+$/, "")}`;
}

/** Accepts one OpenSSH public key line and returns it normalized with its fingerprint. */
export async function parsePublicKey(raw: string): Promise<{ key: string; fingerprint: string }> {
  const line = raw.trim();
  if (line.includes("\n") || line.includes("PRIVATE KEY")) {
    throw new HttpError(400, "Paste a single public key line (the .pub file), never a private key.", "bad_ssh_key");
  }
  const m = KEY_RE.exec(line);
  if (!m) {
    throw new HttpError(400, "That is not an SSH public key. It should start with ssh-ed25519, ssh-rsa or ecdsa-sha2-.", "bad_ssh_key");
  }
  try {
    return { key: `${m[1]} ${m[2]}${m[3] ? ` ${m[3].trim()}` : ""}`, fingerprint: await fingerprint(m[2]) };
  } catch {
    throw new HttpError(400, "That SSH public key is not valid base64.", "bad_ssh_key");
  }
}

export async function listSshKeys(env: Env, userId: string): Promise<SshKeyRow[]> {
  const rows = await env.DB.prepare(
    "SELECT id, name, public_key, fingerprint, created_at FROM user_ssh_keys WHERE user_id = ? ORDER BY created_at DESC",
  )
    .bind(userId)
    .all<SshKeyRow>();
  return rows.results ?? [];
}

export async function addSshKey(env: Env, userId: string, name: string, publicKey: string): Promise<SshKeyRow> {
  const { key, fingerprint: fp } = await parsePublicKey(publicKey);
  if ((await listSshKeys(env, userId)).length >= MAX_KEYS) throw new HttpError(400, `At most ${MAX_KEYS} keys per person`);
  const dup = await env.DB.prepare("SELECT id FROM user_ssh_keys WHERE user_id = ? AND fingerprint = ?").bind(userId, fp).first();
  if (dup) throw new HttpError(409, "You already saved that key");
  const row: SshKeyRow = {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 60) || "key",
    public_key: key,
    fingerprint: fp,
    created_at: new Date().toISOString(),
  };
  await env.DB.prepare(
    "INSERT INTO user_ssh_keys (id, user_id, name, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, userId, row.name, row.public_key, row.fingerprint, row.created_at)
    .run();
  await audit(env.DB, userId, "ssh_key.add", { id: row.id, fingerprint: fp });
  return row;
}

export async function deleteSshKey(env: Env, userId: string, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM user_ssh_keys WHERE id = ? AND user_id = ?").bind(id, userId).run();
  await audit(env.DB, userId, "ssh_key.delete", { id });
}
