#!/usr/bin/env node
// Smoke test for the R2 backup loop against `wrangler dev --local` (miniflare D1 + R2, MOCK_MASSED=1).
//
//   node scripts/backup-smoke.mjs        (starts its own Worker on :8799 with a throwaway state dir)
//   BASE=http://localhost:8787 node scripts/backup-smoke.mjs   (use a running dev server; needs a fresh DB, MOCK_MASSED=1)
//
// Covers: enrollment token (single use, expiry), restic REST (PUT/GET/HEAD/DELETE/list/Range), cross-user
// denial, quota, heartbeat/backup-now, drain-before-kill (budget, stale agent, deadline), manual terminate.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import crypto from "node:crypto";

const PORT = 8799;
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
let failed = 0;
const ok = (cond, name, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let worker = null;
let dir = null;
async function start() {
  if (process.env.BASE) return;
  dir = mkdtempSync(join(tmpdir(), "gpu-proxy-smoke-"));
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "gpu-proxy", "--local", "--persist-to", dir], { stdio: "ignore" });
  worker = spawn("npx", ["wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", dir,
    "--var", "MOCK_MASSED:1", "--var", "DATA_KEY:smoke-data-key", "--var", "SESSION_SECRET:smoke-session", "--var", "ADMIN_EMAIL:"], { stdio: "ignore" });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error("worker did not start");
}

// ---- tiny client -------------------------------------------------------------------------------------------
const call = async (method, path, { cookie, body, headers = {}, raw } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch { /* binary or empty */ }
  return { status: res.status, json, buf, headers: res.headers, cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
};

async function signIn(email, admin) {
  if (admin) {
    const c = await call("POST", "/api/auth/admin/code", { body: { email } });
    return (await call("POST", "/api/auth/admin/verify", { body: { email, code: c.json.dev_code } })).cookie;
  }
  const c = await call("POST", "/api/auth/register", { body: { email, password: "password-123" } });
  return (await call("POST", "/api/auth/verify", { body: { email, code: c.json.dev_code } })).cookie;
}

const basic = (cred) => ({ Authorization: "Basic " + Buffer.from(`vm:${cred}`).toString("base64") });
const bearer = (cred) => ({ Authorization: `Bearer ${cred}` });
const hexId = () => crypto.randomBytes(32).toString("hex");

async function main() {
  await start();
  const admin = await signIn("admin@smoke.dev", true);
  const meAdmin = (await call("GET", "/api/me", { cookie: admin })).json.user;
  ok(meAdmin.role === "admin", "bootstrap admin signs in");
  await call("POST", "/api/team/invites", { cookie: admin, body: { email: "bob@smoke.dev", credit_cents: 1000, max_concurrent: 8 } });
  await call("POST", "/api/team/invites", { cookie: admin, body: { email: "eve@smoke.dev", credit_cents: 1000, max_concurrent: 2 } });
  const bob = await signIn("bob@smoke.dev", false);
  const eve = await signIn("eve@smoke.dev", false);
  const bobId = (await call("GET", "/api/me", { cookie: bob })).json.user.id;
  const eveId = (await call("GET", "/api/me", { cookie: eve })).json.user.id;

  const launch = async (cookie) => (await call("POST", "/api/instances", { cookie, body: { productName: "gpu_1x_a6000" } })).json.instance;
  const enroll = async (inst) => {
    const r = await call("POST", "/api/agent/enroll", { body: { token: inst.dev_enroll_token, hostname: "smoke" } });
    return r;
  };
  const detail = async (cookie, id) => (await call("GET", `/api/instances/${id}`, { cookie })).json.instance;
  const events = async (cookie) => (await call("GET", "/api/events?limit=200", { cookie })).json.events;
  const killEvent = async (cookie, id) => (await events(cookie)).find((e) => e.instance_id === id && (e.kind === "budget_kill" || e.kind === "terminate"));
  const tick = () => call("POST", "/api/admin/meter", { cookie: admin });
  const setCredit = (c) => call("PATCH", `/api/admin/users/${bobId}`, { cookie: admin, body: { credit_cents: c } });

  // ---- enrollment ----------------------------------------------------------------------------------------
  const vmA = await launch(bob);
  ok(!!vmA.dev_enroll_token && vmA.backup_state === "none", "launch mints an enrollment token (mock exposes it)");
  const enrA = await enroll(vmA);
  ok(enrA.status === 200 && /^rest:http:\/\/vm:vmc_/.test(enrA.json.repository) && enrA.json.password, "enroll returns repo URL + password", JSON.stringify(enrA.json));
  ok(enrA.json.repository.endsWith(`/restic/${bobId}/`), "repo URL is scoped to the member's prefix");
  ok((await enroll(vmA)).status === 403, "enrollment token cannot be used twice");
  ok((await detail(bob, vmA.id)).backup_state === "ok", "enrolled instance has backup_state ok");
  const vmB = await launch(bob);
  await call("POST", "/api/dev/backdate", { cookie: admin, body: { what: "enrollment", instance_id: vmB.id } });
  ok((await enroll(vmB)).status === 403, "expired enrollment token is refused");
  ok((await call("POST", "/api/agent/enroll", { body: { token: "gpe_" + "0".repeat(48) } })).status === 403, "unknown token is refused");
  const credA = enrA.json.credential;

  // ---- restic REST ---------------------------------------------------------------------------------------
  const R = `/restic/${bobId}`;
  const A = basic(credA);
  ok((await call("POST", `${R}/?create=true`, { headers: A, raw: "" })).status === 200, "restic init (?create=true)");
  ok((await call("HEAD", `${R}/config`, { headers: A })).status === 404, "HEAD /config before init is 404");
  ok((await call("POST", `${R}/config`, { headers: A, raw: Buffer.from("cfg-bytes") })).status === 200, "POST /config");
  ok((await call("POST", `${R}/config`, { headers: A, raw: Buffer.from("again") })).status === 403, "config cannot be overwritten");
  const id1 = hexId();
  const payload = crypto.randomBytes(1_000_000);
  ok((await call("POST", `${R}/data/${id1}`, { headers: A, raw: payload })).status === 200, "PUT 1 MB data blob");
  const got = await call("GET", `${R}/data/${id1}`, { headers: A });
  ok(got.status === 200 && got.buf.equals(payload), "GET returns the same bytes");
  const head = await call("HEAD", `${R}/data/${id1}`, { headers: A });
  ok(head.status === 200 && head.headers.get("content-length") === "1000000", "HEAD reports size", head.headers.get("content-length"));
  const rng = await call("GET", `${R}/data/${id1}`, { headers: { ...A, Range: "bytes=10-19" } });
  ok(rng.status === 206 && rng.buf.equals(payload.subarray(10, 20)) && rng.headers.get("content-range") === "bytes 10-19/1000000", "Range bytes=10-19", `${rng.status} ${rng.headers.get("content-range")}`);
  const suf = await call("GET", `${R}/data/${id1}`, { headers: { ...A, Range: "bytes=-5" } });
  ok(suf.status === 206 && suf.buf.equals(payload.subarray(payload.length - 5)), "Range suffix bytes=-5");
  const l2 = await call("GET", `${R}/data/`, { headers: { ...A, Accept: "application/vnd.x.restic.rest.v2" } });
  ok(JSON.stringify(l2.json) === JSON.stringify([{ name: id1, size: 1_000_000 }]), "list (v2) returns [{name,size}]", l2.buf.toString());
  const l1 = await call("GET", `${R}/data/`, { headers: A });
  ok(JSON.stringify(l1.json) === JSON.stringify([id1]), "list (v1) returns names");
  ok((await call("GET", `${R}/snapshots/`, { headers: { ...A, Accept: "application/vnd.x.restic.rest.v2" } })).json.length === 0, "empty snapshots list");
  ok((await call("GET", `${R}/data/${id1}`)).status === 401, "no credential is 401");
  ok((await call("GET", `${R}/data/${id1}`, { headers: basic("vmc_nope") })).status === 401, "bad credential is 401");
  ok((await call("GET", `${R}/data/${hexId()}`, { headers: A })).status === 404, "missing object is 404");
  ok((await call("POST", `${R}/data/not-hex`, { headers: A, raw: "x" })).status === 404, "bad object id is rejected");
  ok((await call("GET", `/restic/${eveId}/config`, { headers: A })).status === 403, "cross-user prefix is 403");
  ok((await call("POST", `/restic/${eveId}/data/${hexId()}`, { headers: A, raw: "x" })).status === 403, "cross-user write is 403");
  ok((await call("GET", `/restic/../${eveId}/config`, { headers: A })).status !== 200, "path tricks do not cross users");
  ok((await call("GET", "/api/backups", { cookie: bob })).json.used_bytes === 1_000_009, "used_bytes counts uploads");
  ok((await call("DELETE", `${R}/data/${id1}`, { headers: A })).status === 200 && (await call("GET", `${R}/data/${id1}`, { headers: A })).status === 404, "DELETE removes the object");
  ok((await call("GET", "/api/backups", { cookie: bob })).json.used_bytes === 9, "used_bytes drops on DELETE");

  // too large: stream 96 MB; the Worker must answer 413 from the Content-Length alone
  const big = await new Promise((resolve) => {
    const u = new URL(BASE);
    const len = 96 * 1024 * 1024;
    const req = http.request({ host: u.hostname, port: u.port, path: `${R}/data/${hexId()}`, method: "POST", headers: { ...A, "Content-Length": String(len) } }, (res) => { resolve(res.statusCode); res.resume(); });
    req.on("error", () => {});
    setTimeout(() => resolve(0), 30000);
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    (function write() { while (sent < len) { sent += chunk.length; if (!req.write(chunk)) return void req.once("drain", write); } req.end(); })();
  });
  ok(big === 413, "object over 95 MB is 413", String(big));

  // quota
  const q = await call("PATCH", `/api/admin/users/${bobId}/backup-quota`, { cookie: admin, body: { quota_bytes: 2_000_000 } });
  ok(q.json.quota_bytes === 2_000_000, "admin sets a per-member quota");
  ok((await call("POST", `${R}/data/${hexId()}`, { headers: A, raw: crypto.randomBytes(1_500_000) })).status === 200, "write inside quota");
  ok((await call("POST", `${R}/data/${hexId()}`, { headers: A, raw: crypto.randomBytes(1_000_000) })).status === 507, "write over quota is 507");
  const usage = (await call("GET", "/api/backups", { cookie: bob })).json;
  ok(usage.used_bytes === 1_500_009 && usage.quota_bytes === 2_000_000 && usage.est_monthly_cents > 0, "GET /api/backups reports used/quota/est", JSON.stringify(usage));
  const adm = (await call("GET", "/api/admin/backups", { cookie: admin })).json;
  ok(adm.members.find((m) => m.user_id === bobId)?.used_bytes === 1_500_009 && adm.default_quota_bytes === 5 * 1024 ** 3, "GET /api/admin/backups lists members");
  ok((await call("PATCH", "/api/admin/settings", { cookie: admin, body: { backup_default_quota_bytes: 7_000_000_000 } })).json.backup_default_quota_bytes === 7_000_000_000, "admin sets the default quota");

  // ---- heartbeat / backup now / report ---------------------------------------------------------------------
  const hb = await call("POST", "/api/agent/heartbeat", { headers: bearer(credA), body: {} });
  ok(hb.json.final_backup === false && hb.json.backup_now === false, "heartbeat: nothing requested");
  await call("POST", `/api/instances/${vmA.id}/backup`, { cookie: bob });
  ok((await call("POST", "/api/agent/heartbeat", { headers: bearer(credA), body: {} })).json.backup_now === true, "backup-now reaches the next heartbeat");
  ok((await call("POST", "/api/agent/heartbeat", { headers: bearer(credA), body: {} })).json.backup_now === false, "backup-now is delivered once");
  ok((await call("POST", `/api/instances/${vmB.id}/backup`, { cookie: bob })).status === 409, "backup-now on a VM without agent is 409");
  await call("POST", "/api/agent/backup", { headers: bearer(credA), body: { snapshot_id: "aaaa1111", bytes_added: 1500009, total_bytes: 3000000, tag: "task-end" } });
  const bk = (await call("GET", "/api/backups", { cookie: bob })).json;
  ok(bk.snapshots[0]?.snapshot_id === "aaaa1111" && bk.snapshots[0].tag === "task-end" && bk.machines.some((m) => m.instance_id === vmA.id && m.backup_state === "ok"), "backup report lands in /api/backups");
  ok((await call("POST", "/api/agent/heartbeat", { body: {} })).status === 401, "heartbeat needs the VM credential");

  // ---- drain: budget low -> final backup -> terminate ------------------------------------------------------
  await setCredit(5);
  const t1 = (await tick()).json;
  ok(t1.drained >= 1, "tick starts a drain for a low-budget member with an agent", JSON.stringify({ ...t1, watch: 0 }));
  ok((await detail(bob, vmA.id)).backup_state === "draining" && (await detail(bob, vmA.id)).status === "running", "VM keeps running while draining");
  const hb2 = await call("POST", "/api/agent/heartbeat", { headers: bearer(credA), body: {} });
  ok(hb2.json.final_backup === true, "heartbeat says final_backup:true while draining");
  const early = await call("POST", "/api/agent/final-done", { headers: bearer(credA), body: { snapshot_id: "x" } });
  ok(early.status === 409, "final-done without a new snapshot is refused", String(early.status));
  await call("POST", "/api/agent/backup", { headers: bearer(credA), body: { snapshot_id: "ffff0001", bytes_added: 10, total_bytes: 10, tag: "final" } });
  ok((await call("POST", "/api/agent/final-done", { headers: bearer(credA), body: { snapshot_id: "ffff0001" } })).json.terminating === true, "final-done accepted");
  for (let i = 0; i < 20 && (await detail(bob, vmA.id)).status !== "terminated"; i++) await sleep(300);
  const dA = await detail(bob, vmA.id);
  ok(dA.status === "terminated", "VM terminated after the final snapshot", dA.status);
  const evA = await killEvent(bob, vmA.id);
  ok(evA?.kind === "budget_kill" && JSON.parse(evA.detail).backup_before_kill === true && JSON.parse(evA.detail).snapshot_id === "ffff0001", "event records backup_before_kill:true + snapshot", JSON.stringify(evA));
  ok((await call("POST", "/api/agent/heartbeat", { headers: bearer(credA), body: {} })).status === 401, "credential stops working after terminate");
  ok((await call("GET", `${R}/config`, { headers: A })).status === 401, "restic access stops after terminate");

  // ---- drain: deadline, stale agent, no agent --------------------------------------------------------------
  await setCredit(1000);
  const vmD = await launch(bob);
  const credD = (await enroll(vmD)).json.credential;
  const vmC = await launch(bob);
  const credC = (await enroll(vmC)).json.credential;
  await setCredit(5);
  await call("POST", "/api/agent/heartbeat", { headers: bearer(credD), body: {} });
  await tick(); // D drains (fresh heartbeat); C also (fresh from enroll)
  ok((await detail(bob, vmD.id)).backup_state === "draining", "second VM drains");
  await call("POST", "/api/dev/backdate", { cookie: admin, body: { what: "drain", instance_id: vmD.id, seconds: 700 } });
  await call("POST", "/api/agent/heartbeat", { headers: bearer(credD), body: {} });
  await call("POST", "/api/dev/backdate", { cookie: admin, body: { what: "heartbeat", instance_id: vmC.id, seconds: 400 } });
  await tick();
  const evD = await killEvent(bob, vmD.id);
  ok((await detail(bob, vmD.id)).status === "terminated" && JSON.parse(evD.detail).backup_before_kill === false && JSON.parse(evD.detail).why === "drain deadline reached", "hard deadline kills with backup_before_kill:false", JSON.stringify(evD));
  const evC = await killEvent(bob, vmC.id);
  ok((await detail(bob, vmC.id)).status === "terminated" && JSON.parse(evC.detail).backup_before_kill === false, "silent agent (3 min) is killed at once", JSON.stringify(evC));
  await setCredit(0);
  await tick();
  const evB = await killEvent(bob, vmB.id);
  ok((await detail(bob, vmB.id)).status === "terminated" && JSON.parse(evB.detail).why === "no backup agent", "VM without an agent keeps the old kill at $0", JSON.stringify(evB));

  // ---- manual terminate: back up first; force skips ----------------------------------------------------------
  await setCredit(1000);
  const vmE = await launch(bob);
  const credE = (await enroll(vmE)).json.credential;
  const term = call("POST", `/api/instances/${vmE.id}/terminate`, { cookie: bob, body: {} });
  let done = false;
  for (let i = 0; i < 40 && !done; i++) { // play the agent: poll heartbeat, back up, final-done
    await sleep(500);
    const h = await call("POST", "/api/agent/heartbeat", { headers: bearer(credE), body: {} });
    if (h.json?.final_backup) {
      await call("POST", "/api/agent/backup", { headers: bearer(credE), body: { snapshot_id: "eeee0001", tag: "final" } });
      await call("POST", "/api/agent/final-done", { headers: bearer(credE), body: { snapshot_id: "eeee0001" } });
      done = true;
    }
  }
  const tr = await term;
  ok(tr.json.state === "terminated" && tr.json.backup_before_kill === true, "manual terminate waits for the final backup", JSON.stringify(tr.json));
  const vmF = await launch(bob);
  await enroll(vmF);
  const fr = await call("POST", `/api/instances/${vmF.id}/terminate`, { cookie: bob, body: { force: true } });
  ok(fr.json.state === "terminated" && fr.json.backup_before_kill === false, "terminate with force:true skips the backup", JSON.stringify(fr.json));

  // ---- wipe ------------------------------------------------------------------------------------------------
  const w = await call("DELETE", "/api/backups", { cookie: bob });
  ok(w.json.ok && (await call("GET", "/api/backups", { cookie: bob })).json.used_bytes === 0, "DELETE /api/backups wipes the prefix");
  ok((await call("GET", "/api/backups", { cookie: eve })).json.used_bytes === 0, "other members are untouched");
}

try {
  await main();
} catch (e) {
  console.error(e);
  failed += 1;
} finally {
  if (worker) worker.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
