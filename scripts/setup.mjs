#!/usr/bin/env node
/**
 * Admin setup for the Massed Compute desk, on YOUR Cloudflare account.
 *
 *   npm run setup                 interactive-free; opens the `wrangler login` browser OAuth if needed
 *   npm run setup -- --dry-run    print every action, call nothing
 *   node scripts/setup.mjs --help
 *
 * Cloudflare OAuth is used only by wrangler (login/deploy). The app's own admin session is app-level:
 * this script seeds a one-time claim code for the Cloudflare login email (see docs/admin-setup.md).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_CONFIG = "wrangler.local.jsonc";

const HELP = `Usage: node scripts/setup.mjs [options]

Options:
  --dry-run            Print the actions without calling Cloudflare or writing files
  --name <worker>      Worker name (default: gpu-proxy)
  --db <name>          D1 database name (default: gpu-proxy)
  --bucket <name>      R2 backups bucket name (default: <worker>-backups)
  --account-id <id>    Cloudflare account id (needed if your login has several accounts)
  --admin-email <e>    Email for the admin account (default: your Cloudflare login email)
  --skip-claim         Do not seed the one-time admin claim code
  -h, --help           Show this help

Steps: wrangler login (if needed) -> D1 + R2 create if absent -> ${LOCAL_CONFIG} -> deploy ->
secrets (SESSION_SECRET, DATA_KEY, ADMIN_EMAIL) -> migrations -> admin claim code -> print URL.
Nothing in the committed wrangler.jsonc is changed; the owner's account_id/database_id are never reused.`;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
if (flag("-h") || flag("--help")) { console.log(HELP); process.exit(0); }

const DRY = flag("--dry-run");
const worker = opt("--name", "gpu-proxy");
const dbName = opt("--db", "gpu-proxy");
const bucket = opt("--bucket", `${worker}-backups`);
let accountId = opt("--account-id", "");
let adminEmail = opt("--admin-email", "");

const log = (m) => console.log(m);
const step = (m) => console.log(`\n== ${m}`);

function wrangler(wargs, { input, allowFail = false, quiet = false } = {}) {
  const cmd = ["wrangler", ...wargs];
  if (DRY) { log(`[dry-run] npx ${cmd.join(" ")}`); return { ok: true, out: "", dry: true }; }
  const r = spawnSync("npx", ["--yes", ...cmd], { cwd: ROOT, input, encoding: "utf8", env: { ...process.env, ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}) } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!quiet) process.stdout.write(out);
  if (r.status !== 0 && !allowFail) { console.error(`\nFailed: npx ${cmd.join(" ")}`); process.exit(1); }
  return { ok: r.status === 0, out };
}

/** Strip // and block comments (string-aware) and trailing commas from JSONC. */
function parseJsonc(text) {
  let out = "", i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === "\\") { out += n; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const base = parseJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
const wantsR2 = Array.isArray(base.r2_buckets) && base.r2_buckets.length > 0;

// 1. Cloudflare login (browser OAuth through wrangler)
step("1. Cloudflare login");
if (DRY) {
  log("[dry-run] npx wrangler whoami   (runs `npx wrangler login` if not logged in: opens the Cloudflare OAuth page)");
  adminEmail ||= "you@example.com"; accountId ||= "<your account id>";
} else {
  let who = wrangler(["whoami"], { allowFail: true, quiet: true });
  if (!who.ok || /not authenticated|not logged in/i.test(who.out)) {
    log("Not logged in. Opening the Cloudflare OAuth page in your browser...");
    wrangler(["login"]);
    who = wrangler(["whoami"], { quiet: true });
  }
  const email = who.out.match(/associated with the email\s+(\S+@\S+?)[.\s]/i)?.[1];
  adminEmail ||= email ?? "";
  const ids = [...new Set(who.out.match(/\b[0-9a-f]{32}\b/g) ?? [])];
  if (!accountId) {
    if (ids.length === 1) accountId = ids[0];
    else { console.error(`Your login has ${ids.length} accounts. Re-run with --account-id <id>:\n${who.out}`); process.exit(1); }
  }
  if (!adminEmail) { console.error("Could not read your login email (API-token logins hide it). Re-run with --admin-email you@example.com"); process.exit(1); }
  log(`Account ${accountId}, admin email ${adminEmail}`);
}

// 2. Resources
step("2. D1 database and R2 backups bucket");
let dbId = "<new d1 id>";
if (!DRY) {
  const list = wrangler(["d1", "list", "--json"], { quiet: true });
  let dbs = []; try { dbs = JSON.parse(list.out); } catch { /* fall through to create */ }
  dbId = dbs.find((d) => d.name === dbName)?.uuid;
  if (!dbId) {
    wrangler(["d1", "create", dbName]);
    dbs = JSON.parse(wrangler(["d1", "list", "--json"], { quiet: true }).out);
    dbId = dbs.find((d) => d.name === dbName)?.uuid;
    if (!dbId) { console.error("D1 database was created but its id could not be read."); process.exit(1); }
  } else log(`D1 ${dbName} exists (${dbId})`);
} else wrangler(["d1", "create", dbName]);
if (wantsR2) {
  const r = wrangler(["r2", "bucket", "create", bucket], { allowFail: true });
  if (!DRY && !r.ok && !/already exists/i.test(r.out)) { console.error("R2 bucket create failed (is R2 enabled on the account? Dashboard -> R2)."); process.exit(1); }
} else log("(wrangler.jsonc has no r2_buckets yet; skipping the R2 bucket. See docs/admin-setup.md > Config changes needed.)");

// 3. Local config (gitignored)
step(`3. Write ${LOCAL_CONFIG}`);
const local = structuredClone(base);
local.name = worker;
local.account_id = accountId;
delete local.routes;           // the owner's custom domain is not yours
delete local.preview_urls;
local.workers_dev = true;
local.d1_databases = (base.d1_databases ?? []).map((d) => ({ ...d, database_name: dbName, database_id: dbId }));
if (wantsR2) local.r2_buckets = base.r2_buckets.map((b) => ({ ...b, bucket_name: bucket }));
local.vars = { ...(base.vars ?? {}), MOCK_MASSED: "0" };
delete local.vars.APP_URL;     // filled in after the first deploy
delete local.vars.MAIL_FROM;   // set a sender on a domain you own (docs/admin-setup.md)
if (DRY) log(`[dry-run] would write ${LOCAL_CONFIG}:\n${JSON.stringify(local, null, 2)}`);
else writeFileSync(join(ROOT, LOCAL_CONFIG), JSON.stringify(local, null, 2) + "\n");
const C = ["-c", LOCAL_CONFIG];

// 4. Migrations, then deploy
step("4. Migrations and first deploy");
wrangler(["d1", "migrations", "apply", dbName, "--remote", ...C]);
const dep = wrangler(["deploy", ...C]);
const url = DRY ? "https://" + worker + ".<subdomain>.workers.dev" : dep.out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
if (!url) { console.error("Deployed, but could not read the URL. Find it in the Cloudflare dashboard, then set APP_URL."); process.exit(1); }

// 5. Secrets (only the ones not already set)
step("5. Secrets");
const existing = new Set();
if (!DRY) { try { for (const s of JSON.parse(wrangler(["secret", "list", ...C], { quiet: true, allowFail: true }).out)) existing.add(s.name); } catch { /* none */ } }
const rand = () => randomBytes(32).toString("base64url");
const secrets = {};
if (!existing.has("SESSION_SECRET")) secrets.SESSION_SECRET = rand();
if (!existing.has("DATA_KEY")) secrets.DATA_KEY = rand(); // encrypts the stored Massed tokens: never regenerate once data exists
secrets.ADMIN_EMAIL = adminEmail; // binds "who may become the first admin" to your Cloudflare identity
if (DRY) log(`[dry-run] npx wrangler secret bulk (stdin) ${Object.keys(secrets).join(", ")}`);
else wrangler(["secret", "bulk", ...C], { input: JSON.stringify(secrets) });

// 6. APP_URL and redeploy
step("6. APP_URL");
local.vars.APP_URL = url;
if (!DRY) writeFileSync(join(ROOT, LOCAL_CONFIG), JSON.stringify(local, null, 2) + "\n");
wrangler(["deploy", ...C]);

// 7. One-time admin claim code (app-level, not Cloudflare OAuth)
let claim = "";
if (!flag("--skip-claim")) {
  step("7. One-time admin claim code");
  claim = randomBytes(18).toString("hex");
  const hash = createHash("sha256").update(`${adminEmail.toLowerCase()}:${claim}`).digest("hex");
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const now = new Date().toISOString();
  const sql = `INSERT OR REPLACE INTO signup_otps (email, code_hash, password_hash, salt, expires_at, attempts, created_at, purpose) VALUES ('${adminEmail.toLowerCase().replace(/'/g, "''")}', '${hash}', '', '', ${exp}, 0, '${now}', 'admin')`;
  wrangler(["d1", "execute", dbName, "--remote", "--command", sql, ...C], { quiet: true });
  log("Seeded (stored hashed, expires in 24 hours, single use).");
}

step("Done");
log(`App:      ${url}/app`);
log(`Landing:  ${url}/`);
log(`Admin:    ${adminEmail}`);
if (claim) {
  log(`Claim:    ${url}/app#claim=${encodeURIComponent(adminEmail.toLowerCase())}:${claim}`);
  log("          (Opens straight into the admin account once the app reads #claim=; until then use the emailed-code sign-in.)");
}
log("Next: open the app, attach Massed Compute (OAuth), then invite members. See docs/admin-setup.md.");
