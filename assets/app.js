const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const app = $("#app");

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
  massed: null,
  inventory: { gpus: [], images: [] },
  inventoryLoaded: false,
  instances: [],
  team: { members: [], invites: [], running: [] },
  audit: [],
  usage: [],
  watch: { vms: [], ticks: [], summary: { cents: 0, hours: 0, vm_count: 0 } },
  keys: [],
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
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : "—");
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
          ${tabBtn("agents", "Agents")}
          <span class="who" title="${esc(state.user.email)}">${av(state.user.email)}</span>
          <button class="ghost" id="logout">Sign out</button>
        </nav>
      </header>
      <div id="chrome"></div>
      <div id="view"></div>
      <footer class="foot">${state.meta.mock ? "Mock inventory." : "Live Massed inventory"} · ${esc(state.user.email)}</footer>
    </div>
  `;
  $("#logout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    app.innerHTML = "";
    renderAuth();
  });
  for (const b of $$(".nav [data-tab]")) b.addEventListener("click", () => switchTab(b.dataset.tab));
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
  state.launch = null;
  state.edit = null;
  paintNav();
  paintChrome();
  // paint the tab immediately, then animate once its data has landed
  paintView({ animate: false });
  state.playEnter = true;
  refreshTab();
}

function view() {
  if (state.tab === "home") return homeView();
  if (state.tab === "team") return teamView();
  if (state.tab === "usage") return usageView();
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
  if (!state.connect) state.tab = "home";
  app.innerHTML = "";
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
    history.replaceState(null, "", "/");
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
  if (activeMine().length >= state.user.max_concurrent) return `Cap reached (${state.user.max_concurrent})`;
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
  const total = state.user.credit_cents + state.user.spent_cents;
  const left = total > 0 ? state.user.credit_cents / total : 0;
  const runway = burn > 0 ? hoursLabel(state.user.credit_cents / burn) : "idle";
  const m = state.massed;
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
      ${isAdmin()
        ? statCard({
            k: "Massed account", tone: m?.connected ? "olive" : "sand", icon: ICONS.server, small: true,
            value: `<span class="dot ${m?.connected ? "on" : ""}"></span>${m ? (m.connected ? "Connected" : "Offline") : "…"}`,
            sub: `${m?.running ?? 0} running upstream · ${money(m?.burnCentsPerHour || 0)}/hr`,
          })
        : statCard({
            k: "Your VMs", tone: "olive", icon: ICONS.server,
            value: `${counted(mine.length)}<small> / ${state.user.max_concurrent}</small>`,
            sub: "running / cap",
          })}
    </div>`;
}

function vmCard(i, mine) {
  const live = i.status === "running" || i.status === "launching";
  const d = state.details[i.id];
  const open = state.open.has(i.id);
  const hrs = Math.max(0, ((i.terminated_at ? new Date(i.terminated_at) : new Date()) - new Date(i.launched_at)) / 3600000);
  const target = i.ip ? `${d?.username || "ubuntu"}@${i.ip}` : "";
  const label = i.name.replace(/^rl_[0-9a-f]{8}_/, "");
  return `
    <div class="card vm ${live ? "" : "dim"}">
      <div class="vm-top">
        <div><div class="gpu-name">${esc(label)}</div>
          <div class="s mono">${esc(i.product_name)}${i.region_name && i.region_name !== "any" ? ` · ${esc(i.region_name)}` : ""}</div></div>
        <span class="pill ${live ? "run" : "off"}">${esc(i.status)}${i.status === "launching" ? "…" : ""}</span>
      </div>
      ${mine ? "" : `<div class="owner">${av(i.email, "sm")}${esc(i.email)}</div>`}
      <div class="vm-meta">
        <div><div class="k">Up</div><div class="mono">${esc(hoursLabel(hrs))}</div></div>
        <div><div class="k">Cost</div><div class="mono">${money(hrs * i.price_cents_per_hour)}</div></div>
        <div><div class="k">Rate</div><div class="mono">${money(i.price_cents_per_hour)}/hr</div></div>
      </div>
      ${mine && live ? `
        <div class="conn">
          ${i.ip ? `<code>ssh ${esc(target)}</code><button class="ghost slim" data-copy="ssh ${esc(target)}">Copy</button>` : `<span class="s">Waiting for an IP…</span>`}
        </div>
        <button class="linkish" data-toggle="${i.id}">${open ? "Hide" : "Show"} login details</button>
        ${open ? `<div class="creds">${d ? `
          <div><span class="k">IP</span> <code>${esc(d.ip || "pending")}</code></div>
          <div><span class="k">User</span> <code>${esc(d.username || "—")}</code></div>
          <div><span class="k">Password</span> <code>${esc(d.password || "—")}</code>
            ${d.password ? `<button class="ghost slim" data-copy="${esc(d.password)}">Copy</button>` : ""}</div>` : `<span class="s">Loading…</span>`}</div>` : ""}` : ""}
      ${live && (mine || isAdmin()) ? `<div class="vm-actions">
          ${mine ? `<button class="ghost slim" data-restart="${i.id}">Restart</button>` : ""}
          <button class="ghost slim danger" data-kill="${i.id}">Terminate</button></div>` : ""}
      ${!live ? `<div class="s">Ended ${esc(fmt(i.terminated_at))}</div>` : ""}
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
        <button class="primary slim" data-open-launch="${esc(sku.productName)}" ${block ? "disabled" : ""}>${block ? esc(block) : "Launch"}</button>
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
  return `
    <h1>Home</h1>
    <p class="lead">What's running right now across the team, and a quick way to spin something up.</p>
    ${homeStats()}
    <h2 class="sect">Running now</h2>
    ${running.length
      ? `<div class="vm-grid">${running.map((r) => vmCard(r.i, r.mine)).join("")}</div>`
      : `<div class="card empty"><b>Nothing running.</b><p class="lead">Launch a GPU below to get started.</p></div>`}
    <h2 class="sect">Launch a GPU</h2>
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
    ${launchDialogHtml()}
  `;
}

function launchDialogHtml() {
  const l = state.launch;
  if (!l) return "";
  const sku = state.inventory.gpus.find((g) => g.productName === l.productName);
  if (!sku) return "";
  let ssh = "";
  try { ssh = localStorage.getItem("ssh_pub") || ""; } catch {}
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
        <label>SSH public key <span class="opt">(optional — otherwise use the generated password)</span></label>
        <textarea name="sshPublicKey" rows="3" placeholder="ssh-ed25519 AAAA…">${esc(ssh)}</textarea>
        <div class="estimate">
          <div><span class="k">Price</span> <b>${money(sku.priceCentsPerHour)}/hr</b> · ${money(sku.priceCentsPerHour * 24)}/day</div>
          ${isAdmin() ? "" : `<div><span class="k">Your budget covers</span> <b>${hoursLabel(state.user.credit_cents / sku.priceCentsPerHour)}</b></div>`}
          <div class="s">Billing starts at launch and runs until you terminate.</div>
        </div>
        <div class="actions">
          <button class="primary" type="submit" ${l.busy ? "disabled" : ""}>${l.busy ? "Launching…" : `Launch for ${money(sku.priceCentsPerHour)}/hr`}</button>
          <button class="ghost slim" type="button" data-close>Cancel</button>
        </div>
      </form>
    </div>`;
}

// ---------------------------------------------------------------- team

function memberCard(m) {
  const total = m.credit_cents + m.spent_cents;
  const left = total > 0 ? m.credit_cents / total : 0;
  const gpus = safeList(m.allowed_gpus);
  return `
    <div class="card member ${isAdmin() ? "clickable" : ""}" ${isAdmin() ? `data-edit="${m.id}"` : ""}>
      <div class="member-top">
        ${av(m.email)}
        <div class="grow"><div class="gpu-name">${esc(m.email)}</div>
          <div class="s">${m.running} running · cap ${m.max_concurrent} · ${gpus.includes("*") ? "all GPUs" : `${gpus.length} GPU${gpus.length === 1 ? "" : "s"}`}</div></div>
        <span class="pill ${m.role === "admin" ? "admin" : ""}">${esc(m.role)}</span>
      </div>
      <div class="budget">
        <div class="hl"><span>${money(m.credit_cents)} left</span><span class="s">${money(m.spent_cents)} spent</span></div>
        <div class="track"><div class="fill" style="width:${(left * 100).toFixed(1)}%;background:${left < 0.15 ? "linear-gradient(90deg,#c26455,#a33d2f)" : left < 0.35 ? "linear-gradient(90deg,#d9a94e,#c28b3c)" : "linear-gradient(90deg,#6f9a78,#3f6b4e)"}"></div></div>
      </div>
      ${m.burn_cents_per_hour > 0 ? `<div class="s">Burning ${money(m.burn_cents_per_hour)}/hr</div>` : ""}
    </div>`;
}

function teamView() {
  const t = state.team;
  const allocated = t.members.reduce((n, m) => n + m.credit_cents + m.spent_cents, 0);
  const spent = t.members.reduce((n, m) => n + m.spent_cents, 0);
  const slices = t.members.map((m) => ({ email: m.email, cents: m.spent_cents })).filter((x) => x.cents > 0).sort((a, b) => b.cents - a.cents);
  return `
    <h1>Team</h1>
    <p class="lead">${isAdmin() ? "Invite people by email and give each a budget. They sign up and confirm with a one-time code." : "Everyone who can use this desk."}</p>
    <div class="grid stats">
      ${statCard({ k: "Members", tone: "clay", icon: ICONS.users, value: counted(t.members.length), sub: `${t.invites.length} invited` })}
      ${statCard({ k: "Budget allocated", tone: "slate", icon: ICONS.target, value: usd(allocated), sub: "across all members" })}
      ${statCard({ k: "Spent so far", tone: "gold", icon: ICONS.receipt, value: usd(spent), sub: allocated > 0 ? `${Math.round((spent / allocated) * 100)}% of budget` : "" })}
      ${statCard({ k: "Remaining", tone: "olive", icon: ICONS.coins, value: usd(allocated - spent), sub: "left to spend" })}
    </div>
    ${isAdmin() ? `
    <form id="invite-form" class="card invite">
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
    <div class="member-grid">${t.members.map(memberCard).join("")}</div>
    <div class="split even" style="margin-top:18px">
      <div class="card"><h2>Where the money went</h2>${donut(slices, "cents", "email", (i) => PALETTE[i % PALETTE.length])}</div>
      ${isAdmin() ? `<div class="card"><h2>Activity</h2>${activityFeed()}</div>` : ""}
    </div>
    ${editDialogHtml()}
  `;
}

const ACTION_LABELS = {
  register: "joined the team",
  "team.invite": "invited",
  "team.invite.revoke": "revoked an invite for",
  "admin.user.patch": "updated a member",
  "instance.launch": "launched a VM",
  "instance.restart": "restarted a VM",
  "instance.terminate": "terminated a VM",
  "agent.approve": "connected an agent",
  "agent.deny": "denied an agent",
  "api_key.create": "created an agent token",
  "api_key.revoke": "revoked an agent token",
  "meter.kill": "had VMs stopped (out of budget)",
  "signup.otp_sent": "requested a sign-up code",
};

function activityFeed() {
  if (!state.audit.length) return `<p class="lead">Nothing yet.</p>`;
  return `<ul class="feed">${state.audit.slice(0, 14).map((a) => {
    let extra = "";
    try {
      const d = JSON.parse(a.detail || "{}");
      extra = d.productName || d.email || d.device || "";
    } catch {}
    return `<li><b>${esc(a.email || "system")}</b> ${esc(ACTION_LABELS[a.action] || a.action)}${extra ? ` <span class="mono">${esc(extra)}</span>` : ""}
      <span class="s">${esc(fmt(a.created_at))}</span></li>`;
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
    <p class="lead">${isAdmin() ? "Everything metered through this desk, by person and GPU." : "What your VMs have cost."}</p>
    <div class="filters sticky">
      <div class="seg">${[7, 14, 30, 90].map((n) => `<button data-range="${n}" class="${days === n ? "active" : ""}">${n}d</button>`).join("")}</div>
      ${isAdmin() ? `<select id="uf-user"><option value="">All people</option>${users.map((u) => `<option ${state.uf.user === u ? "selected" : ""}>${esc(u)}</option>`).join("")}</select>` : ""}
      <select id="uf-sku"><option value="">All GPUs</option>${skus.map((s) => `<option ${state.uf.sku === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
      ${state.uf.user || state.uf.sku ? `<button class="linkish" id="uf-clear">Clear filters</button>` : ""}
    </div>
    <div class="grid stats">
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
      <td class="mono">${esc(fmt(e.created_at))}</td>${isAdmin() ? `<td>${esc(e.email)}</td>` : ""}
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
    <div class="card steps">
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

  $("#launch-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ssh = String(fd.get("sshPublicKey") || "").trim();
    try { localStorage.setItem("ssh_pub", ssh); } catch {}
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
        await post(`/api/instances/${b.dataset.kill}/terminate`);
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
  try { state.user = (await api("/api/me")).user; } catch {}
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
  if (u.massed) state.massed = u.massed;
  if (u.watch) state.watch = u.watch;
}

async function refreshTab() {
  const my = ++fetchGen;
  const tab = state.tab;
  const stale = () => my !== fetchGen;
  try {
    if (tab === "home") {
      const [inv, ins, team] = await Promise.all([api("/api/inventory"), api("/api/instances"), api("/api/team"), loadUsage()]);
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
    } else if (tab === "team") {
      const [team, inv, audit] = await Promise.all([
        api("/api/team"),
        isAdmin() ? api("/api/admin/catalog") : Promise.resolve(null),
        isAdmin() ? api("/api/admin/audit") : Promise.resolve({ events: [] }),
      ]);
      if (stale()) return;
      state.team = team;
      if (inv) state.inventory = inv;
      state.audit = audit.events;
      state.edit = null;
    } else if (tab === "usage") {
      await loadUsage();
      if (stale()) return;
    } else if (tab === "agents") {
      const data = await api("/api/keys");
      if (stale()) return;
      state.keys = data.keys;
    } else {
      return;
    }
    if (state.tab === tab) paintView();
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
  if (e.key === "Escape" && (state.launch || state.edit)) { state.launch = null; state.edit = null; paintView(); }
});

async function boot() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    if (typeof me.mock === "boolean") state.meta.mock = me.mock;
    render();
    if (!state.connect) refreshTab();
  } catch {
    renderAuth();
  }
}

boot();
