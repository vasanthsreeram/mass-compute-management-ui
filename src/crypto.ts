const encoder = new TextEncoder();

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(digest);
}

export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = hexToBytes(saltHex);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    key,
    256,
  );
  return bytesToHex(bits);
}

export function newSalt(): string {
  return bytesToHex(randomBytes(16));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, secret: string): Promise<string> {
  const iv = randomBytes(12);
  const key = await aesKey(secret);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plain));
  return `${bytesToHex(iv)}:${bytesToHex(ct)}`;
}

export async function decryptSecret(packed: string, secret: string): Promise<string> {
  const [ivHex, ctHex] = packed.split(":");
  if (!ivHex || !ctHex) throw new Error("bad ciphertext");
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(ivHex) },
    key,
    hexToBytes(ctHex),
  );
  return new TextDecoder().decode(pt);
}
