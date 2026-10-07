const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const app = $("#app");

// The desk may be served at "/" or under a prefix such as "/app" while the landing
// page owns "/". Work the mount point out once and never hard-code "/" after that.
const APP_BASE = (() => {
  const p = location.pathname.replace(/\/+$/, "");
  return p.endsWith("/index.html") ? p.slice(0, -"/index.html".length) : p;
})();
const route = (path = "") => `${APP_BASE}${path}` || "/";

// Optional endpoints the backend is still adding. Until one answers, its feature
// falls back to localStorage (keys, onboarding) or to an older endpoint (lab status).
const NO_CAPS = {
  onboarding: false, ssh_keys: false, balance: false,
  lab_status: false, vm_events: false, burn_series: false, attribution: false,
};

// A route that answers 404 once is not asked again this session, so the console stays clean.
const missing = new Set();
async function tryApi(path, init) {
  if (missing.has(path)) return null;
  try {
    return await api(path, init);
  } catch (e) {
    if (/not found|404/i.test(String(e?.message || ""))) missing.add(path);
    return null;
  }
}

const PALETTE = ["#8d5a38", "#3f6b4e", "#c28b3c", "#4f6d8f", "#a33d2f", "#7a5c9e", "#2f7d78", "#b86b8d"];

// per-card accent: a top rule, a tinted icon tile and a glyph
const TONES = {
  clay: { line: "linear-gradient(90deg, #b8814f, #8d5a38)", soft: "#f4e9dc", tint: "#8d5a38" },
  gold: { line: "linear-gradient(90deg, #d9a94e, #c28b3c)", soft: "#faf0dc", tint: "#8a6414" },
  olive: { line: "linear-gradient(90deg, #6f9a78, #3f6b4e)", soft: "#e8f0e9", tint: "#3f6b4e" },
  slate: { line: "linear-gradient(90deg, #7d97b8, #4f6d8f)", soft: "#eaeff5", tint: "#4f6d8f" },
  plum: { line: "linear-gradient(90deg, #a184c2, #7a5c9e)", soft: "#f0ebf6", tint: "#7a5c9e" },
  teal: { line: "linear-gradient(90deg, #589b96, #2f7d78)", soft: "#e7f1f0", tint: "#2f7d78" },
  brick: { line: "linear-gradient(90deg, #c26455, #a33d2f)", soft: "#f8eae7", tint: "#a33d2f" },
  sand: { line: "linear-gradient(90deg, #c9b49c, #a08d7c)", soft: "#f3ede5", tint: "#8a7767" },
};

const icon = (paths, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}${extra}</svg>`;

const ICONS = {
  chip: icon(`<rect x="7" y="7" width="10" height="10" rx="2.5"/><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/>`),
  wallet: icon(`<path d="M3 8a2.5 2.5 0 0 1 2.5-2.5H17A2 2 0 0 1 19 7.5"/><path d="M3 8v9a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2H5.5A2.5 2.5 0 0 1 3 8Z"/><circle cx="16.5" cy="14" r="1.1" fill="currentColor" stroke="none"/>`),
  bolt: icon(`<path d="M13.5 3 5 13.5h5.5L10 21l8.5-10.5H13l.5-7.5Z"/>`),
  trend: icon(`<path d="M3 17l5.5-5.5 3.5 3.5L21 6"/><path d="M15.5 6H21v5.5"/>`),
  server: icon(`<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>`),
  users: icon(`<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M16 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.4a5.5 5.5 0 0 1 3 5.1"/>`),
  target: icon(`<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>`),
  receipt: icon(`<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9.5 8h5M9.5 12h5"/>`),
  coins: icon(`<ellipse cx="12" cy="6.5" rx="7" ry="3.2"/><path d="M5 6.5v5c0 1.8 3.1 3.2 7 3.2s7-1.4 7-3.2v-5"/><path d="M5 11.5v5c0 1.8 3.1 3.2 7 3.2s7-1.4 7-3.2v-5"/>`),
  clock: icon(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`),
  calendar: icon(`<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>`),
  flame: icon(`<path d="M12 3s5 4.2 5 9a5 5 0 0 1-10 0c0-1.7.7-3 1.5-4.2.4.9 1 1.7 1.7 2C10.9 7.6 11.4 5.2 12 3Z"/>`),
  key: icon(`<circle cx="8" cy="14.5" r="4"/><path d="m11 11.5 8-8M16 3.5 20 7.5M14 5.5 18 9.5"/>`),
  plug: icon(`<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z"/><path d="M12 17v4"/>`),
  alert: icon(`<path d="M12 4.5 2.8 20h18.4L12 4.5Z"/><path d="M12 10v4.2M12 17.4h.01"/>`),
  check: icon(`<path d="m5 12.5 4.5 4.5L19 7.5"/>`),
  help: icon(`<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.3"/><path d="M12 16.8h.01"/>`),
  arrow: icon(`<path d="M5 12h14M13 6l6 6-6 6"/>`),
  ghost: icon(`<path d="M12 3.5c4.1 0 7 3.2 7 7.5v9l-2.3-1.7-2.3 1.7L12 18.3 9.6 20 7.3 18.3 5 20v-9c0-4.3 2.9-7.5 7-7.5Z"/><path d="M9.5 10h.01M14.5 10h.01"/>`),
  exit: icon(`<path d="M15 4.5h3.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M10 8l-4 4 4 4M6 12h9"/>`),
};

const tone = (name) => TONES[name] || TONES.clay;

// identity hue, picked from a curated warm-leaning set so no monogram looks muddy
const HUES = [26, 150, 42, 210, 8, 284, 176, 338];
function hue(email) {
  let h = 0;
  for (const ch of String(email || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}
const av = (email, cls = "") =>
  `<i class="avatar ${cls}" style="--h:${hue(email)}" aria-hidden="true">${esc(initials(email))}</i>`;

let uid = 0;
const nextId = (p) => p + ++uid;

function mix(hex, to, amount) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = rgb(hex);
  const [r2, g2, b2] = rgb(to);
  const f = (a, b) => Math.round(a + (b - a) * amount).toString(16).padStart(2, "0");
  return `#${f(r1, r2)}${f(g1, g2)}${f(b1, b2)}`;
}

const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const state = {
  user: null,
  tab: "home",
  meta: { mock: true },
  caps: { ...NO_CAPS },
  massed: null,
  inventory: { gpus: [], images: [] },
  inventoryLoaded: false,
  instances: [],
  team: { members: [], invites: [], running: [] },
  audit: [],
  usage: [],
  usageSummary: null,
  watch: { vms: [], ticks: [], summary: { cents: 0, hours: 0, vm_count: 0 } },
  keys: [],
  sshKeys: [],
  fleet: { instances: [], loaded: false },
  lab: null,
  labProbe: null,
  vmEvents: null,
  calibration: null,
  billing: null,
  connEvents: null,
  settings: null,
  onboard: null,
  onboardAuto: [],
  onboardSeenRemote: false,
  tour: null,
  flash: "",
  flashKind: "err",
  // ui
  filter: { q: "", sort: "price", stock: false },
  matchQuery: "",
  match: null,
  matching: false,
  launch: null,
  edit: null,
  open: new Set(),
  details: {},
  uf: { range: 14, user: "", sku: "" },
  showAllEvents: false,
  showAllMachines: false,
  // auth
  authMode: "login",
  authEmail: "",
  pending: null,
  connect: new URLSearchParams(location.search).get("connect"),
  connectInfo: null,
  connectDone: null,
  // replay entrance motion on the next paint (tab switch / first load)
  playEnter: true,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || res.statusText);
    e.status = res.status;
    e.code = data.code;
    throw e;
  }
  return data;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
// the API nulls money it will not show you, and a null must never read as $0.00
const moneyOr = (cents) => (Number.isFinite(cents) ? money(cents) : "—");
const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : "—");
// compact stamp for histories: time when it is today, otherwise "6 Oct, 16:43"
const fmtShort = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
};
const isAdmin = () => state.user?.role === "admin";
const initials = (email) => (email || "?").slice(0, 2).toUpperCase();

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function hoursLabel(h) {
  const n = Number(h || 0);
  if (n <= 0) return "—";
  if (n < 1) return `${Math.max(1, Math.round(n * 60))}m`;
  if (n < 48) return `${n.toFixed(1)}h`;
  return `${(n / 24).toFixed(1)}d`;
}

function daysLeft(ts) {
  if (!ts) return "never expires";
  const d = Math.ceil((new Date(ts) - Date.now()) / 86400000);
  return d <= 0 ? "expired" : `${d}d left`;
}

function safeList(v) {
  try { return Array.isArray(v) ? v : JSON.parse(v); } catch { return []; }
}

let fetchGen = 0;

// ---------------------------------------------------------------- shell

function render() {
  if (!state.user) return renderAuth();
  if (state.connect) return renderConnect();
  ensureShell();
  paintNav();
  paintChrome();
  paintView();
  paintTour();
}

function ensureShell() {
  if ($(".wrap") && $("#view")) return;
  app.innerHTML = `
    <div class="wrap">
      <header class="top">
        <div class="brand"><i class="mark">${ICONS.chip}</i> Massed Compute <span>desk</span></div>
        <nav class="nav">
          ${tabBtn("home", "Home")}
          ${tabBtn("team", "Team")}
          ${tabBtn("usage", "Usage")}
          ${isAdmin() ? tabBtn("fleet", "Fleet") : ""}
          ${tabBtn("agents", "Agents")}
          <button class="ghost icon-btn" id="help" title="How this desk works" aria-label="How this desk works">${ICONS.help}</button>
          <div class="who-wrap">
            <button class="who" id="who" aria-haspopup="menu" aria-expanded="false" title="${esc(state.user.email)}">${av(state.user.email)}</button>
            <div class="menu" id="who-menu" role="menu" hidden>
              <div class="menu-head">${esc(state.user.email)}<span class="s">${esc(state.user.role)}</span></div>
              <button class="menu-item" id="menu-help" role="menuitem">${ICONS.help} Walk me through the desk</button>
              <button class="menu-item danger" id="menu-logout" role="menuitem">${ICONS.exit} Sign out</button>
            </div>
          </div>
        </nav>
      </header>
      <div id="chrome"></div>
      <div id="view"></div>
      <footer class="foot">${state.meta.mock ? "Mock inventory." : "Live Massed inventory"} · ${esc(state.user.email)}</footer>
    </div>
  `;
  $("#menu-logout").addEventListener("click", logout);
  $("#help").addEventListener("click", () => tourOpen());
  $("#menu-help").addEventListener("click", () => {
    $("#who-menu").hidden = true;
    tourOpen();
  });
  $("#who").addEventListener("click", () => {
    const menu = $("#who-menu");
    menu.hidden = !menu.hidden;
    $("#who").setAttribute("aria-expanded", String(!menu.hidden));
  });
  for (const b of $$(".nav [data-tab]")) b.addEventListener("click", () => switchTab(b.dataset.tab));
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  state.user = null;
  state.tour = null;
  state.lab = null;
  $("#tour")?.remove();
  app.innerHTML = "";
  renderAuth();
}

const tabBtn = (id, label) => `<button data-tab="${id}" class="${state.tab === id ? "active" : ""}">${label}</button>`;

function paintNav() {
  for (const b of $$(".nav [data-tab]")) b.classList.toggle("active", b.dataset.tab === state.tab);
}

function paintChrome() {
  const el = $("#chrome");
  if (!el) return;
  el.innerHTML = state.flash ? `<div class="flash ${state.flashKind === "ok" ? "good" : ""}">${esc(state.flash)}</div>` : "";
}

function flash(msg, kind = "err") {
  state.flash = msg;
  state.flashKind = kind;
  paintChrome();
}

function paintView(opts = {}) {
  const el = $("#view");
  if (!el) return;
  const y = window.scrollY;
  const enter = opts.animate ?? state.playEnter;
  state.playEnter = false;
  el.innerHTML = view();
  el.dataset.anim = enter ? "1" : "0";
  bindView();
  if (enter) {
    let i = 0;
    for (const c of el.querySelectorAll(".card, .step, .member")) {
      c.classList.add("enter");
      c.style.animationDelay = `${Math.min(i * 35, 400)}ms`;
      i++;
    }
    runCountUps(el);
  }
  window.scrollTo(0, y);
  if (state.tour?.open) requestAnimationFrame(positionTour);
}

// count big numbers up on tab entry; the final frame always writes the exact value
function runCountUps(root) {
  if (reduceMotion()) return;
  for (const el of root.querySelectorAll("[data-count]")) {
    const target = Number(el.dataset.count) || 0;
    const prefix = el.dataset.prefix || "";
    const suffix = el.dataset.suffix || "";
    const dec = Number(el.dataset.dec ?? 0);
    const label = (n) => `${prefix}${n.toFixed(dec)}${suffix}`;
    if (!target) continue;
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / 750);
      el.textContent = label(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = label(target);
    };
    requestAnimationFrame(tick);
  }
}

function switchTab(id) {
  if (!id) return;
  state.tab = id;
  state.flash = "";
  state.showAllEvents = false;
  state.showAllMachines = false;
  state.launch = null;
  state.edit = null;
  paintNav();
  paintChrome();
  // paint the tab immediately, then animate once its data has landed
  paintView({ animate: false });
  state.playEnter = true;
  return refreshTab();
}

function view() {
  if (state.tab === "home") return homeView();
  if (state.tab === "team") return teamView();
  if (state.tab === "usage") return usageView();
  if (state.tab === "fleet") return fleetView();
  if (state.tab === "agents") return agentsView();
  return "";
}

// ---------------------------------------------------------------- auth

function renderAuth() {
  const m = state.authMode;
  if (m === "otp") return renderOtp();
  app.innerHTML = `
    <div class="auth">
      <div class="brand">Massed Compute <span>desk</span></div>
      <div class="seg wide">
        <button type="button" data-mode="login" class="${m === "login" ? "active" : ""}">Sign in</button>
        <button type="button" data-mode="signup" class="${m === "signup" ? "active" : ""}">Join the team</button>
      </div>
      <p class="lead" style="margin-top:14px">${m === "login"
        ? "Welcome back."
        : "Use the email an admin invited. We'll send a 6-digit code to confirm it's you."}</p>
      ${state.flash ? `<div class="flash">${esc(state.flash)}</div>` : ""}
      <form id="auth-form">
        <label>Email</label>
        <input name="email" type="email" required autocomplete="username" value="${esc(state.authEmail)}" />
        <label>Password</label>
        <input name="password" type="password" required minlength="8" autocomplete="${m === "login" ? "current-password" : "new-password"}" />
        <button class="primary" style="width:100%;margin-top:18px" type="submit">${m === "login" ? "Sign in" : "Send me a code"}</button>
      </form>
      ${m === "login" ? `<p class="hint" style="margin-top:14px">Just looking? Demo (read-only, $0): <code>demo@massedui.vasanth.cloud</code> / <code>demo-zero</code></p>` : ""}
    </div>
  `;
  for (const b of $$("[data-mode]")) b.addEventListener("click", () => { state.authMode = b.dataset.mode; state.flash = ""; renderAuth(); });
  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.authEmail = String(fd.get("email"));
    try {
      if (m === "login") {
        const data = await post("/api/auth/login", { email: fd.get("email"), password: fd.get("password") });
        await enter(data.user);
      } else {
        const data = await post("/api/auth/register", { email: fd.get("email"), password: fd.get("password") });
        state.pending = { email: String(fd.get("email")), dev_code: data.dev_code };
        state.authMode = "otp";
        state.flash = "";
        renderAuth();
      }
    } catch (err) {
      state.flash = err.message;
      renderAuth();
    }
  });
}

function renderOtp() {
  const p = state.pending;
  app.innerHTML = `
    <div class="auth">
      <div class="brand">Massed Compute <span>desk</span></div>
      <h1 style="margin-top:18px">Check your email</h1>
      <p class="lead">We sent a 6-digit code to <b>${esc(p.email)}</b>. It expires in 10 minutes.</p>
      ${p.dev_code ? `<div class="flash good">Dev mode — your code is <b>${esc(p.dev_code)}</b></div>` : ""}
      ${state.flash ? `<div class="flash">${esc(state.flash)}</div>` : ""}
      <form id="otp-form">
        <input name="code" class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" required autofocus />
        <button class="primary" style="width:100%;margin-top:16px" type="submit">Verify & create account</button>
      </form>
      <button class="linkish" id="otp-back" style="margin-top:14px">← Use a different email</button>
    </div>
  `;
  $("#otp-back").addEventListener("click", () => { state.authMode = "signup"; state.flash = ""; renderAuth(); });
  $("#otp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const data = await post("/api/auth/verify", { email: p.email, code: new FormData(e.target).get("code") });
      await enter(data.user);
    } catch (err) {
      state.flash = err.message;
      renderOtp();
    }
  });
}

async function enter(user) {
  state.user = user;
  state.flash = "";
  state.pending = null;
  state.onboard = null;
  state.onboardSeenRemote = false;
  state.tour = null;
  autoTourArmed = false;
  if (!state.connect) state.tab = "home";
  app.innerHTML = "";
  await loadOnboardRemote();
  render();
  state.playEnter = true;
  if (!state.connect) refreshTab();
}

// ------------------------------------------------- agent approval screen

async function renderConnect() {
  app.innerHTML = `<div class="auth"><div class="brand">Massed Compute <span>desk</span></div><p class="lead" style="margin-top:18px">Checking code…</p></div>`;
  if (!state.connectInfo && !state.connectDone) {
    try {
      state.connectInfo = await api(`/api/cli/info?code=${encodeURIComponent(state.connect)}`);
    } catch (err) {
      state.connectDone = { error: err.message };
    }
  }
  const info = state.connectInfo;
  const done = state.connectDone;
  app.innerHTML = `
    <div class="auth">
      <div class="brand">Massed Compute <span>desk</span></div>
      ${done ? `
        <h1 style="margin-top:18px">${done.error ? "Can't connect" : done.approved ? "Agent connected" : "Request denied"}</h1>
        <p class="lead">${done.error ? esc(done.error) : done.approved
          ? `You can close this tab and go back to your agent. Access: ${esc(daysLeft(done.expires_at))}.`
          : "Nothing was shared with the agent."}</p>
        <button class="primary" id="c-home">Go to the desk</button>
      ` : `
        <h1 style="margin-top:18px">Connect an agent?</h1>
        <p class="lead"><b>${esc(info.device_name)}</b> wants to launch and manage GPUs as <b>${esc(state.user.email)}</b>, within your budget and limits.</p>
        <div class="connect-code">${esc(state.connect.toUpperCase())}</div>
        <p class="hint">Only approve if this code matches the one in your terminal. Access expires after ${info.token_days} days and you can revoke it anytime under Agents.</p>
        <div class="actions" style="margin-top:16px">
          <button class="primary" id="c-ok">Approve</button>
          <button class="ghost slim" id="c-no">Deny</button>
        </div>`}
    </div>`;
  $("#c-home")?.addEventListener("click", () => {
    state.connect = null;
    state.connectInfo = null;
    state.connectDone = null;
    history.replaceState(null, "", route());
    render();
    refreshTab();
  });
  const decide = async (approve) => {
    try {
      const r = await post("/api/cli/decide", { code: state.connect, approve });
      state.connectDone = { approved: approve, expires_at: r.expires_at };
    } catch (err) {
      state.connectDone = { error: err.message };
    }
    renderConnect();
  };
  $("#c-ok")?.addEventListener("click", () => decide(true));
  $("#c-no")?.addEventListener("click", () => decide(false));
}

// ---------------------------------------------------------------- charts

// round an axis maximum up to a readable number
function niceMax(v) {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => v / mag <= s + 1e-9) ?? 10;
  return step * mag;
}

function sparkline(values, color = "#8d5a38") {
  const w = 300, h = 44;
  if (values.length < 2 || Math.max(...values) <= 0) {
    return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${w}" y1="${h - 2}" y2="${h - 2}" class="grid-line"/></svg>`;
  }
  const max = Math.max(...values);
  const x = (i) => (i / (values.length - 1)) * w;
  const y = (v) => h - 4 - (v / max) * (h - 11);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const gid = nextId("sp");
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".36"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${d} L${w},${h} L0,${h} Z" class="area" style="fill:url(#${gid})"/>
    <path d="${d}" class="line" pathLength="1" style="stroke:${color}" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function ring(frac, label, sub) {
  const r = 34, c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac));
  const len = f * c;
  const id = nextId("rg");
  const [c1, c2] = f < 0.15 ? ["#c26455", "#a33d2f"] : f < 0.35 ? ["#d9a94e", "#c28b3c"] : ["#b8814f", "#8d5a38"];
  return `<div class="ring"><svg viewBox="0 0 84 84" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
      </linearGradient></defs>
      <circle cx="42" cy="42" r="${r}" class="ring-bg"/>
      <circle cx="42" cy="42" r="${r}" class="ring-fg" style="stroke:url(#${id});stroke-dasharray:${len.toFixed(1)} ${c.toFixed(1)};--len:${len.toFixed(1)}"/>
    </svg><div class="ring-t"><b>${esc(label)}</b><span>${esc(sub)}</span></div></div>`;
}

function donut(rows, valueKey, labelKey, colorOf) {
  const total = rows.reduce((n, r) => n + r[valueKey], 0);
  if (total <= 0) return `<p class="lead">No spend in this range.</p>`;
  const r = 52, c = 2 * Math.PI * r;
  const gap = rows.length > 1 ? 2 : 0;
  let off = 0;
  const segs = rows.map((row, i) => {
    const len = Math.max((row[valueKey] / total) * c - gap, 0.8);
    const seg = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${colorOf(i)}" stroke-width="20"
      stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
      transform="rotate(-90 70 70)" class="seg" style="animation-delay:${i * 70}ms"><title>${esc(row[labelKey])}: ${money(row[valueKey])} (${Math.round((row[valueKey] / total) * 100)}%)</title></circle>`;
    off += len + gap;
    return seg;
  }).join("");
  return `<div class="donut-wrap"><svg viewBox="0 0 140 140" class="donut" role="img" aria-label="Share of spend">${segs}
      <text x="70" y="68" text-anchor="middle" class="d-big">${money(total)}</text>
      <text x="70" y="83" text-anchor="middle" class="axis">TOTAL</text></svg>
    <div class="legend">${rows.slice(0, 8).map((row, i) => `
      <div><i style="background:${colorOf(i)}"></i><span>${esc(row[labelKey])}</span><b>${money(row[valueKey])}</b></div>`).join("")}</div></div>`;
}

// stacked daily bars; series = [{day, total, parts: {sku: cents}}]
function stackedBars(series, skus) {
  const W = 680, H = 214, pl = 52, pr = 8, pb = 30, pt = 14;
  const max = niceMax(Math.max(1, ...series.map((s) => s.total)));
  const slot = (W - pl - pr) / series.length;
  const bw = Math.min(slot * 0.62, 34);
  const defs = skus.slice(0, PALETTE.length).map((_, i) => {
    const c = PALETTE[i % PALETTE.length];
    return `<linearGradient id="sg${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${mix(c, "#ffffff", 0.06)}"/><stop offset="100%" stop-color="${mix(c, "#ffffff", 0.42)}"/></linearGradient>`;
  }).join("");
  const bars = series.map((s, i) => {
    const cx = pl + i * slot + slot / 2;
    const label = s.day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    let y = H - pb;
    const entries = Object.entries(s.parts).sort((a, b) => b[1] - a[1]);
    const segs = entries.map(([sku, cents]) => {
      const h = (cents / max) * (H - pb - pt);
      y -= h;
      const idx = Math.max(0, skus.indexOf(sku)) % PALETTE.length;
      return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h - 1.5, 1).toFixed(1)}" rx="2.5" fill="url(#sg${idx})" class="bar" style="animation-delay:${i * 16}ms"><title>${label} · ${esc(sku)}: ${money(cents)}</title></rect>`;
    }).join("");
    return `<g>${segs}</g>`;
  }).join("");
  const step = series.length > 4 ? Math.ceil(series.length / 10) : 1;
  const labels = series.map((s, i) =>
    i % step
      ? ""
      : `<text x="${(pl + i * slot + slot / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="axis">${s.day.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>`
  ).join("");
  const grid = [0, 0.5, 1].map((f) => {
    const y = H - pb - f * (H - pb - pt);
    return `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" class="grid-line"/><text x="${pl - 8}" y="${y + 4}" text-anchor="end" class="axis">${money(max * f)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Daily spend by GPU">
    <defs>${defs}</defs>${grid}${bars}${labels}</svg>`;
}

function lineChart(ticks) {
  const pts = [...ticks].reverse();
  if (pts.length < 2) return `<p class="lead">Collecting samples… (one every 5 minutes)</p>`;
  const W = 680, H = 160, pl = 52, pr = 10, pb = 24, pt = 12;
  const max = niceMax(Math.max(1, ...pts.map((t) => t.burn_cents_per_hour)));
  const x = (i) => pl + (i / (pts.length - 1)) * (W - pl - pr);
  const y = (v) => H - pb - (v / max) * (H - pb - pt);
  const path = pts.map((t, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(t.burn_cents_per_hour).toFixed(1)}`).join(" ");
  const gid = nextId("lc");
  const tl = (d) => new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Massed burn rate">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8d5a38" stop-opacity=".34"/>
      <stop offset="100%" stop-color="#8d5a38" stop-opacity="0"/>
    </linearGradient></defs>
    <line x1="${pl}" x2="${W - pr}" y1="${y(0)}" y2="${y(0)}" class="grid-line"/>
    <line x1="${pl}" x2="${W - pr}" y1="${y(max)}" y2="${y(max)}" class="grid-line"/>
    <text x="${pl - 8}" y="${y(max) + 4}" text-anchor="end" class="axis">${money(max)}/h</text>
    <text x="${pl - 8}" y="${y(0) + 4}" text-anchor="end" class="axis">$0</text>
    <path d="${path} L${x(pts.length - 1)},${H - pb} L${pl},${H - pb} Z" class="area" style="fill:url(#${gid})"/>
    <path d="${path}" class="line" pathLength="1"/>
    <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.burn_cents_per_hour).toFixed(1)}" r="4" class="dot-mark"/>
    <text x="${pl}" y="${H - 6}" class="axis">${esc(tl(pts[0].taken_at))}</text>
    <text x="${W - pr}" y="${H - 6}" text-anchor="end" class="axis">${esc(tl(last.taken_at))}</text></svg>`;
}

function hbars(rows, labelKey, colorOf) {
  if (!rows.length) return `<p class="lead">No data yet.</p>`;
  const max = Math.max(1, ...rows.map((r) => r.cents));
  return `<div class="hbars">${rows.slice(0, 8).map((r, i) => {
    const c = colorOf ? colorOf(i) : PALETTE[i % PALETTE.length];
    return `<div class="hbar">
      <div class="hl"><span>${esc(r[labelKey])}</span><span class="mono">${money(r.cents)} · ${Number(r.hours).toFixed(1)}h</span></div>
      <div class="track"><div class="fill" style="width:${((r.cents / max) * 100).toFixed(1)}%;background:linear-gradient(90deg, ${mix(c, "#ffffff", 0.3)}, ${c});animation-delay:${i * 60}ms"></div></div>
    </div>`;
  }).join("")}</div>`;
}

// ---------------------------------------------------------------- usage data

function eventsWithUser() {
  return state.usage.map((e) => ({ ...e, email: e.email || state.user.email, product_name: e.product_name || "unknown" }));
}

function filteredEvents() {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (state.uf.range - 1));
  return eventsWithUser().filter((e) =>
    new Date(e.created_at) >= cutoff &&
    (!state.uf.user || e.email === state.uf.user) &&
    (!state.uf.sku || e.product_name === state.uf.sku));
}

function dailyParts(events, days) {
  const map = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    map.set(d.toLocaleDateString("en-CA"), { day: d, total: 0, hours: 0, parts: {} });
  }
  for (const e of events) {
    const row = map.get(new Date(e.created_at).toLocaleDateString("en-CA"));
    if (!row) continue;
    row.total += Number(e.cents || 0);
    row.hours += Number(e.hours || 0);
    row.parts[e.product_name] = (row.parts[e.product_name] || 0) + Number(e.cents || 0);
  }
  return [...map.values()];
}

function groupBy(events, key) {
  const m = new Map();
  for (const e of events) {
    const g = m.get(e[key]) ?? { [key]: e[key], cents: 0, hours: 0 };
    g.cents += Number(e.cents || 0);
    g.hours += Number(e.hours || 0);
    m.set(e[key], g);
  }
  return [...m.values()].sort((a, b) => b.cents - a.cents);
}

// ---------------------------------------------------------------- home

const activeMine = () => state.instances.filter((i) => i.status === "running" || i.status === "launching");

function launchBlocker(sku) {
  if (sku.capacity <= 0) return "Out of stock";
  if (state.lab?.state === "lost") return "Lab offline";
  if (state.lab?.schema_ok === false) return "Massed API changed";
  if (state.lab && state.lab.can_launch === false) return "Lab offline";
  if (activeMine().length >= state.user.max_concurrent) return `Cap reached (${state.user.max_concurrent})`;
  if (needsSshKey()) return "Add an SSH key";
  if (!isAdmin() && state.user.credit_cents < sku.priceCentsPerHour) return "Not enough budget";
  return "";
}

// a number that counts up on tab entry; the last frame always writes the exact value
const counted = (n, prefix = "", dec = 0, suffix = "") =>
  `<span data-count="${Number(n) || 0}" data-prefix="${prefix}" data-dec="${dec}" data-suffix="${suffix}">${prefix}${(Number(n) || 0).toFixed(dec)}${suffix}</span>`;
const usd = (cents, dec = 2) => counted((Number(cents) || 0) / 100, "$", dec);

function statCard({ k, tone: name = "clay", icon: glyph, value, sub, spark, small }) {
  const t = tone(name);
  return `<div class="card" style="--tone:${t.line}">
    <div class="stat-top"><span class="k">${esc(k)}</span>${glyph ? `<i class="ico" style="--soft:${t.soft};--tint:${t.tint}">${glyph}</i>` : ""}</div>
    <div class="v${small ? " sm" : ""}">${value}</div>
    ${sub ? `<div class="s">${sub}</div>` : ""}
    ${spark || ""}
  </div>`;
}

function homeStats() {
  const mine = activeMine();
  const burn = mine.reduce((n, i) => n + i.price_cents_per_hour, 0);
  const teamRunning = state.team.running;
  const teamBurn = teamRunning.reduce((n, i) => n + i.price_cents_per_hour, 0);
  const daily = dailyParts(eventsWithUser(), 14).map((d) => d.total);
  const spent14 = daily.reduce((a, b) => a + b, 0);
  const m = state.massed;

  if (!isAdmin()) {
    const runway = burn > 0 && state.user.credit_cents > 0 ? state.user.credit_cents / burn : 0;
    return `
      <div class="grid stats member-stats">
        ${statCard({
          k: "Burning now", tone: burn > 0 ? "gold" : "sand", icon: ICONS.bolt,
          value: `${usd(burn)}<small>/hr</small>`,
          sub: `${mine.length} of ${state.user.max_concurrent} slot${state.user.max_concurrent === 1 ? "" : "s"} in use`,
        })}
        ${statCard({
          k: "Your spend · 14 days", tone: "slate", icon: ICONS.trend,
          value: usd(spent14), spark: sparkline(daily, TONES.slate.tint),
        })}
        ${statCard({
          k: "Runtime left", tone: runway > 0 ? "olive" : "sand", icon: ICONS.clock,
          value: runway > 0 ? counted(runway, "", 1, "h") : "—",
          sub: runway > 0 ? "at the current burn rate" : "nothing running",
        })}
      </div>`;
  }

  const total = state.user.credit_cents + state.user.spent_cents;
  const left = total > 0 ? state.user.credit_cents / total : 0;
  const runway = burn > 0 ? hoursLabel(state.user.credit_cents / burn) : "idle";
  const ringTone = tone(left < 0.15 ? "brick" : left < 0.35 ? "gold" : "clay");
  return `
    <div class="grid stats">
      <div class="card ringcard" style="--tone:${ringTone.line}">
        ${ring(left, `${Math.round(left * 100)}%`, "left")}
        <div class="grow">
          <div class="k">Your budget</div>
          <div class="v">${usd(state.user.credit_cents)}</div>
          <div class="s">${money(state.user.spent_cents)} spent</div>
          <div class="s">${burn > 0 ? (state.user.credit_cents > 0 ? `≈ ${runway} runway` : "out of budget") : "no VMs running"}</div>
        </div>
      </div>
      ${statCard({
        k: "Team burn now", tone: "gold", icon: ICONS.bolt,
        value: `${usd(teamBurn)}<small>/hr</small>`,
        sub: `${teamRunning.length} VM${teamRunning.length === 1 ? "" : "s"} running`,
      })}
      ${statCard({
        k: "Spend · 14 days", tone: "slate", icon: ICONS.trend,
        value: usd(spent14), spark: sparkline(daily, TONES.slate.tint),
      })}
      ${statCard({
        k: "Massed account", tone: m?.connected ? "olive" : "sand", icon: ICONS.server, small: true,
        value: `<span class="dot ${m?.connected && !m?.error ? "on" : ""}"></span>${m ? (m.connected ? "Connected" : "Offline") : "…"}`,
        sub: `${m?.running ?? 0} running upstream · ${money(m?.burnCentsPerHour || 0)}/hr`,
      })}
    </div>`;
}

function vmCard(i, mine) {
  const live = i.status === "running" || i.status === "launching";
  const d = state.details[i.id];
  const open = state.open.has(i.id);
  const hrs = Math.max(0, ((i.terminated_at ? new Date(i.terminated_at) : new Date()) - new Date(i.launched_at)) / 3600000);
  const rateKnown = Number.isFinite(i.price_cents_per_hour);
  const billed = Number(i.billed_cents) > 0 ? Number(i.billed_cents) : rateKnown ? Math.round(hrs * i.price_cents_per_hour) : null;
  const target = i.ip ? `${d?.username || "ubuntu"}@${i.ip}` : "";
  const label = i.name.replace(/^rl_[0-9a-f]{8}_/, "");
  const hasKey = (state.sshKeys || []).length > 0;
  // the server knows how this machine can be reached; fall back to the ip + key we can see
  const access = d?.access;
  const sshCmd = access?.ssh_command || (i.ip && hasKey ? `ssh ${d?.username || "ubuntu"}@${i.ip}` : null);
  return `
    <div class="card vm ${live ? "" : "dim"}">
      <div class="vm-top">
        <div><div class="gpu-name">${esc(label)}</div>
          <div class="s mono">${esc(i.product_name)}${i.region_name && i.region_name !== "any" ? ` · ${esc(i.region_name)}` : ""}</div></div>
        <span class="pill ${live ? "run" : "off"}">${esc(i.status)}${i.status === "launching" ? "…" : ""}</span>
      </div>
      ${mine ? "" : `<div class="owner">${av(i.email, "sm")}${esc(i.email)}</div>`}
      <div class="vm-meta">
        <div><div class="k">${live ? "Up" : "Ran"}</div><div class="mono">${esc(hoursLabel(hrs))}</div></div>
        <div><div class="k">Cost</div><div class="mono">${moneyOr(billed)}</div></div>
        <div><div class="k">Rate</div><div class="mono">${rateKnown ? `${money(i.price_cents_per_hour)}/hr` : "—"}</div></div>
      </div>
      ${mine && live ? `
        <div class="conn">
          ${sshCmd
            ? `<code>${esc(sshCmd)}</code><button class="ghost slim" data-copy="${esc(sshCmd)}">Copy</button>`
            : i.ip
              ? `<span class="s">No SSH key on this machine — open the login details.</span>`
              : `<span class="s">Waiting for an address…</span>`}
        </div>
        <button class="linkish" data-toggle="${i.id}">${open ? "Hide" : "Show"} login details</button>
        ${open ? `<div class="creds">${d ? `
          <div><span class="k">IP</span> <code>${esc(d.ip || "pending")}</code></div>
          <div><span class="k">User</span> <code>${esc(d.username || "—")}</code></div>
          <div><span class="k">Password</span> <code>${esc(d.password || "—")}</code>
            ${d.password ? `<button class="ghost slim" data-copy="${esc(d.password)}">Copy</button>` : ""}</div>
          <div class="s">${access?.method === "ssh_key"
            ? "Reached with the SSH key you attached at launch."
            : access?.method === "password"
              ? "Password access — the lab still holds a Massed API key."
              : sshCmd ? "Address only — no key is recorded for this machine." : "No way in yet."}</div></div>` : `<span class="s">Loading…</span>`}</div>` : ""}` : ""}
      ${live && (mine || isAdmin()) ? `<div class="vm-actions">
          ${mine ? `<button class="ghost slim" data-restart="${i.id}">Restart</button>` : ""}
          <button class="ghost slim danger" data-kill="${i.id}">Terminate</button></div>` : ""}
      ${!live ? `<div class="s">Ended ${esc(fmtShort(i.terminated_at))}${billed != null ? ` · billed ${money(billed)}` : ""}${i.end_reason ? ` · ${esc(i.end_reason)}` : ""}</div>` : ""}
    </div>`;
}

function stockBadge(sku) {
  if (sku.capacity <= 0) return `<span class="pill bad">Out of stock</span>`;
  if (sku.capacity <= 3) return `<span class="pill warn">${sku.capacity} left</span>`;
  return `<span class="pill run">${sku.capacity} available</span>`;
}

function gpuCard(sku, note) {
  const block = launchBlocker(sku);
  return `
    <div class="card gpu ${sku.capacity <= 0 ? "dim" : ""}">
      <div class="gpu-top"><div class="gpu-name">${esc(sku.productName)}</div>${stockBadge(sku)}</div>
      <div class="s">${esc(sku.description || "")}</div>
      <div class="chips"><span>${sku.vcpu} vCPU</span><span>${sku.ramGib} GiB RAM</span><span>${sku.storageGb} GB disk</span></div>
      ${note ? `<p class="reason">${esc(note)}</p>` : ""}
      <div class="gpu-foot">
        <div class="gpu-price"><span class="price">${money(sku.priceCentsPerHour)}</span><span class="unit">/hr</span>
          <span class="per-day">${money(sku.priceCentsPerHour * 24)}/day</span></div>
        <button class="primary slim ${block ? "blocked" : ""}" data-open-launch="${esc(sku.productName)}"
          aria-disabled="${block ? "true" : "false"}">${block ? esc(block) : "Launch"}</button>
      </div>
    </div>`;
}

function filteredGpus() {
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  const cmp = {
    price: (a, b) => a.priceCentsPerHour - b.priceCentsPerHour,
    "price-desc": (a, b) => b.priceCentsPerHour - a.priceCentsPerHour,
    stock: (a, b) => b.capacity - a.capacity,
    name: (a, b) => a.productName.localeCompare(b.productName),
  }[f.sort];
  return state.inventory.gpus
    .filter((g) => (!q || `${g.productName} ${g.description}`.toLowerCase().includes(q)) && (!f.stock || g.capacity > 0))
    .sort(cmp);
}

function gpuGridHtml() {
  if (!state.inventoryLoaded) return `<p class="lead">Loading GPUs…</p>`;
  const list = filteredGpus();
  if (!list.length) return `<p class="lead">${state.inventory.gpus.length ? "No GPUs match the filters." : "Nothing is on your allowlist yet — ask an admin."}</p>`;
  return `<div class="gpu-grid">${list.map((g) => gpuCard(g)).join("")}</div>`;
}

function matchPanel() {
  const m = state.match;
  return `
    <form id="match-form" class="card match-form">
      <div class="match-head"><b>Not sure what you need?</b> <span class="hint">Describe the job — we'll pick the cheapest GPU that fits.</span></div>
      <div class="match-row">
        <input name="query" placeholder="e.g. fine-tune Llama 8B overnight, ~24GB VRAM, keep it cheap" value="${esc(state.matchQuery)}" />
        <button class="primary slim" type="submit" ${state.matching ? "disabled" : ""}>${state.matching ? "Matching…" : "Recommend"}</button>
      </div>
    </form>
    ${m?.pick ? `<div class="gpu-grid" style="margin-top:12px">${gpuCard(m.pick.sku, `Best match: ${m.pick.reason}`)}${(m.alternatives || []).map((a) => gpuCard(a.sku, `Alternative: ${a.reason}`)).join("")}</div>` : ""}`;
}

function homeView() {
  const me = state.user.id;
  const mineById = new Map(state.instances.map((i) => [i.id, i]));
  const running = state.team.running.map((r) => (r.user_id === me && mineById.has(r.id) ? { mine: true, i: mineById.get(r.id) } : { mine: false, i: r }));
  running.sort((a, b) => Number(b.mine) - Number(a.mine));
  const f = state.filter;
  const admin = isAdmin();
  return `
    <h1>Home</h1>
    <p class="lead">${admin
      ? "What's running across the lab right now, and a quick way to spin something up."
      : "Launch a GPU on the lab's account, and keep an eye on what it costs you."}</p>
    ${onboardCard()}
    ${admin
      ? `<div data-tour="stats">${homeStats()}</div>
        <h2 class="sect">Running now</h2>
        ${running.length
          ? `<div class="vm-grid">${running.map((r) => vmCard(r.i, r.mine)).join("")}</div>`
          : `<div class="card empty"><b>Nothing running.</b><p class="lead">Launch a GPU below to get started.</p></div>`}
        <h2 class="sect">Launch a GPU</h2>
        ${launchPanel(f)}`
      : `${labLine()}
        ${budgetPanel()}
        ${homeStats()}
        <h2 class="sect">Launch a GPU</h2>
        ${launchPanel(f)}
        <h2 class="sect">Your machines</h2>
        ${yourMachines()}
        <div class="split even">
          ${sshKeysCard()}
          ${connectHelpCard()}
        </div>`}
    ${launchDialogHtml()}
  `;
}

/** The search, sort and GPU grid a member launches from. */
function launchPanel(f) {
  return `
    <div data-tour="launch">
      ${matchPanel()}
      <div class="filters">
        <input id="f-q" type="search" placeholder="Search GPUs…" value="${esc(f.q)}" />
        <select id="f-sort">
          ${[["price", "Price: low to high"], ["price-desc", "Price: high to low"], ["stock", "Most in stock"], ["name", "Name"]]
            .map(([v, l]) => `<option value="${v}" ${f.sort === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <label class="check"><input type="checkbox" id="f-stock" ${f.stock ? "checked" : ""} /> In stock only</label>
      </div>
      <div id="gpu-grid">${gpuGridHtml()}</div>
    </div>`;
}

/**
 * Can this lab hand back a VM password? Only the REST key and mock mode can; an OAuth
 * connection redacts them, so anything that mentions a password must stay quiet there.
 */
function passwordsAvailable() {
  if (state.caps.passwords === true) return true;
  if (state.caps.passwords === false) return false;
  return state.lab?.state === "mock" || state.lab?.state === "api_key";
}

function connectHelpCard() {
  const canPassword = passwordsAvailable();
  const hasKey = (state.sshKeys || []).length > 0;
  return `
    <div class="card">
      <div class="card-head"><h2>Getting onto a machine</h2></div>
      <ol class="howto">
        ${hasKey
          ? `<li><b>Your key is saved</b> — every launch attaches it automatically.</li>
             <li><b>Launch a GPU</b> above.</li>`
          : `<li><b>Save a public key</b>. One line is enough, and it is not a secret.</li>
             <li><b>Launch a GPU</b> above — the key rides along automatically.</li>`}
        <li><b>Copy the ssh command</b> from the machine card${canPassword ? `, or open <em>login details</em> for the generated password` : ""}.</li>
      </ol>
      <p class="hint">Billing runs hourly until you terminate. Terminating wipes the disk — there is no pause or snapshot.</p>
    </div>`;
}

function launchDialogHtml() {
  const l = state.launch;
  if (!l) return "";
  const sku = state.inventory.gpus.find((g) => g.productName === l.productName);
  if (!sku) return "";
  const keys = state.sshKeys || [];
  const mustKey = needsSshKey();
  const blocker = launchBlocker(sku);
  // a missing SSH key is the one blocker the member can fix right here, so keep Launch live
  const fixableHere = blocker === "Add an SSH key";
  const canSubmit = !blocker || fixableHere;
  const prefill = l.sshPublicKey ?? preferredKey();
  return `
    <div class="modal-bg" id="modal-bg">
      <form class="modal card" id="launch-form">
        <div class="modal-head">
          <div><h1 style="font-size:18px">Launch ${esc(sku.productName)}</h1>
            <div class="s">${esc(sku.description || "")} · ${sku.vcpu} vCPU · ${sku.ramGib} GiB · ${sku.storageGb} GB</div></div>
          <button type="button" class="ghost" data-close aria-label="Close">✕</button>
        </div>
        <label>Name <span class="opt">(optional)</span></label>
        <input name="instanceName" placeholder="e.g. finetune-run" maxlength="40" />
        <div class="two">
          <div><label>Image</label>
            <select name="imageId"><option value="">Default</option>
              ${(state.inventory.images || []).map((i) => `<option value="${i.vm_image_id}">${esc(i.vm_image_name)}</option>`).join("")}</select></div>
          <div><label>Region</label>
            <select name="regionName"><option value="">Any</option>
              ${(sku.regions || []).map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select></div>
        </div>
        <label>SSH public key ${mustKey ? `<span class="req">required</span>` : `<span class="opt">(optional — otherwise use the generated password)</span>`}</label>
        ${keys.length
          ? `<select name="savedKey">
              ${keys.map((k, i) => `<option value="${esc(k.public_key)}" ${i === 0 ? "selected" : ""}>${esc(k.name || "key")} · ${esc(shortKey(k.public_key))}</option>`).join("")}
              <option value="">Paste a different key…</option>
            </select>`
          : ""}
        <textarea name="sshPublicKey" rows="3" placeholder="ssh-ed25519 AAAA… you@laptop" ${keys.length ? "hidden" : ""}>${esc(keys.length ? "" : prefill)}</textarea>
        ${mustKey ? `<p class="hint">This lab reaches Massed over OAuth, which does not return machine passwords.
          Attach a key or you will have no way in. Save one on Home and it fills in here automatically.</p>` : ""}
        <div class="estimate">
          <div><span class="k">Price</span> <b>${money(sku.priceCentsPerHour)}/hr</b> · ${money(sku.priceCentsPerHour * 24)}/day</div>
          ${isAdmin() ? "" : `<div><span class="k">Your budget covers</span> <b>${hoursLabel(state.user.credit_cents / sku.priceCentsPerHour)}</b></div>`}
          <div class="s">Billing starts at launch and runs until you terminate.</div>
        </div>
        ${blocker ? `<p class="notice warn">${ICONS.alert}${esc(blocker === "Add an SSH key"
          ? "Paste a public key above and Launch will work. The lab reaches Massed over OAuth, so no machine password ever reaches you."
          : `You cannot launch ${esc(sku.productName)} right now: ${esc(blocker.toLowerCase())}.`)}</p>` : ""}
        <div class="actions">
          <button class="primary" type="submit" ${l.busy || !canSubmit ? "disabled" : ""}>${l.busy ? "Launching…" : blocker && !fixableHere ? esc(blocker) : `Launch for ${money(sku.priceCentsPerHour)}/hr`}</button>
          <button class="ghost slim" type="button" data-close>Cancel</button>
        </div>
      </form>
    </div>`;
}

// ---------------------------------------------------------------- team

const hasMoney = (m) => Number.isFinite(m?.credit_cents) && Number.isFinite(m?.spent_cents);

function memberCard(m, isSelf = false) {
  const gpus = safeList(m.allowed_gpus);
  const money0 = hasMoney(m);
  const total = money0 ? m.credit_cents + m.spent_cents : 0;
  const left = money0 && total > 0 ? m.credit_cents / total : 0;
  return `
    <div class="card member ${isAdmin() ? "clickable" : ""} ${isSelf ? "self" : ""}" ${isAdmin() ? `data-edit="${m.id}"` : ""}>
      <div class="member-top">
        ${av(m.email)}
        <div class="grow"><div class="gpu-name">${esc(m.email)}</div>
          <div class="s">${m.running} running · cap ${m.max_concurrent} · ${gpus.includes("*") ? "all GPUs" : `${gpus.length} GPU${gpus.length === 1 ? "" : "s"}`}</div></div>
        ${isSelf ? `<span class="pill you">You</span>` : ""}
        <span class="pill ${m.role === "admin" ? "admin" : ""}">${esc(m.role)}</span>
      </div>
      ${money0 ? `
        <div class="budget">
          <div class="hl"><span>${money(m.credit_cents)} left</span><span class="s">${money(m.spent_cents)} spent</span></div>
          <div class="track"><div class="fill" style="width:${(left * 100).toFixed(1)}%;background:${left < 0.15 ? "linear-gradient(90deg,#c26455,#a33d2f)" : left < 0.35 ? "linear-gradient(90deg,#d9a94e,#c28b3c)" : "linear-gradient(90deg,#6f9a78,#3f6b4e)"}"></div></div>
        </div>
        ${Number(m.burn_cents_per_hour) > 0 ? `<div class="s">Burning ${money(m.burn_cents_per_hour)}/hr</div>` : ""}`
      : `<div class="hl"><span class="s">${isSelf ? "No budget set" : "Budget is private"}</span></div>`}
    </div>`;
}

function teamView() {
  const t = state.team;
  // `spend_visible` is the server's verdict on whether other people's money may be shown.
  // Fall back to the data (all rows carrying numbers) if an older response omits it.
  const moneyRows = t.members.filter(hasMoney);
  const spendVisible = typeof t.spend_visible === "boolean"
    ? t.spend_visible
    : (t.members.length > 0 && moneyRows.length === t.members.length);
  const allocated = moneyRows.reduce((n, m) => n + m.credit_cents + m.spent_cents, 0);
  const spent = moneyRows.reduce((n, m) => n + m.spent_cents, 0);
  const slices = moneyRows.map((m) => ({ email: m.email, cents: m.spent_cents })).filter((x) => x.cents > 0).sort((a, b) => b.cents - a.cents);
  const me = state.user.id;
  const members = isAdmin() ? t.members : [...t.members].sort((a, b) => Number(b.id === me) - Number(a.id === me));
  const myShare = t.members.find((m) => m.id === me);
  const myMoney = hasMoney(myShare) ? myShare : null;
  const running = t.members.reduce((n, m) => n + (Number(m.running) || 0), 0);
  const myGpus = safeList(myShare?.allowed_gpus);
  return `
    <h1>Team</h1>
    <p class="lead">${isAdmin()
      ? "Invite people by email and give each a budget. They sign up and confirm with a one-time code."
      : "Everyone who can use this desk. Your budget is highlighted; ask an admin for a change."}</p>
    ${!isAdmin() ? labLine() : ""}
    ${!isAdmin() && myShare ? `
      <div class="card budget-panel compact" style="--tone:${tone(myMoney && myShare.credit_cents <= 0 ? "brick" : "clay").line}">
        <div class="grow">
          <div class="k">Your budget</div>
          <div class="v">${myMoney ? `${money(myShare.credit_cents)}<small> left</small>` : "—"}</div>
          <div class="s">${myMoney ? `${money(myShare.spent_cents)} spent` : "Ask an admin to set one"}
            · cap ${myShare.max_concurrent} machine${myShare.max_concurrent === 1 ? "" : "s"}
            · ${myGpus.includes("*") ? "all GPUs" : `${myGpus.length} GPU${myGpus.length === 1 ? "" : "s"} allowed`}</div>
        </div>
      </div>` : ""}
    <div class="grid stats">
      ${statCard({ k: "Members", tone: "clay", icon: ICONS.users, value: counted(t.members.length), sub: `${t.invites.length} invited` })}
      ${statCard({ k: "Machines running", tone: "slate", icon: ICONS.server, value: counted(running), sub: "across the lab" })}
      ${spendVisible ? `
        ${statCard({ k: "Budget allocated", tone: "slate", icon: ICONS.target, value: usd(allocated), sub: "across all members" })}
        ${statCard({ k: "Spent so far", tone: "gold", icon: ICONS.receipt, value: usd(spent), sub: allocated > 0 ? `${Math.round((spent / allocated) * 100)}% of budget` : "" })}
        ${statCard({ k: "Remaining", tone: "olive", icon: ICONS.coins, value: usd(allocated - spent), sub: "left to spend" })}`
      : `
        ${statCard({ k: "Your machines", tone: "slate", icon: ICONS.server, value: `${counted(Number(myShare?.running) || 0)}<small> / ${myShare?.max_concurrent ?? 0}</small>`, sub: "running / cap" })}
        ${statCard({ k: "Your access", tone: "olive", icon: ICONS.target, value: myGpus.includes("*") ? "All GPUs" : counted(myGpus.length), sub: myGpus.includes("*") ? "no allowlist" : "on your allowlist" })}`}
    </div>
    ${isAdmin() ? `
    <form id="invite-form" class="card invite" data-tour="invite">
      <h2>Add a teammate</h2>
      <div class="invite-grid">
        <div><label>Email</label><input name="email" type="email" required placeholder="name@company.com" /></div>
        <div><label>Budget ($)</label><input name="budget" type="number" min="0" step="1" value="20" /></div>
        <div><label>Max VMs</label><input name="max_concurrent" type="number" min="0" max="32" value="1" /></div>
        <div><label>Role</label><select name="role"><option value="user">Member</option><option value="admin">Admin</option></select></div>
        <button class="primary slim" type="submit">Invite</button>
      </div>
      <p class="hint">They register with this email, enter the code we send, and start with this budget.</p>
    </form>` : ""}
    ${t.invites.length ? `
    <h2 class="sect">Pending invites</h2>
    <div class="card"><table><thead><tr><th>Email</th><th>Role</th><th>Budget</th><th>Max VMs</th><th>Invited</th><th></th></tr></thead><tbody>
      ${t.invites.map((i) => `<tr><td>${esc(i.email)}</td><td><span class="pill ${i.role === "admin" ? "admin" : ""}">${esc(i.role)}</span></td>
        <td class="mono">${money(i.credit_cents)}</td><td class="mono">${i.max_concurrent}</td><td class="mono">${esc(fmt(i.created_at))}</td>
        <td><button class="linkish danger" data-revoke-invite="${esc(i.email)}">revoke</button></td></tr>`).join("")}
    </tbody></table></div>` : ""}
    <h2 class="sect">Members</h2>
    <div class="member-grid" data-tour="members">${members.map((m) => memberCard(m, m.id === me)).join("")}</div>
    ${spendVisible ? `
      <div class="split even" style="margin-top:18px">
        <div class="card"><h2>Where the money went</h2>${donut(slices, "cents", "email", (i) => PALETTE[i % PALETTE.length])}</div>
        ${isAdmin() ? `<div class="card"><h2>Activity</h2>${activityFeed()}</div>` : ""}
      </div>` : `
      <p class="hint" style="margin-top:14px">What each person spends is admin-only on this lab.
        Your own budget is at the top of this page.</p>`}
    ${isAdmin() ? shareSpendCard() : ""}
    ${editDialogHtml()}
  `;
}

/** Admin switch: whether members may see everyone's spend. */
function shareSpendCard() {
  const on = state.settings?.members_see_team_spend === true;
  return `
    <div class="card" style="margin-top:18px">
      <div class="card-head"><h2>Who can see spend</h2>
        <span class="pill ${on ? "warn" : "off"}">${on ? "Whole lab" : "Admins only"}</span></div>
      <label class="check switch">
        <input type="checkbox" id="share-spend" ${on ? "checked" : ""} />
        Members can see each other's spend
      </label>
      <p class="hint">${on
        ? "Every member sees all budgets, spend and the split chart on their Team tab."
        : "Each member sees only their own budget. Turn this on to open everyone's spend to the whole lab."}</p>
    </div>`;
}

const ACTION_LABELS = {
  register: "joined the team",
  "team.invite": "invited",
  "team.invite.revoke": "revoked an invite for",
  "admin.user.patch": "updated a member",
  "admin.balance.calibrate": "calibrated the balance",
  "instance.launch": "launched a VM",
  "instance.restart": "restarted a VM",
  "instance.terminate": "terminated a VM",
  "agent.approve": "connected an agent",
  "agent.deny": "denied an agent",
  "api_key.create": "created an agent token",
  "api_key.revoke": "revoked an agent token",
  "meter.kill": "had VMs stopped (out of budget)",
  "signup.otp_sent": "requested a sign-up code",
  "massed.connect": "connected the Massed account",
  "massed.disconnect": "disconnected the Massed account",
  "massed.connection_lost": "lost the Massed connection",
};

// Actions worth flagging in the fleet history: money, access and connections.
const AUDIT_KINDS = {
  "instance.launch": "money", "instance.terminate": "money", "meter.kill": "money",
  "admin.balance.calibrate": "money", "admin.user.patch": "money", "team.invite": "money",
  "massed.connect": "conn", "massed.disconnect": "conn", "massed.connection_lost": "conn",
};

function activityFeed(limit = 14) {
  if (!state.audit.length) return `<p class="lead">Nothing yet.</p>`;
  return `<ul class="feed">${state.audit.slice(0, limit).map((a) => {
    let extra = "";
    try {
      const d = JSON.parse(a.detail || "{}");
      extra = d.productName || d.email || d.device || (d.balance_cents != null ? money(d.balance_cents) : "") || "";
    } catch {}
    const kind = AUDIT_KINDS[a.action];
    return `<li>${kind ? `<i class="tag ${kind}"></i>` : ""}<b>${esc(a.email || "system")}</b> ${esc(ACTION_LABELS[a.action] || a.action)}${extra ? ` <span class="mono">${esc(extra)}</span>` : ""}
      <span class="s">${esc(fmtShort(a.created_at))}</span></li>`;
  }).join("")}</ul>`;
}

function editDialogHtml() {
  const e = state.edit;
  if (!e) return "";
  const u = e.user;
  const allowed = new Set(safeList(u.allowed_gpus));
  const all = allowed.has("*");
  return `
    <div class="modal-bg" id="modal-bg">
      <form class="modal card" id="edit-form">
        <div class="modal-head"><h1 style="font-size:18px">${esc(u.email)}</h1><button type="button" class="ghost" data-close>✕</button></div>
        <div class="two">
          <div><label>Budget left ($)</label><input name="budget" type="number" min="0" step="0.01" value="${(u.credit_cents / 100).toFixed(2)}" /></div>
          <div><label>Max concurrent VMs</label><input name="max_concurrent" type="number" min="0" max="32" value="${u.max_concurrent}" /></div>
        </div>
        <label>Role</label>
        <select name="role"><option value="user" ${u.role === "user" ? "selected" : ""}>Member</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option></select>
        <label>Allowed GPUs</label>
        <div class="checks">
          <label><input type="checkbox" name="gpu" value="*" ${all ? "checked" : ""} /> all GPUs</label>
          ${state.inventory.gpus.map((g) => `<label><input type="checkbox" name="gpu" value="${esc(g.productName)}" ${!all && allowed.has(g.productName) ? "checked" : ""} /> ${esc(g.productName)}</label>`).join("")}
        </div>
        <div class="actions"><button class="primary" type="submit">Save</button><button class="ghost slim" type="button" data-close>Cancel</button></div>
      </form>
    </div>`;
}

// ---------------------------------------------------------------- usage

function usageView() {
  const all = eventsWithUser();
  const ev = filteredEvents();
  const days = state.uf.range;
  const summary = state.usageSummary || {};
  const series = dailyParts(ev, days);
  const bySku = groupBy(ev, "product_name");
  const byUser = groupBy(ev, "email");
  const skus = groupBy(all, "product_name").map((g) => g.product_name);
  const users = groupBy(all, "email").map((g) => g.email);
  const total = series.reduce((n, s) => n + s.total, 0);
  const hours = ev.reduce((n, e) => n + Number(e.hours || 0), 0);
  const peak = series.reduce((a, b) => (b.total > a.total ? b : a), series[0] || { total: 0, day: new Date() });
  const sc = (i) => PALETTE[skus.indexOf(bySku[i].product_name) % PALETTE.length];
  const m = state.massed;
  return `
    <h1>Usage</h1>
    <p class="lead">${isAdmin() ? "Everything metered through this desk, by person and GPU." : "What your machines have cost, and what is left."}</p>
    <div class="filters sticky">
      <div class="seg">${[7, 14, 30, 90].map((n) => `<button data-range="${n}" class="${days === n ? "active" : ""}">${n}d</button>`).join("")}</div>
      ${isAdmin() ? `<select id="uf-user"><option value="">All people</option>${users.map((u) => `<option ${state.uf.user === u ? "selected" : ""}>${esc(u)}</option>`).join("")}</select>` : ""}
      <select id="uf-sku"><option value="">All GPUs</option>${skus.map((s) => `<option ${state.uf.sku === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
      ${state.uf.user || state.uf.sku ? `<button class="linkish" id="uf-clear">Clear filters</button>` : ""}
    </div>
    <div class="grid stats" data-tour="usage-stats">
      ${statCard({
        k: `Spend · ${days} days`, tone: "clay", icon: ICONS.trend,
        value: usd(total), spark: sparkline(series.map((s) => s.total), TONES.clay.tint),
      })}
      ${statCard({ k: "GPU-hours", tone: "slate", icon: ICONS.clock, value: counted(hours, "", 1), sub: `${ev.length} billing event${ev.length === 1 ? "" : "s"}` })}
      ${statCard({ k: "Daily average", tone: "plum", icon: ICONS.calendar, value: usd(total / days), sub: `across ${days} days` })}
      ${statCard({
        k: "Busiest day", tone: "gold", icon: ICONS.flame, value: usd(peak.total),
        sub: peak.total > 0 ? peak.day.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "no activity yet",
      })}
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="card-head"><h2>Daily spend by GPU</h2>
        <div class="legend inline">${bySku.slice(0, 6).map((g, i) => `<span><i style="background:${sc(i)}"></i>${esc(g.product_name)}</span>`).join("")}</div></div>
      ${ev.length ? stackedBars(series, skus) : `<p class="lead">No spend in this range.</p>`}
    </div>
    <div class="split even">
      <div class="card"><h2>Spend by GPU</h2>${donut(bySku, "cents", "product_name", (i) => sc(i))}</div>
      ${isAdmin() ? `<div class="card"><h2>Spend by person</h2>${hbars(byUser, "email")}</div>`
        : `<div class="card"><h2>Hours by GPU</h2>${hbars(bySku, "product_name", (i) => sc(i))}</div>`}
    </div>
    ${isAdmin() && summary.by_agent?.length ? `
    <div class="card" style="margin-top:14px">
      <div class="card-head"><h2>Spend by agent</h2><span class="hint">tokens approved in the browser flow</span></div>
      ${hbars(summary.by_agent, "agent", (i) => PALETTE[i % PALETTE.length])}
    </div>` : ""}
    ${isAdmin() && summary.unattributed_cents > 0 ? `
    <div class="card" style="margin-top:14px;--tone:${tone("brick").line}">
      <div class="card-head"><h2>Launched outside the desk</h2><span class="pill warn">${money(summary.unattributed_cents)}</span></div>
      <p class="hint">Billed to the lab's Massed account with no member or budget attached. See <b>Fleet</b> for the machines.</p>
    </div>` : ""}
    ${isAdmin() ? userGpuMatrix(ev) : ""}
    ${isAdmin() ? `
    <div class="card" style="margin-top:14px">
      <h2>Massed account burn · last 24h</h2>
      <p class="hint" style="margin:-4px 0 8px">Everything running upstream, sampled every 5 minutes${m ? ` · now ${money(m.burnCentsPerHour)}/hr` : ""}.</p>
      ${lineChart(state.watch?.ticks || [])}
    </div>` : ""}
    <div class="card" style="margin-top:14px">
      <h2>Billing events</h2>
      ${eventsTable(state.showAllEvents ? ev : ev.slice(0, 15))}
      ${ev.length > 15 && !state.showAllEvents ? `<button class="linkish" id="show-more" style="margin-top:10px">Show all ${ev.length}</button>` : ""}
    </div>
    <div style="margin-top:14px">${vmEventsCard(15)}</div>
  `;
}

function userGpuMatrix(ev) {
  if (!ev.length) return "";
  const skus = groupBy(ev, "product_name").map((g) => g.product_name).slice(0, 6);
  const users = groupBy(ev, "email");
  const cell = new Map();
  for (const e of ev) cell.set(`${e.email}|${e.product_name}`, (cell.get(`${e.email}|${e.product_name}`) || 0) + Number(e.cents || 0));
  const max = Math.max(1, ...cell.values());
  return `
    <div class="card" style="margin-top:14px"><h2>Who used which GPU</h2>
      <div class="scroll"><table class="matrix"><thead><tr><th></th>${skus.map((s) => `<th>${esc(s)}</th>`).join("")}<th>Total</th></tr></thead><tbody>
        ${users.map((u) => `<tr><td>${esc(u.email)}</td>${skus.map((s) => {
          const v = cell.get(`${u.email}|${s}`) || 0;
          const heat = v ? Math.max(0.1, Math.pow(v / max, 0.8)) : 0;
          return `<td class="heat${heat > 0.6 ? " strong" : ""}" style="--a:${heat.toFixed(2)}"><span class="mono">${v ? money(v) : ""}</span></td>`;
        }).join("")}<td class="mono"><b>${money(u.cents)}</b></td></tr>`).join("")}
      </tbody></table></div></div>`;
}

function eventsTable(rows) {
  if (!rows.length) return `<p class="lead">No events.</p>`;
  return `<div class="scroll"><table>
    <thead><tr><th>When</th>${isAdmin() ? "<th>Person</th>" : ""}<th>VM</th><th>GPU</th><th>Hours</th><th>Amount</th></tr></thead>
    <tbody>${rows.map((e) => `<tr>
      <td class="mono">${esc(fmtShort(e.created_at))}</td>${isAdmin() ? `<td>${esc(e.email)}</td>` : ""}
      <td class="mono">${esc((e.instance_name || e.instance_id || "").replace(/^rl_[0-9a-f]{8}_/, ""))}</td>
      <td class="mono">${esc(e.product_name)}</td><td class="mono">${Number(e.hours || 0).toFixed(3)}</td><td class="mono">${money(e.cents)}</td></tr>`).join("")}
    </tbody></table></div>`;
}

// ---------------------------------------------------------------- agents

function skillText() {
  return `---
name: gpu-proxy
description: Launch and manage GPU VMs for the user through their team's Massed Compute desk. Use when the user wants a GPU, to check what is running, what a job will cost, or to shut a machine down.
---

# GPU desk

Never call Massed Compute directly. The desk enforces the user's budget, allowed GPUs and VM cap.
You never see or handle an API key: a local helper holds a short-lived token that the user approved in their browser.

## One-time setup

\`\`\`sh
mkdir -p ~/.local/bin && curl -fsSL ${location.origin}/gpu-proxy.sh -o ~/.local/bin/gpu-proxy && chmod +x ~/.local/bin/gpu-proxy
~/.local/bin/gpu-proxy login
\`\`\`

\`login\` opens the user's browser and shows a confirmation code. Tell the user to approve it, then wait; it finishes by itself.
Access expires after 30 days — if a call says the token is missing or expired, run \`login\` again.

## Calls

\`gpu-proxy api METHOD PATH [JSON]\`

| Action | Call |
|---|---|
| Who am I, budget left | \`gpu-proxy api GET /api/me\` |
| GPUs I may rent (live price/stock) | \`gpu-proxy api GET /api/inventory\` |
| Pick the cheapest fit | \`gpu-proxy api POST /api/match '{"query":"fine-tune llama 8b, 24GB"}'\` |
| What is running (whole team) | \`gpu-proxy api GET /api/team\` |
| My VMs | \`gpu-proxy api GET /api/instances\` |
| Launch | \`gpu-proxy api POST /api/instances '{"productName":"gpu_1x_a6000"}'\` |
| SSH details | \`gpu-proxy api GET /api/instances/ID\` |
| Restart | \`gpu-proxy api POST /api/instances/ID/restart\` |
| Terminate (wipes disk) | \`gpu-proxy api POST /api/instances/ID/terminate\` |
| My usage | \`gpu-proxy api GET /api/usage\` |

## Playbook

1. \`GET /api/me\`. If budget is 0 or no GPUs are allowed, tell the user to ask a team admin.
2. Use \`/api/match\` with the job in plain words, or \`/api/inventory\` and pick the cheapest that fits. State the GPU and \`$/hr\` and get a yes before launching.
3. Launch, then poll \`GET /api/instances/ID\` until \`ip\` is set. Give \`ssh <username>@<ip>\`.
4. When the work is done, confirm with the user, then terminate.

## Rules

- 402/403 are policy (budget, allowlist, cap) — do not retry, report them.
- Terminate destroys the disk; there is no pause or snapshot. Always confirm first.
- Billing is hourly and runs until terminated. Do not leave machines idle.
- Do not read or print the token file. Do not touch other people's machines.
`;
}

function agentsView() {
  const agents = state.keys.filter((k) => k.kind === "agent");
  const other = state.keys.filter((k) => k.kind !== "agent");
  return `
    <h1>Agents</h1>
    <p class="lead">Let Claude or any agent use the desk without ever handing it a key. It runs a login command, you approve in the browser, and access expires on its own.</p>
    <div class="card steps" data-tour="agent-steps">
      <div class="step"><b>1</b><div class="grow"><div class="gpu-name">Give your agent the skill</div><div class="s">It contains no secrets — just how to install the helper and what to call.</div></div>
        <button class="primary slim" type="button" id="copy-skill">Copy for agent</button></div>
      <div class="step"><b>2</b><div class="grow"><div class="gpu-name">It runs <code>gpu-proxy login</code></div><div class="s">A browser tab opens here with a confirmation code.</div></div></div>
      <div class="step"><b>3</b><div class="grow"><div class="gpu-name">You approve</div><div class="s">The agent gets a token that lives only in a 0600 file on its machine and expires in 30 days.</div></div></div>
    </div>
    <h2 class="sect">Connected agents</h2>
    <div class="card">${agents.length ? `<table><thead><tr><th>Agent</th><th>Connected</th><th>Last used</th><th>Access</th><th></th></tr></thead><tbody>
      ${agents.map((k) => `<tr><td>${esc(k.name.replace(/^agent: /, ""))}</td><td class="mono">${esc(fmt(k.created_at))}</td>
        <td class="mono">${esc(fmt(k.last_used_at))}</td>
        <td><span class="pill ${daysLeft(k.expires_at) === "expired" ? "bad" : "run"}">${esc(daysLeft(k.expires_at))}</span></td>
        <td><button class="linkish danger" data-del-key="${k.id}">revoke</button></td></tr>`).join("")}</tbody></table>`
      : `<div class="empty" style="border:0;background:none;padding:28px 14px"><b>No agents connected yet.</b><p class="lead">Hand the skill to an agent, run <code>gpu-proxy login</code>, and it appears here.</p></div>`}</div>
    ${other.length ? `<h2 class="sect">Legacy keys</h2><div class="card"><table><tbody>
      ${other.map((k) => `<tr><td>${esc(k.name)}</td><td class="mono">${esc(k.key_prefix)}…</td><td><button class="linkish danger" data-del-key="${k.id}">revoke</button></td></tr>`).join("")}</tbody></table>
      <p class="hint">These never expire. Revoke them and reconnect through the browser flow instead.</p></div>` : ""}
    <details class="card" style="margin-top:14px"><summary>Preview the skill</summary><pre class="skill-preview">${esc(skillText())}</pre></details>
  `;
}

// ---------------------------------------------------------------- ssh keys

// Public-key formats OpenSSH writes into ~/.ssh/*.pub.
const SSH_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/]{20,}={0,3}(\s+[^\n]*)?$/;

const shortKey = (k) => {
  const s = String(k || "");
  return s.length > 52 ? `${s.slice(0, 30)}…${s.slice(-14)}` : s;
};

function localKeys() {
  try {
    const v = JSON.parse(localStorage.getItem("mc.ssh_keys") || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function setLocalKeys(list) {
  try { localStorage.setItem("mc.ssh_keys", JSON.stringify(list)); } catch {}
}

/** Read keys from the API when it exists, otherwise from this browser. */
async function loadSshKeys() {
  const r = await tryApi("/api/ssh-keys");
  if (r?.keys) {
    state.sshKeys = r.keys;
    state.caps.ssh_keys = true;
    return;
  }
  // carry over a key pasted into the old launch dialog, once
  const legacy = (() => { try { return localStorage.getItem("ssh_pub") || ""; } catch { return ""; } })();
  if (legacy && SSH_RE.test(legacy.trim()) && !localKeys().length) {
    setLocalKeys([{ id: `local-${Date.now()}`, name: "first key", public_key: legacy.trim(), created_at: new Date().toISOString() }]);
    try { localStorage.removeItem("ssh_pub"); } catch {}
  }
  state.sshKeys = localKeys();
}

async function addSshKey(name, publicKey) {
  const key = String(publicKey || "").trim();
  if (!SSH_RE.test(key)) {
    throw new Error("That is not an SSH public key. Paste the .pub file — it starts with ssh-ed25519, ssh-rsa or ecdsa-sha2-.");
  }
  if (state.caps.ssh_keys) {
    const r = await post("/api/ssh-keys", { name: name || "key", public_key: key });
    await loadSshKeys();
    return r;
  }
  const list = localKeys();
  list.unshift({ id: `local-${Date.now()}`, name: name || "key", public_key: key, created_at: new Date().toISOString() });
  setLocalKeys(list.slice(0, 10));
  state.sshKeys = localKeys();
}

async function removeSshKey(id) {
  if (state.caps.ssh_keys && !String(id).startsWith("local-")) {
    await api(`/api/ssh-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadSshKeys();
    return;
  }
  setLocalKeys(localKeys().filter((k) => k.id !== id));
  state.sshKeys = localKeys();
}

const preferredKey = () => state.sshKeys[0]?.public_key || "";

function sshKeysCard() {
  const keys = state.sshKeys || [];
  const t = tone("sand");
  const body = `
    <p class="hint">A VM's password never reaches an agent or the API, so a key is how you log in.
      Paste the <b>public</b> half — the file ending in <code>.pub</code>. It is not a secret.</p>
    <form id="ssh-form" class="ssh-form">
      <div class="row">
        <input name="name" placeholder="Name — e.g. laptop" maxlength="40" autocomplete="off" />
        <input name="public_key" placeholder="ssh-ed25519 AAAA… you@laptop" autocomplete="off" spellcheck="false" required />
      </div>
      <div class="row tight">
        <button class="primary slim" type="submit">Save key</button>
        <span class="hint">${state.caps.ssh_keys ? "" : "Kept in this browser until the keys API lands."}</span>
      </div>
    </form>
    ${keys.length
      ? `<ul class="keylist">${keys.map((k) => `
          <li>
            <i class="ico" style="--soft:${t.soft};--tint:${t.tint}">${ICONS.key}</i>
            <div class="grow"><div class="gpu-name">${esc(k.name || "key")}</div><div class="s mono">${esc(k.fingerprint || shortKey(k.public_key))}</div></div>
            <button class="linkish danger" data-del-ssh="${esc(k.id)}">remove</button>
          </li>`).join("")}</ul>`
      : `<p class="hint">No key yet? Run <code>ssh-keygen -t ed25519</code> and paste <code>~/.ssh/id_ed25519.pub</code> above.</p>`}`;
  // with nothing saved this is the first thing a new member needs, so keep it open
  if (!keys.length) {
    return `
      <div class="card ssh-card" data-tour="ssh">
        <div class="card-head"><h2>Your SSH keys</h2><span class="hint">none saved yet</span></div>
        ${body}
      </div>`;
  }
  // once a key is saved it is reference material, so it folds away and Launch stays on top
  return `
    <details class="card ssh-card" data-tour="ssh">
      <summary>
        <i class="chev" aria-hidden="true"></i>
        <span class="sum-title">Your SSH keys</span>
        <span class="hint">${keys.length} saved · ${esc(keys[0].name || "key")}</span>
      </summary>
      ${body}
    </details>`;
}

// ---------------------------------------------------------------- budget & machines

function budgetPanel() {
  const mine = activeMine();
  const burn = mine.reduce((n, i) => n + i.price_cents_per_hour, 0);
  const allocated = state.user.credit_cents + state.user.spent_cents;
  const left = allocated > 0 ? state.user.credit_cents / allocated : 0;
  const runway = burn > 0 && state.user.credit_cents > 0 ? hoursLabel(state.user.credit_cents / burn) : null;
  const cap = state.user.max_concurrent;
  const free = Math.max(0, cap - mine.length);
  const t = tone(left < 0.15 ? "brick" : left < 0.35 ? "gold" : "clay");
  return `
    <div class="card budget-panel" data-tour="budget" style="--tone:${t.line}">
      ${ring(left, `${Math.round(left * 100)}%`, "left")}
      <div class="grow">
        <div class="k">Your budget</div>
        <div class="v">${usd(state.user.credit_cents)}<small> left</small></div>
        <div class="budget-rows">
          <div><span class="k">Spent</span><b class="mono">${money(state.user.spent_cents)}</b></div>
          <div><span class="k">Allocated</span><b class="mono">${money(allocated)}</b></div>
          <div><span class="k">Burning now</span><b class="mono">${burn > 0 ? `${money(burn)}/hr` : "idle"}</b></div>
          <div><span class="k">Runway</span><b class="mono">${runway || "—"}</b></div>
        </div>
      </div>
      <div class="cap">
        <div class="k">Machines</div>
        <div class="v sm">${counted(mine.length)}<small> / ${cap}</small></div>
        <div class="track"><div class="fill" style="width:${Math.min(100, cap > 0 ? (mine.length / cap) * 100 : 100).toFixed(0)}%"></div></div>
        <div class="s">${free} slot${free === 1 ? "" : "s"} free</div>
      </div>
      ${state.user.credit_cents <= 0
        ? `<p class="notice warn">${ICONS.alert}Out of budget — running machines are stopped automatically. Ask an admin to top you up.</p>`
        : ""}
    </div>`;
}

function yourMachines() {
  const list = [...state.instances].sort((a, b) => {
    const ended = (i) => (i.status === "running" || i.status === "launching" ? 0 : 1);
    return ended(a) - ended(b) || new Date(b.launched_at) - new Date(a.launched_at);
  });
  if (!list.length) {
    return `<div class="card empty" data-tour="machines"><b>No machines yet.</b>
      <p class="lead">Launch a GPU below — it shows up here with its ssh command and running cost.</p></div>`;
  }
  const shown = state.showAllMachines ? list : list.slice(0, 4);
  const live = list.filter((i) => i.status === "running" || i.status === "launching").length;
  return `<div class="vm-grid" data-tour="machines">${shown.map((i) => vmCard(i, true)).join("")}</div>
    ${list.length > 4 && !state.showAllMachines
      ? `<button class="linkish" id="machines-more" style="margin-top:10px">Show all ${list.length} machines (${live} running)</button>`
      : ""}`;
}

// ---------------------------------------------------------------- fleet (admin)

function unattributedVms() {
  const watch = state.watch?.vms || [];
  if (!watch.length) return [];
  const ours = new Set();
  for (const i of state.fleet.instances || []) {
    if (i.mc_uuid) ours.add(i.mc_uuid);
    if (i.name) ours.add(i.name);
  }
  for (const i of state.instances) {
    if (i.mc_uuid) ours.add(i.mc_uuid);
    if (i.name) ours.add(i.name);
  }
  return watch.filter((v) => {
    if (v.ended_at) return false;
    // the watcher classifies each VM itself once attribution lands; trust it when present
    if (v.attribution) return v.attribution === "unattributed";
    return !ours.has(v.uuid) && !ours.has(v.name);
  });
}

/** Launch/terminate history with its actor. Admins see the whole lab, members see their own. */
async function loadVmEvents() {
  const r = (isAdmin() ? await tryApi("/api/admin/events") : null) || (await tryApi("/api/events"));
  state.vmEvents = r?.events ?? null;
  if (state.vmEvents) state.caps.vm_events = true;
}

const VM_KINDS = {
  launch: { label: "launched", cls: "run" },
  launch_failed: { label: "launch failed", cls: "bad" },
  restart: { label: "restarted", cls: "warn" },
  restart_failed: { label: "restart failed", cls: "bad" },
  terminate: { label: "terminated", cls: "off" },
  terminate_failed: { label: "terminate failed", cls: "bad" },
  budget_kill: { label: "stopped — out of budget", cls: "bad" },
  budget_kill_failed: { label: "budget stop failed", cls: "bad" },
  gone_upstream: { label: "disappeared upstream", cls: "warn" },
  stale_launch: { label: "launch timed out", cls: "warn" },
};

function vmEventsCard(limit = 30) {
  const ev = state.vmEvents;
  const title = isAdmin() ? "Launch &amp; terminate history" : "Your launch history";
  if (!ev) {
    return `<div class="card"><h2>${title}</h2>
      <p class="hint">Every launch, restart and terminate with the person or agent behind it. Showing the audit feed until the event route lands.</p>
      ${activityFeed(20)}</div>`;
  }
  if (!ev.length) return `<div class="card"><h2>${title}</h2><p class="lead">Nothing yet.</p></div>`;
  return `
    <div class="card"><h2>${title}</h2>
      <div class="scroll"><table><thead><tr><th>When</th><th>What</th><th>Actor</th><th>GPU</th><th>Rate</th></tr></thead><tbody>
        ${ev.slice(0, limit).map((e) => {
          const k = VM_KINDS[e.kind] || { label: e.kind, cls: "off" };
          const who = e.email || e.api_key_name || "system";
          const agent = e.actor === "agent" || !!e.api_key_id;
          return `<tr><td class="mono">${esc(fmtShort(e.created_at))}</td>
            <td><span class="pill ${k.cls}">${esc(k.label)}</span></td>
            <td>${esc(who)}${agent ? ` <span class="pill you">agent</span>` : ""}</td>
            <td class="mono">${esc(e.product_name || "—")}</td>
            <td class="mono">${e.price_cents_per_hour ? `${money(e.price_cents_per_hour)}/hr` : "—"}</td></tr>`;
        }).join("")}
      </tbody></table></div>
      ${ev.length > limit ? `<p class="hint">Showing the latest ${limit} of ${ev.length}.</p>` : ""}
    </div>`;
}

/** Manual balance readings and how far our estimate has drifted from them. */
async function loadCalibration() {
  if (!isAdmin()) return;
  const r = await tryApi("/api/admin/calibration");
  if (r) { state.calibration = r; state.caps.balance = true; }
}

async function loadBillingHistory() {
  if (!isAdmin()) return;
  const [b, c] = await Promise.all([tryApi("/api/admin/billing-history"), tryApi("/api/admin/connection-events")]);
  state.billing = b?.snapshots ?? null;
  state.connEvents = c?.events ?? null;
}

/** Lab settings an admin can flip; `members_see_team_spend` changes what teammates see. */
async function loadSettings() {
  if (!isAdmin()) return;
  const r = await tryApi("/api/admin/settings");
  if (r) state.settings = r;
}

const CONN_KINDS = {
  connected: "connected the lab account",
  refreshed: "refreshed the grant",
  refresh_failed: "grant refresh failed",
  rejected: "authorization was rejected",
  lost: "lost the connection",
  disconnected: "disconnected the account",
  designated: "chose which account is the lab's",
  "massed.connection_lost": "lost the connection",
};

/** Which admin's Massed account the whole lab bills through. */
function connectionHistoryCard() {
  const ev = state.connEvents;
  const bill = state.billing;
  const lab = state.lab;
  const admins = lab?.admins_connected || [];
  return `
    <div class="card">
      <div class="card-head"><h2>Connection &amp; billing settings</h2>
        ${bill?.length ? `<span class="hint">${bill.length} billing snapshot${bill.length === 1 ? "" : "s"}</span>` : ""}</div>
      <p class="hint">Who connected the lab's Massed account, when the grant was renewed, and the recharge settings
        Massed last reported.</p>
      ${admins.length > 1 ? `
        <label>Lab account</label>
        <div class="row tight">
          <select id="lab-designate">${admins.map((a) => `<option value="${esc(a.user_id)}" ${lab?.lab_admin?.user_id === a.user_id ? "selected" : ""}>${esc(a.email)} — ${esc(a.status)}</option>`).join("")}</select>
          <button class="ghost slim" id="lab-designate-go">Use this account</button>
        </div>` : ""}
      ${bill?.length ? `<div class="chip-row">${bill.slice(0, 4).map((s) => `
        <div class="chip"><span class="k">${esc(s.billing_method || "billing")}</span>
          <b class="mono">${money(s.recharge_amount_cents)}</b>
          <span class="s">top-up at ${money(s.recharge_threshold_cents)} · ${esc(fmtShort(s.taken_at))}</span></div>`).join("")}</div>` : ""}
      ${ev?.length ? `<ul class="feed">${ev.slice(0, 10).map((e) => `
        <li><i class="tag conn"></i><b>${esc(e.email || "system")}</b> ${esc(CONN_KINDS[e.kind] || e.kind)}
          <span class="s">${esc(fmtShort(e.created_at))}</span></li>`).join("")}</ul>`
        : `<p class="hint">No connection changes recorded yet.</p>`}
    </div>`;
}

function calibrateCard() {
  const on = state.caps.balance;
  const c = state.calibration;
  const last = c?.entries?.[0];
  const ratio = last?.window?.ratio;
  return `
    <div class="card" data-tour="calibrate">
      <div class="card-head"><h2>Balance calibration</h2>
        ${on ? (c?.latest_balance_cents != null ? `<span class="hint">last reading ${esc(fmtShort(c.latest_at))}</span>` : `<span class="pill off">no reading yet</span>`) : `<span class="pill off">Not wired yet</span>`}</div>
      <p class="hint">Massed's API never returns a dollar balance, so our figure is an estimate. Type in what the
        Massed billing page shows and the desk measures its own drift against it.</p>
      ${on && c?.latest_balance_cents != null ? `
        <div class="kv">
          <div><span class="k">Last typed balance</span><b class="mono">${money(c.latest_balance_cents)}</b></div>
          <div><span class="k">Estimated now</span><b class="mono">${c.estimated_balance_cents != null ? money(c.estimated_balance_cents) : "—"}</b></div>
          ${last?.window ? `<div><span class="k">Last window: actual vs ours</span><b class="mono">${money(last.window.actual_spend_cents)} / ${money(last.window.estimated_spend_cents)}</b></div>` : ""}
          ${ratio != null ? `<div><span class="k">Drift</span><b>${ratio > 1.02 ? `<span class="pill warn">we under-count ${Math.round((ratio - 1) * 100)}%</span>` : ratio < 0.98 ? `<span class="pill warn">we over-count ${Math.round((1 - ratio) * 100)}%</span>` : `<span class="pill run">within 2%</span>`}</b></div>` : ""}
        </div>` : ""}
      <form id="calibrate-form">
        <div class="two">
          <div><label>Account balance ($)</label>
            <input name="balance" type="number" step="0.01" min="0" placeholder="e.g. 412.50" ${on ? "" : "disabled"} required /></div>
          <div><label>Added since last count ($) <span class="opt">optional</span></label>
            <input name="topup" type="number" step="0.01" min="0" value="0" ${on ? "" : "disabled"} /></div>
        </div>
        <div class="row tight">
          <input name="note" placeholder="Note (optional)" maxlength="120" ${on ? "" : "disabled"} />
          <button class="primary slim" type="submit" ${on ? "" : "disabled"}>Save reading</button>
        </div>
      </form>
      <p class="hint">${on ? "Used to check our estimate only — it never changes a member's budget."
        : "The endpoint for this is requested in <code>docs/HANDOFF.md</code> under “UI requests”."}</p>
    </div>`;
}

const LAB_PILL = {
  connected: { cls: "run", label: "Connected", toneName: "olive" },
  mock: { cls: "off", label: "Mock mode", toneName: "sand" },
  api_key: { cls: "warn", label: "Operator key", toneName: "gold" },
  lost: { cls: "bad", label: "Connection lost", toneName: "brick" },
  not_connected: { cls: "off", label: "Not connected", toneName: "sand" },
};

/**
 * Lab-wide Massed status. /api/lab/status is the new one; until it is routed we fall back
 * to this admin's own connection so the card still tells the truth.
 */
async function loadLab() {
  const r = await tryApi("/api/lab/status");
  if (r?.state) {
    state.lab = r;
    state.caps.lab_status = true;
    return;
  }
  const c = await tryApi("/api/massed/connection");
  if (!c) {
    state.lab = null;
    return;
  }
  state.lab = c.connected
    ? {
        state: "connected", healthy: true, can_launch: true,
        message: "Connected to Massed Compute over OAuth. Machine passwords are redacted, so launches need an SSH key.",
        scope: c.scope, connected_at: c.connected_at, last_used_at: c.last_used_at,
        access_expires_at: c.access_expires_at, last_error: c.last_error,
      }
    : {
        state: c.status === "lost" ? "lost" : "not_connected",
        healthy: false, can_launch: false, lost_since: c.lost_at ?? null,
        message: c.status === "lost"
          ? "The connection to Massed Compute was lost. Launching and metering are paused until an admin reconnects."
          : "No Massed Compute account is connected yet. An admin needs to connect one.",
      };
}

/** OAuth to Massed redacts VM passwords, so a member with no saved key cannot log in. */
const needsSshKey = () => state.lab?.state === "connected" && !(state.sshKeys || []).length;

function labCard() {
  const lab = state.lab;
  const p = LAB_PILL[lab?.state] || { cls: "off", label: "Checking…", toneName: "sand" };
  const t = tone(p.toneName);
  const pr = state.labProbe;
  return `
    <div class="card lab" data-tour="lab" style="--tone:${t.line}">
      <div class="card-head"><h2>Lab account</h2><span class="pill ${p.cls}">${esc(p.label)}</span></div>
      <p class="hint">${esc(lab?.message || "Checking the Massed Compute connection…")}</p>
      ${lab?.lab_admin ? `
        <div class="kv">
          <div><span class="k">Connected by</span><b>${esc(lab.lab_admin.email)}</b></div>
          <div><span class="k">Access</span><b>${lab.scope === "full" ? "Full — launch + read" : esc(lab.scope || "—")}</b></div>
          <div><span class="k">Connected</span><b>${esc(fmt(lab.connected_at))}</b></div>
          <div><span class="k">Last used</span><b>${esc(fmt(lab.last_used_at))}</b></div>
        </div>` : ""}
      ${lab?.lost_since ? `<p class="notice warn">${ICONS.alert}Lost since ${esc(fmt(lab.lost_since))} — members cannot launch until it is restored.</p>` : ""}
      ${lab?.last_error && lab.state !== "not_connected" ? `<p class="notice warn">${ICONS.alert}${esc(lab.last_error)}</p>` : ""}
      ${lab?.schema_ok === false ? `
        <p class="notice warn">${ICONS.alert}Massed changed the shape of its launch tools, so launches are paused until this clears.
          ${lab.schema_checked_at ? ` Last checked ${esc(fmtShort(lab.schema_checked_at))}.` : ""}</p>
        ${Array.isArray(lab.schema_problems) && lab.schema_problems.length
          ? `<ul class="issues">${lab.schema_problems.slice(0, 6).map((p) => `<li class="mono">${esc(typeof p === "string" ? p : JSON.stringify(p))}</li>`).join("")}</ul>`
          : ""}
        <div class="actions"><button class="ghost slim" id="lab-schema">Re-check the tool schemas</button></div>` : ""}
      ${lab?.schema_error ? `<p class="hint">Schema check could not read Massed's tools: ${esc(lab.schema_error)}</p>` : ""}
      ${lab?.api_key_fallback && lab.state !== "api_key" ? `<p class="notice">${ICONS.plug}The operator API key is configured as a fallback transport.</p>` : ""}
      ${Array.isArray(lab?.admins_connected) && lab.admins_connected.length
        ? `<p class="hint">Admin connections: ${lab.admins_connected.map((a) => `${esc(a.email)} (${esc(a.status)})`).join(", ")}</p>` : ""}
      <div class="actions">
        <button class="primary slim" id="lab-connect">${lab?.state === "connected" ? "Reconnect" : "Connect Massed Compute"}</button>
        ${lab?.state === "connected" ? `<button class="ghost slim" id="lab-probe">Test access</button>
          <button class="ghost slim danger" id="lab-disconnect">Disconnect</button>` : ""}
      </div>
      ${pr ? `
        <div class="probe">
          <div class="hl"><span>${pr.results.filter((r) => r.ok).length} of ${pr.results.length} checks passed</span>
            <span class="mono">${pr.results.reduce((n, r) => n + r.ms, 0)} ms</span></div>
          ${pr.results.map((r) => `<div class="probe-row"><span class="badge ${r.ok ? "ok" : "bad"}">${r.ok ? "ok" : "fail"}</span>
            <code>${esc(r.tool)}</code><span class="s">${esc(r.ok ? r.summary : r.error || "")}</span></div>`).join("")}
        </div>` : ""}
    </div>`;
}

/** The one-line version members see, on Home and Team. */
function labLine() {
  const lab = state.lab;
  if (!lab) return "";
  const p = LAB_PILL[lab.state] || LAB_PILL.not_connected;
  return `
    <div class="card lab-line">
      <span class="pill ${p.cls}">${esc(p.label)}</span>
      <span class="hint">${esc(lab.message)}</span>
    </div>`;
}

function fleetView() {
  const rows = state.fleet.instances || [];
  const unattributed = unattributedVms();
  const live = rows.filter((i) => i.status === "running" || i.status === "launching");
  const burn = live.reduce((n, i) => n + (i.price_cents_per_hour || 0), 0);
  const ticks = state.watch?.ticks || [];
  const lastTick = ticks[0];
  const looseBurn = lastTick?.unattributed_burn_cents_per_hour || 0;
  return `
    <h1>Fleet</h1>
    <p class="lead">The lab's Massed account, every machine the desk knows about, and anything running outside it.</p>
    <div class="split even">
      ${labCard()}
      <div class="card" data-tour="unattributed" style="--tone:${tone(unattributed.length ? "brick" : "olive").line}">
        <div class="card-head"><h2>Unattributed machines</h2>
          <span class="pill ${unattributed.length ? "warn" : "run"}">${unattributed.length ? `${unattributed.length} running` : "none"}</span></div>
        <p class="hint">Running upstream but not launched through this desk, so no member and no budget covers them.
          They still bill the lab's account.</p>
        ${looseBurn > 0 ? `<p class="notice warn">${ICONS.alert}About ${money(looseBurn)}/hr of the lab's burn has no owner.</p>` : ""}
        ${unattributed.length
          ? `<div class="scroll"><table><thead><tr><th>Name</th><th>GPU</th><th>Rate</th><th>Seen</th><th>Charge to</th></tr></thead><tbody>
              ${unattributed.map((v) => `<tr><td class="mono">${esc(v.name)}</td><td class="mono">${esc(v.product_name || "—")}</td>
                <td class="mono">${moneyOr(v.price_cents_per_hour)}/hr</td><td class="mono">${esc(fmtShort(v.last_seen_at))}</td>
                <td><div class="row tight"><select data-attr-user="${esc(v.uuid)}">
                  <option value="">— nobody —</option>
                  ${(state.team.members || []).map((m) => `<option value="${esc(m.id)}" ${v.user_id === m.id ? "selected" : ""}>${esc(m.email)}</option>`).join("")}
                </select><button class="ghost slim" data-attr-go="${esc(v.uuid)}">Assign</button></div></td></tr>`).join("")}
            </tbody></table></div>
            <p class="hint">Assigning a machine charges its spend to that member.</p>`
          : `<p class="hint">${state.watch?.vms?.length ? "Everything running upstream is accounted for." : "Nothing sampled from Massed yet — the watcher runs on a schedule."}</p>`}
      </div>
    </div>
    <div class="grid stats">
      ${statCard({ k: "Lab machines", tone: "slate", icon: ICONS.server, value: counted(live.length),
        sub: `${money(burn)}/hr at current rates` })}
      ${statCard({ k: "Known machines", tone: "clay", icon: ICONS.receipt, value: counted(rows.length), sub: "all time, this desk" })}
      ${statCard({ k: "Unattributed", tone: unattributed.length ? "brick" : "olive", icon: ICONS.alert,
        value: counted(unattributed.length), sub: unattributed.length ? "billing with no budget" : "nothing loose" })}
      ${statCard({ k: "Sampled spend", tone: "gold", icon: ICONS.coins,
        value: usd(state.watch?.summary?.cents || 0), sub: `${Number(state.watch?.summary?.hours || 0).toFixed(1)}h across ${state.watch?.summary?.vm_count || 0} machines` })}
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="card-head"><h2>Machines</h2><span class="hint">newest first</span></div>
      ${rows.length
        ? `<div class="scroll"><table><thead><tr><th>Machine</th><th>Owner</th><th>GPU</th><th>Status</th><th>Rate</th><th>Billed</th><th>Launched</th><th>Ended</th></tr></thead><tbody>
            ${rows.map((i) => `<tr><td class="mono">${esc((i.name || "").replace(/^rl_[0-9a-f]{8}_/, ""))}</td>
              <td>${esc(i.email || "—")}</td><td class="mono">${esc(i.product_name)}</td>
              <td><span class="pill ${i.status === "running" ? "run" : i.status === "terminated" ? "off" : "warn"}">${esc(i.status)}</span></td>
              <td class="mono">${moneyOr(i.price_cents_per_hour)}/hr</td>
              <td class="mono">${i.billed_cents != null ? money(i.billed_cents) : "—"}</td>
              <td class="mono">${esc(fmtShort(i.launched_at))}</td>
              <td class="mono">${esc(i.terminated_at ? fmtShort(i.terminated_at) : "—")}</td></tr>`).join("")}
          </tbody></table></div>`
        : `<p class="lead">No machines recorded yet.</p>`}
    </div>
    <div class="split even">
      ${calibrateCard()}
      ${connectionHistoryCard()}
    </div>
    <div style="margin-top:14px">${vmEventsCard(40)}</div>
  `;
}

// ---------------------------------------------------------------- onboarding

const tourKey = (id) => `mc.onboard.v1:${id}`;
// recorded server-side so a new browser or device does not re-open the tour
const TOUR_SEEN = "tour_seen";

// Steps are declarative: `tab` switches first, `target` gets spotlit when it exists.
const TOUR = {
  admin: [
    { id: "connect", tab: "fleet", target: '[data-tour="lab"]', title: "Connect the lab's Massed account",
      body: "Live machines, burn rate and upstream usage all come from this connection. Connect it once, and reconnect if Massed revokes the grant." },
    { id: "invite", tab: "team", target: '[data-tour="invite"]', title: "Invite a teammate",
      body: "Add their email with a starting budget. They sign up with that address, confirm a one-time code, then launch on the lab's account." },
    { id: "limits", tab: "team", target: '[data-tour="members"]', title: "Set budgets and GPU allowlists",
      body: "Click any member to set how much they have left, how many machines they can run at once, and which GPUs they may rent." },
    { id: "overview", tab: "home", target: '[data-tour="stats"]', title: "Watch spend from Overview",
      body: "Team burn, 14-day spend and each budget at a glance. A ring turns amber, then red, as the money runs down." },
    { id: "usage", tab: "usage", target: '[data-tour="usage-stats"]', title: "Break spend down in Usage",
      body: "Filter by person, GPU and date range. Anything launched outside the desk lands in its own bucket instead of on a member." },
    { id: "unattributed", tab: "fleet", target: '[data-tour="unattributed"]', title: "Catch unattributed machines",
      body: "Machines started straight on Massed bill the account with no member and no budget behind them. They surface here." },
  ],
  user: [
    { id: "ssh", tab: "home", target: '[data-tour="ssh"]', title: "Add your SSH public key",
      body: "Agents and the API never see a machine's password, so a key is how you log in. Save it once and every launch reuses it." },
    { id: "launch", tab: "home", target: '[data-tour="launch"]', title: "Launch your first GPU",
      body: "Filter by price or stock, then hit Launch. Unsure what fits? Describe the job in plain words and the desk picks the cheapest match." },
    { id: "budget", tab: "home", target: '[data-tour="budget"]', title: "Know your budget",
      body: "What is left, what you have spent, and how long it lasts at the current burn rate. Machines stop on their own when you hit zero." },
    { id: "machines", tab: "home", target: '[data-tour="machines"]', title: "Connect to a machine",
      body: "Every running machine shows the exact ssh command, or a generated password if you did not attach a key.", needsVms: true },
    { id: "agent", tab: "agents", target: '[data-tour="agent-steps"]', title: "Let an agent drive the desk",
      body: "Copy the skill into your agent, run gpu-proxy login, and approve it here. It stays inside your budget and never holds a key." },
  ],
};

function tourSteps() {
  const all = TOUR[isAdmin() ? "admin" : "user"];
  return all.filter((s) => !s.needsVms || state.instances.length > 0);
}

function onboardState() {
  const id = state.user?.id || "anon";
  if (!state.onboard || state.onboard.id !== id) {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(tourKey(id)) || "null"); } catch {}
    // `seen` gates the one-time auto-open; `done` hides the checklist for good
    state.onboard = { id, done: !!stored?.done, seen: !!stored?.seen };
  }
  return state.onboard;
}

function saveOnboard() {
  const o = onboardState();
  try { localStorage.setItem(tourKey(o.id), JSON.stringify({ done: o.done, seen: o.seen })); } catch {}
  if (!state.caps.onboarding) return;
  // Which steps are finished is derived from data server-side, so the only things worth
  // reporting are the dismissal and the fact that the tour has been shown at all.
  const body = { done: o.done };
  if (o.seen && !state.onboardSeenRemote) {
    body.steps = [TOUR_SEEN];
    state.onboardSeenRemote = true;
  }
  post("/api/onboarding", body).catch(() => {});
}

/** Steps the live data says are already true, so the checklist reflects reality. */
function autoSteps() {
  const s = new Set();
  if (isAdmin()) {
    const lab = state.lab;
    if (lab?.state && lab.state !== "not_connected" && lab.state !== "lost") s.add("connect");
    if (state.team.members.length > 1 || (state.team.invites || []).length) s.add("invite");
    if (state.team.members.some((m) => !safeList(m.allowed_gpus).includes("*"))) s.add("limits");
    if (state.usage.length) s.add("overview");
    if (state.usage.length) s.add("usage");
    if ((state.watch?.vms || []).length) s.add("unattributed");
  } else {
    if (state.sshKeys.length) s.add("ssh");
    if (state.instances.length) s.add("launch");
    if (state.user.credit_cents > 0 || state.user.spent_cents > 0) s.add("budget");
    if (state.instances.some((i) => i.status === "running")) s.add("machines");
    if (state.keys.some((k) => k.kind === "agent")) s.add("agent");
  }
  return s;
}

/** A step counts as done when the data says so — merely viewing it proves nothing. */
function stepsDone() {
  const s = autoSteps();
  for (const id of state.onboardAuto || []) s.add(id);
  return s;
}

function onboardCard() {
  const steps = tourSteps();
  const done = stepsDone();
  const left = steps.filter((s) => !done.has(s.id));
  if (!left.length) return "";
  return `
    <div class="card onboard" data-tour="onboard">
      <div class="card-head">
        <h2>${isAdmin() ? "Set up your lab" : "Get started"}</h2>
        <div class="row tight">
          <button class="ghost slim" id="onboard-tour">${ICONS.help} Walk me through it</button>
          <button class="ghost slim" id="onboard-dismiss" aria-label="Dismiss this checklist" title="Hide this checklist">✕</button>
        </div>
      </div>
      <p class="hint">${left.length} of ${steps.length} steps left. The <b>?</b> in the header brings this back any time.</p>
      <ul class="checklist">
        ${steps.map((s) => {
          const ok = done.has(s.id);
          return `<li class="${ok ? "done" : ""}"><i>${ok ? ICONS.check : ""}</i>
            <span>${esc(s.title)}</span>
            <button class="linkish" data-tour-go="${s.id}">${ok ? "Review" : "Show me"}</button></li>`;
        }).join("")}
      </ul>
    </div>`;
}

/** `at` pins a step; otherwise the tour resumes at the first thing still not done. */
async function tourOpen(at = null) {
  const steps = tourSteps();
  if (!steps.length) return;
  const o = onboardState();
  o.seen = true;
  saveOnboard();
  const done = stepsDone();
  const firstLeft = steps.findIndex((s) => !done.has(s.id));
  state.tour = { open: true, i: at != null ? at : firstLeft < 0 ? 0 : firstLeft };
  await tourShow();
}

async function tourShow() {
  const steps = tourSteps();
  if (!state.tour?.open || !steps.length) return;
  state.tour.i = Math.min(Math.max(0, state.tour.i), steps.length - 1);
  const step = steps[state.tour.i];
  if (step.tab && step.tab !== state.tab) {
    await switchTab(step.tab);
  }
  const el = step.target ? $(step.target) : null;
  // a spotlighted card may be collapsed; open it so the step has something to show
  const fold = el?.closest("details");
  if (fold && !fold.open) fold.open = true;
  // the page scrolls smoothly, so jump rather than animate: the spotlight must measure the
  // settled layout, or it lands in the wrong place
  if (el) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  paintTour();
  if (el) {
    requestAnimationFrame(positionTour);
    setTimeout(() => { if (state.tour?.open) positionTour(); }, 340);
  }
  if (state.tab === "home") paintView();
}

/** Hide the tour without recording it as finished, so the page underneath stays usable. */
function tourPause() {
  if (!state.tour?.open) return;
  state.tour = null;
  $("#tour")?.remove();
}

function paintTour() {
  const host = $("#tour") || (() => {
    const d = document.createElement("div");
    d.id = "tour";
    document.body.appendChild(d);
    return d;
  })();
  if (!state.tour?.open) return host.remove();
  const steps = tourSteps();
  const i = state.tour.i;
  const step = steps[i];
  const last = i === steps.length - 1;
  host.innerHTML = `
    <div class="tour-veil" id="tour-veil" hidden></div>
    <div class="tour-hole" id="tour-hole" hidden></div>
    <div class="tour-card card" id="tour-card" role="dialog" aria-modal="true" aria-label="${esc(step.title)}">
      <div class="tour-top">
        <span class="tour-n">Step ${i + 1} of ${steps.length}</span>
        <button type="button" class="ghost" id="tour-x" aria-label="Close the tour">✕</button>
      </div>
      <h2>${esc(step.title)}</h2>
      <p>${esc(step.body)}</p>
      <div class="tour-dots">${steps.map((_, n) => `<i class="${n === i ? "on" : ""}"></i>`).join("")}</div>
      <div class="actions">
        <button class="ghost slim" id="tour-prev" ${i === 0 ? "disabled" : ""}>Back</button>
        <button class="primary slim" id="tour-next">${last ? "Got it" : "Next"}</button>
        <button class="linkish" id="tour-skip">Skip</button>
      </div>
    </div>`;
  positionTour();
  // leaving the tour only hides it: the checklist card is the lasting reminder, and only its
  // own ✕ retires that
  $("#tour-x").onclick = () => tourPause();
  $("#tour-skip").onclick = () => tourPause();
  $("#tour-prev").onclick = () => { if (state.tour.i > 0) { state.tour.i--; tourShow(); } };
  $("#tour-next").onclick = () => {
    if (!last) { state.tour.i++; tourShow(); return; }
    tourPause();
    if (state.tab !== "home") switchTab("home");
  };
}

/** Below this width the tour card docks to the bottom, clear of the header and the nav. */
const TOUR_DOCK_WIDTH = 780;

function positionTour() {
  if (!state.tour?.open) return;
  const hole = $("#tour-hole");
  const veil = $("#tour-veil");
  const card = $("#tour-card");
  if (!card || !hole || !veil) return;
  const step = tourSteps()[state.tour.i];
  const el = step?.target ? $(step.target) : null;
  const r = el?.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const onScreen = !!r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh;
  const docked = vw <= TOUR_DOCK_WIDTH;
  let holeBox = null;
  if (onScreen) {
    const pad = 8;
    holeBox = {
      x: Math.max(6, Math.min(vw - 12, r.left - pad)),
      y: Math.max(6, r.top - pad),
      w: Math.min(vw - 12, r.width + pad * 2),
      h: r.height + pad * 2,
    };
    hole.hidden = false;
    veil.hidden = true;
    hole.style.cssText = `left:${holeBox.x}px;top:${holeBox.y}px;width:${holeBox.w}px;height:${holeBox.h}px`;
  } else {
    // nothing to point at: dim the page and let the CSS place the card
    hole.hidden = true;
    veil.hidden = false;
  }

  // The card must never sit over the header or the nav, or taps on them are swallowed.
  // On a phone that means docking to the bottom of the viewport; on wider screens the card
  // is clamped below the sticky header.
  if (docked) {
    card.classList.add("docked");
    card.classList.remove("centered");
    card.style.cssText = "";
    return;
  }
  card.classList.remove("docked");
  if (!onScreen) {
    card.classList.add("centered");
    card.style.cssText = "";
    return;
  }
  card.classList.remove("centered");
  const headerBottom = Math.round($(".top")?.getBoundingClientRect().bottom || 0);
  const topLimit = headerBottom + 10;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  let cy = holeBox.y + holeBox.h + 14;
  if (cy + ch > vh - 12) cy = holeBox.y - ch - 14;
  // never above the header, never off the bottom
  cy = Math.max(topLimit, Math.min(cy, Math.max(topLimit, vh - ch - 12)));
  const cx = Math.min(
    Math.max(12, holeBox.x + holeBox.w / 2 - cw / 2),
    Math.max(12, vw - cw - 12),
  );
  card.style.cssText = `left:${cx}px;top:${cy}px`;
}

let autoTourArmed = false;
function maybeAutoTour() {
  if (autoTourArmed || !state.user || state.connect) return;
  const o = onboardState();
  // "Already seen" is an account fact, not a browser one: the server flag stops a new device
  // from being shown the tour again. Opening it once is the whole point, and afterwards the
  // checklist card carries the same information.
  if (o.done || o.seen || state.onboardSeenRemote) return;
  autoTourArmed = true;
  setTimeout(() => {
    if (!state.tour?.open && state.user && state.tab === "home") tourOpen();
  }, 500);
}

// ---------------------------------------------------------------- bindings

function bindView() {
  $("#match-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    state.matchQuery = String(new FormData(e.target).get("query") || "");
    state.matching = true;
    paintView();
    try {
      state.match = await post("/api/match", { query: state.matchQuery });
    } catch (err) {
      flash(err.message);
    }
    state.matching = false;
    paintView();
  });
  const regrid = () => { $("#gpu-grid").innerHTML = gpuGridHtml(); bindLaunchButtons(); };
  $("#f-q")?.addEventListener("input", (e) => { state.filter.q = e.target.value; regrid(); });
  $("#f-sort")?.addEventListener("change", (e) => { state.filter.sort = e.target.value; regrid(); });
  $("#f-stock")?.addEventListener("change", (e) => { state.filter.stock = e.target.checked; regrid(); });
  bindLaunchButtons();

  const close = () => { state.launch = null; state.edit = null; paintView(); };
  for (const b of $$("[data-close]")) b.addEventListener("click", close);
  $("#modal-bg")?.addEventListener("mousedown", (e) => { if (e.target.id === "modal-bg") close(); });
  // choosing "paste a different key" reveals the textarea
  $('select[name="savedKey"]')?.addEventListener("change", (e) => {
    const ta = $('textarea[name="sshPublicKey"]');
    if (ta) ta.hidden = e.target.value !== "";
  });

  $("#launch-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ssh = String(fd.get("savedKey") || "").trim() || String(fd.get("sshPublicKey") || "").trim();
    if (ssh && !SSH_RE.test(ssh)) {
      flash("That SSH key does not look like a public key line. Paste the .pub file.");
      return;
    }
    if (needsSshKey() && !ssh) {
      flash("Add an SSH public key first — this lab reaches Massed over OAuth, which does not return machine passwords.");
      return;
    }
    // a first key typed here is worth keeping so the next launch is one click
    if (ssh && !(state.sshKeys || []).length) {
      try { await addSshKey("first key", ssh); } catch {}
    }
    const body = { productName: state.launch.productName };
    if (fd.get("instanceName")) body.instanceName = String(fd.get("instanceName"));
    if (fd.get("imageId")) body.imageId = Number(fd.get("imageId"));
    if (fd.get("regionName")) body.regionName = String(fd.get("regionName"));
    if (ssh) body.sshPublicKey = ssh;
    state.launch.busy = true;
    paintView();
    try {
      const { instance } = await post("/api/instances", body);
      state.launch = null;
      state.open.add(instance.id);
      flash(`Launching ${body.productName}…`, "ok");
      await refreshMe();
      await refreshTab();
    } catch (err) {
      state.launch = null;
      paintView();
      flash(err.message);
    }
  });

  for (const b of $$("[data-copy]")) b.addEventListener("click", () => copyText(b.dataset.copy, b, b.textContent));
  for (const b of $$("[data-range]")) b.addEventListener("click", () => { state.uf.range = Number(b.dataset.range); paintView(); });
  $("#uf-user")?.addEventListener("change", (e) => { state.uf.user = e.target.value; paintView(); });
  $("#uf-sku")?.addEventListener("change", (e) => { state.uf.sku = e.target.value; paintView(); });
  $("#uf-clear")?.addEventListener("click", () => { state.uf.user = ""; state.uf.sku = ""; paintView(); });
  $("#show-more")?.addEventListener("click", () => { state.showAllEvents = true; paintView(); });

  for (const b of $$("[data-toggle]")) {
    b.addEventListener("click", async () => {
      const id = b.dataset.toggle;
      if (state.open.has(id)) { state.open.delete(id); paintView(); return; }
      state.open.add(id);
      paintView();
      await loadDetail(id);
    });
  }
  for (const b of $$("[data-kill]")) {
    b.addEventListener("click", async () => {
      if (!confirm("Terminate destroys the disk and stops billing. Continue?")) return;
      try {
        const r = await post(`/api/instances/${b.dataset.kill}/terminate`);
        flash(r?.settled_cents != null ? `Terminated — final charge ${money(r.settled_cents)}.` : "Terminated.", "ok");
        await refreshMe();
      } catch (err) { flash(err.message); }
      refreshTab();
    });
  }
  for (const b of $$("[data-restart]")) {
    b.addEventListener("click", async () => {
      try {
        await post(`/api/instances/${b.dataset.restart}/restart`);
        flash("Restart requested.", "ok");
      } catch (err) { flash(err.message); }
      refreshTab();
    });
  }

  $("#invite-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await post("/api/team/invites", {
        email: fd.get("email"),
        credit_cents: Math.round(Number(fd.get("budget")) * 100),
        max_concurrent: Number(fd.get("max_concurrent")),
        role: fd.get("role"),
      });
      flash(`${fd.get("email")} can now sign up.`, "ok");
      await refreshTab();
    } catch (err) { flash(err.message); }
  });
  $("#share-spend")?.addEventListener("change", async (e) => {
    const next = e.target.checked;
    e.target.disabled = true;
    try {
      state.settings = await api("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ members_see_team_spend: next }),
      });
      flash(next ? "Members can see each other's spend now." : "Spend is admin-only again.", "ok");
    } catch (err) {
      flash(err.message);
    }
    refreshTab();
  });
  for (const b of $$("[data-revoke-invite]")) {
    b.addEventListener("click", async () => {
      await api(`/api/team/invites/${encodeURIComponent(b.dataset.revokeInvite)}`, { method: "DELETE" });
      refreshTab();
    });
  }
  for (const c of $$("[data-edit]")) {
    c.addEventListener("click", () => {
      const m = state.team.members.find((x) => x.id === c.dataset.edit);
      if (m) { state.edit = { user: m }; paintView(); }
    });
  }
  $("#edit-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const gpus = $$("input[name=gpu]:checked", e.target).map((i) => i.value);
    try {
      await api(`/api/admin/users/${state.edit.user.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          role: fd.get("role"),
          credit_cents: Math.round(Number(fd.get("budget")) * 100),
          max_concurrent: Number(fd.get("max_concurrent")),
          allowed_gpus: gpus.includes("*") || !gpus.length ? ["*"] : gpus,
        }),
      });
      state.edit = null;
      flash("Saved.", "ok");
      await refreshTab();
    } catch (err) { flash(err.message); }
  });

  $("#copy-skill")?.addEventListener("click", (e) => copyText(skillText(), e.currentTarget, "Copy for agent"));
  for (const b of $$("[data-del-key]")) {
    b.addEventListener("click", async () => {
      if (!confirm("Revoke this agent? It will stop working immediately.")) return;
      await api(`/api/keys/${b.dataset.delKey}`, { method: "DELETE" });
      refreshTab();
    });
  }

  // ---- SSH keys
  $("#ssh-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await addSshKey(String(fd.get("name") || "").trim(), String(fd.get("public_key") || ""));
      flash("Key saved — new launches attach it automatically.", "ok");
    } catch (err) {
      flash(err.message);
    }
    paintView();
  });
  for (const b of $$("[data-del-ssh]")) {
    b.addEventListener("click", async () => {
      if (!confirm("Remove this key? Machines already launched keep it.")) return;
      try { await removeSshKey(b.dataset.delSsh); } catch (err) { flash(err.message); }
      paintView();
    });
  }
  $("#machines-more")?.addEventListener("click", () => { state.showAllMachines = true; paintView(); });

  // ---- onboarding
  $("#onboard-tour")?.addEventListener("click", () => tourOpen());
  $("#onboard-dismiss")?.addEventListener("click", () => {
    const o = onboardState();
    o.done = true;
    saveOnboard();
    paintView();
  });
  for (const b of $$("[data-tour-go]")) {
    b.addEventListener("click", () => {
      const steps = tourSteps();
      const i = steps.findIndex((s) => s.id === b.dataset.tourGo);
      tourOpen(i < 0 ? 0 : i);
    });
  }

  // ---- lab connection
  $("#lab-connect")?.addEventListener("click", async () => {
    try {
      const r = await post("/api/massed/connect", { return_to: "app" });
      if (r?.url) location.href = r.url;
      else flash("Could not start the Massed authorization.");
    } catch (err) { flash(err.message); }
  });
  $("#lab-designate-go")?.addEventListener("click", async () => {
    const userId = $("#lab-designate")?.value;
    if (!userId) return;
    try {
      await post("/api/lab/designate", { user_id: userId });
      flash("Lab account updated.", "ok");
    } catch (err) { flash(err.message); }
    refreshTab();
  });
  $("#lab-probe")?.addEventListener("click", async () => {
    try {
      state.labProbe = await api("/api/massed/probe");
    } catch (err) { flash(err.message); }
    paintView();
  });
  $("#lab-schema")?.addEventListener("click", async () => {
    try {
      state.lab = await post("/api/lab/schema-check");
      flash("Re-read Massed's tool schemas.", "ok");
    } catch (err) { flash(err.message); }
    paintView();
  });
  $("#lab-disconnect")?.addEventListener("click", async () => {
    if (!confirm("Disconnect the lab's Massed account? Live readings and launches stop until you reconnect.")) return;
    try {
      await post("/api/massed/disconnect");
      state.lab = { state: "not_connected", healthy: false, can_launch: false, message: "No Massed Compute account is connected yet. An admin needs to connect one." };
      state.labProbe = null;
      flash("Disconnected.", "ok");
    } catch (err) { flash(err.message); }
    refreshTab();
  });
  for (const b of $$("[data-attr-go]")) {
    b.addEventListener("click", async () => {
      const uuid = b.dataset.attrGo;
      const userId = $(`[data-attr-user="${uuid}"]`)?.value || "";
      try {
        await post(`/api/admin/vms/${encodeURIComponent(uuid)}/attribute`, { user_id: userId || null });
        flash(userId ? "Machine assigned." : "Machine cleared.", "ok");
      } catch (err) { flash(err.message); }
      refreshTab();
    });
  }
  $("#calibrate-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      state.calibration = await post("/api/admin/balance", {
        balance_cents: Math.round(Number(fd.get("balance")) * 100),
        topup_cents: Math.round(Number(fd.get("topup") || 0) * 100),
        note: String(fd.get("note") || "").slice(0, 120) || undefined,
      });
      flash("Reading saved.", "ok");
    } catch (err) { flash(err.message); }
    paintView();
  });
}

function bindLaunchButtons() {
  for (const b of $$("[data-open-launch]")) {
    b.addEventListener("click", () => {
      state.launch = { productName: b.dataset.openLaunch };
      state.flash = "";
      paintChrome();
      paintView();
    });
  }
}

// ---------------------------------------------------------------- data

async function refreshMe() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    // /api/me carries the member view of the lab, so the first paint is never blank
    if (me.lab && !state.lab) state.lab = me.lab;
  } catch {}
}

/** Ask once which optional endpoints exist; a 404 just leaves the feature off. */
async function detectCaps() {
  const c = await tryApi("/api/ui/capabilities");
  if (c && typeof c === "object") state.caps = { ...NO_CAPS, ...c };
}

/** Adopt whatever the server remembers about onboarding, on top of this browser. */
async function loadOnboardRemote() {
  const r = await tryApi("/api/onboarding");
  if (!r || typeof r !== "object") return;
  state.caps.onboarding = true;
  // the server proves some steps from data; trust its list over our local guesses
  state.onboardAuto = Array.isArray(r.auto) ? r.auto : Array.isArray(r.steps) ? r.steps : [];
  const stored = Array.isArray(r.stored) ? r.stored : Array.isArray(r.steps) ? r.steps : [];
  state.onboardSeenRemote = stored.includes(TOUR_SEEN);
  const o = onboardState();
  o.done = o.done || !!r.done;
}

async function loadDetail(id) {
  try {
    state.details[id] = (await api(`/api/instances/${id}`)).instance;
  } catch (err) { flash(err.message); }
  if (state.tab === "home") paintView();
}

let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!state.user || state.tab !== "home") return;
  const fast = state.instances.some((i) => i.status === "launching" || (i.status === "running" && !i.ip));
  pollTimer = setTimeout(() => (document.hidden || state.launch ? schedulePoll() : refreshTab()), fast ? 4000 : 20000);
}

async function loadUsage() {
  const u = await api(isAdmin() ? "/api/admin/usage" : "/api/usage");
  state.usage = u.events || [];
  state.usageSummary = u.summary || null;
  if (u.massed) state.massed = u.massed;
  if (u.watch) state.watch = u.watch;
}

async function refreshTab() {
  const my = ++fetchGen;
  const tab = state.tab;
  const stale = () => my !== fetchGen;
  try {
    if (tab === "home") {
      const [inv, ins, team] = await Promise.all([
        api("/api/inventory"), api("/api/instances"), api("/api/team"), loadUsage(), loadSshKeys(), loadLab(),
      ]);
      if (stale()) return;
      state.inventory = inv;
      state.inventoryLoaded = true;
      state.instances = ins.instances;
      state.team = team;
      await refreshMe();
      for (const id of state.open) {
        const vm = state.instances.find((i) => i.id === id);
        if (vm && (vm.status === "running" || vm.status === "launching")) state.details[id] = (await api(`/api/instances/${id}`)).instance;
      }
      if (stale()) return;
      if (state.launch) { schedulePoll(); return; }
    } else if (tab === "fleet") {
      const [fleet, audit] = await Promise.all([
        api("/api/admin/fleet").catch(() => ({ instances: [] })),
        api("/api/admin/audit").catch(() => ({ events: [] })),
        loadUsage(),
        loadLab(),
        loadVmEvents(),
        loadCalibration(),
        loadBillingHistory(),
      ]);
      if (stale()) return;
      state.fleet = { instances: fleet.instances || [], loaded: true };
      state.audit = audit.events || [];
    } else if (tab === "team") {
      const [team, inv, audit] = await Promise.all([
        api("/api/team"),
        isAdmin() ? api("/api/admin/catalog") : Promise.resolve(null),
        isAdmin() ? api("/api/admin/audit") : Promise.resolve({ events: [] }),
        loadSettings(),
      ]);
      if (stale()) return;
      state.team = team;
      if (inv) state.inventory = inv;
      state.audit = audit.events;
      state.edit = null;
    } else if (tab === "usage") {
      await Promise.all([loadUsage(), loadVmEvents()]);
      if (stale()) return;
    } else if (tab === "agents") {
      const data = await api("/api/keys");
      if (stale()) return;
      state.keys = data.keys;
    } else {
      return;
    }
    if (state.tab === tab) paintView();
    if (tab === "home") maybeAutoTour();
    schedulePoll();
  } catch (err) {
    if (err.message === "Unauthorized") {
      state.user = null;
      renderAuth();
      return;
    }
    if (!stale()) flash(err.message);
  }
}

async function copyText(text, btn, restoreLabel) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch {}
  }
  if (!ok) return flash("Could not copy — select the text manually.");
  if (btn) {
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => {
      if (btn.isConnected) { btn.textContent = restoreLabel; btn.classList.remove("copied"); }
    }, 1600);
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.tour?.open) { tourPause(); return; }
  if (state.launch || state.edit) { state.launch = null; state.edit = null; paintView(); }
});
addEventListener("resize", () => { if (state.tour?.open) positionTour(); });

// The tour never blocks the page: a click anywhere outside its card hides the overlay and
// then does whatever it was going to do, so the nav and every other control stay reachable.
document.addEventListener("click", (e) => {
  if (!state.tour?.open) return;
  if (e.target instanceof Element && e.target.closest("#tour-card")) return;
  tourPause();
}, true);

// ...and the avatar menu closes the same way
document.addEventListener("click", (e) => {
  const menu = $("#who-menu");
  if (!menu || menu.hidden) return;
  if (e.target instanceof Element && e.target.closest(".who-wrap")) return;
  menu.hidden = true;
  $("#who")?.setAttribute("aria-expanded", "false");
});

async function boot() {
  try {
    const [me] = await Promise.all([api("/api/me"), detectCaps()]);
    state.user = me.user;
    if (typeof me.mock === "boolean") state.meta.mock = me.mock;
    // the Massed OAuth round-trip comes back here as ?massed=connected|massed_error=…
    const params = new URLSearchParams(location.search);
    const massed = params.get("massed");
    const massedError = params.get("massed_error");
    if (massed || massedError) {
      if (massedError) flash(`Massed Compute connection failed: ${massedError}`);
      else flash("Massed Compute connected — the lab is live.", "ok");
      const keep = state.connect ? `?connect=${encodeURIComponent(state.connect)}` : "";
      history.replaceState(null, "", route() + keep);
    }
    if (state.caps.ssh_keys) await loadSshKeys();
    await loadOnboardRemote();
    render();
    if (!state.connect) refreshTab();
  } catch {
    renderAuth();
  }
}

boot();
