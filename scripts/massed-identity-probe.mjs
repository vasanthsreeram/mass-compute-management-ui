#!/usr/bin/env node
// Finds out what stable account identifier Massed gives an OAuth client.
//
//   node scripts/massed-identity-probe.mjs [port]
//
// 1. registers a throwaway public client for http://127.0.0.1:<port>/cb (read-only scope mcp:read)
// 2. prints the authorize URL; open it while signed in to Massed and click Allow
// 3. catches the code on the loopback redirect and exchanges it (PKCE S256)
// 4. prints: discovery keys, token-response field names, decoded JWT claims (if the token is a JWT),
//    userinfo/introspection probes, and every identity-looking field MCP returns
// 5. revokes the token
// Raw tokens are never printed. Values are printed only for identity-looking keys (id, email, name, account, user, team, owner, uuid, sub).
import http from "node:http";
import crypto from "node:crypto";

const ORIGIN = process.env.MASSED_ORIGIN || "https://vm.massedcompute.com";
const PORT = Number(process.argv[2]) || 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/cb`;
const UA = "MassComputeManagementUI-identity-probe/1.0";
const IDENT = /(^|_)(id|uuid|sub|email|name|account|user|team|owner|org|customer|tenant|member)s?($|_)|userid|accountid|teamid|ownerid/i;
const SECRET = /token|secret|password|key$/i;
const b64u = (b) => Buffer.from(b).toString("base64url");

function walk(v, path, out, depth = 0) {
  if (depth > 5 || v == null) return;
  if (Array.isArray(v)) return v.slice(0, 2).forEach((x, i) => walk(x, `${path}[${i}]`, out, depth + 1));
  if (typeof v !== "object") return;
  for (const [k, val] of Object.entries(v)) {
    const p = path ? `${path}.${k}` : k;
    if (val && typeof val === "object") walk(val, p, out, depth + 1);
    else if (IDENT.test(k) && !SECRET.test(k)) out.push(`${p} = ${JSON.stringify(val)}`);
    else out.push(`${p}  (${typeof val})`);
  }
}
const fields = (v) => { const o = []; walk(v, "", o); return o; };
const show = (title, lines) => { console.log(`\n== ${title}`); (Array.isArray(lines) ? lines : [lines]).forEach((l) => console.log("  " + l)); };

async function json(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers || {}) }, redirect: "manual" });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body, text, location: res.headers.get("location") };
}

// --- discovery
const disc = await json(`${ORIGIN}/.well-known/oauth-authorization-server`);
show("discovery (oauth-authorization-server)", disc.body ? Object.keys(disc.body).map((k) => `${k}${/userinfo|introspect|jwks|openid/i.test(k) ? "   <-- identity-relevant" : ""}`) : `HTTP ${disc.status}`);
if (disc.body?.userinfo_endpoint) console.log("  userinfo_endpoint:", disc.body.userinfo_endpoint);
for (const p of ["/.well-known/openid-configuration", "/.well-known/jwks.json"]) {
  const r = await json(`${ORIGIN}${p}`); show(`GET ${p}`, `HTTP ${r.status}${r.body ? " keys: " + Object.keys(r.body).join(",") : ""}`);
}

// --- register + authorize
const reg = await json(`${ORIGIN}/api/oauth/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_name: "Mass Compute Management UI (identity probe)", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "mcp:read" }),
});
if (!reg.body?.client_id) { console.error("registration failed", reg.status, reg.text.slice(0, 200)); process.exit(1); }
show("client registration response fields", fields(reg.body));
const verifier = b64u(crypto.randomBytes(48));
const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
const state = crypto.randomBytes(16).toString("hex");
const url = new URL(`${ORIGIN}/oauth/authorize`);
for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, scope: "mcp:read", code_challenge: challenge, code_challenge_method: "S256", state })) url.searchParams.set(k, v);
console.log(`\nOPEN THIS URL (signed in to Massed) AND CLICK ALLOW (read-only):\n${url}\n\nWaiting on ${REDIRECT} for up to 10 minutes...`);

const code = await new Promise((resolve, reject) => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, REDIRECT);
    if (u.pathname !== "/cb") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Got it. You can close this tab.");
    srv.close();
    if (u.searchParams.get("state") !== state) return reject(new Error("state mismatch"));
    if (u.searchParams.get("error")) return reject(new Error(u.searchParams.get("error")));
    resolve(u.searchParams.get("code"));
  }).listen(PORT, "127.0.0.1");
  setTimeout(() => reject(new Error("timed out")), 600_000);
});

// --- exchange
const tok = await json(`${ORIGIN}/api/oauth/token`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.body.client_id, code_verifier: verifier }),
});
if (!tok.body?.access_token) { console.error("token exchange failed", tok.status, tok.text.slice(0, 200)); process.exit(1); }
const t = tok.body;
show("token response: field names (token values are never printed)", Object.keys(t).map((k) => (SECRET.test(k) ? `${k}  (secret, length ${String(t[k]).length})` : `${k} = ${JSON.stringify(t[k])}`)));

function jwt(label, raw) {
  const parts = String(raw).split(".");
  if (parts.length !== 3) return show(label, `opaque (not a JWT), ${String(raw).length} chars`);
  try {
    const dec = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    show(`${label}: JWT header`, fields(dec(parts[0])));
    show(`${label}: JWT claims`, fields(dec(parts[1])));
  } catch { show(label, "looks like a JWT but did not decode"); }
}
jwt("access_token", t.access_token);
if (t.id_token) jwt("id_token", t.id_token);
if (t.refresh_token) jwt("refresh_token", t.refresh_token);

// --- identity-ish endpoints
const auth = { Authorization: `Bearer ${t.access_token}` };
for (const p of [disc.body?.userinfo_endpoint, `${ORIGIN}/api/oauth/userinfo`, `${ORIGIN}/oauth/userinfo`, `${ORIGIN}/api/userinfo`, `${ORIGIN}/api/auth/session`, `${ORIGIN}/api/me`].filter(Boolean)) {
  const r = await json(p, { headers: auth }); show(`GET ${p.replace(ORIGIN, "")}`, `HTTP ${r.status}${r.body ? "  " + fields(r.body).join("; ").slice(0, 400) : ""}`);
}
const ins = await json(`${ORIGIN}/api/oauth/introspect`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t.access_token, client_id: reg.body.client_id }) });
show("POST /api/oauth/introspect", `HTTP ${ins.status}${ins.body ? "  " + fields(ins.body).join("; ").slice(0, 400) : ""}`);

// --- MCP
let id = 1;
const rpc = async (method, params) => {
  const r = await fetch(`${ORIGIN}/api/mcp`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": UA }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
  const text = await r.text(); const line = text.startsWith("event:") || text.startsWith("data:") ? (text.split("\n").find((l) => l.startsWith("data:")) || "").slice(5) : text;
  try { return JSON.parse(line); } catch { return { error: { message: `HTTP ${r.status}` } }; }
};
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "identity-probe", version: "1" } });
show("MCP initialize: serverInfo + result keys", [...fields(init.result?.serverInfo ?? {}), "result keys: " + Object.keys(init.result ?? {}).join(",")]);
const instr = String(init.result?.instructions ?? "");
show("MCP initialize.instructions lines that mention account/user/email/team", instr.split("\n").filter((l) => /account|user|email|team|owner|org/i.test(l)).slice(0, 8).map((l) => l.slice(0, 200)).concat(instr ? [] : ["(no instructions)"]));
for (const tool of ["account_token_validation", "account_billing", "ssh_keys_list", "instances_list"]) {
  const r = await rpc("tools/call", { name: tool, arguments: {} });
  const v = r.result?.structuredContent ?? (() => { try { return JSON.parse(r.result?.content?.[0]?.text); } catch { return r.result?.content?.[0]?.text; } })();
  show(`MCP ${tool}`, r.error ? `error: ${r.error.message}` : typeof v === "object" ? fields(v) : String(v).slice(0, 200));
}

// --- clean up
for (const [tk, hint] of [[t.refresh_token, "refresh_token"], [t.access_token, "access_token"]]) {
  if (!tk) continue;
  const r = await fetch(`${ORIGIN}/api/oauth/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tk, client_id: reg.body.client_id, token_type_hint: hint }) });
  console.log(`\nrevoked ${hint}: HTTP ${r.status}`);
}
console.log("\nDone. Nothing was written to disk.");
