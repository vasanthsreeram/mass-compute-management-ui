const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");

const state = {
  user: null,
  tab: "match",
  meta: { mock: true },
  massed: null,
  upstream: [],
  inventory: { gpus: [], images: [] },
  instances: [],
  usage: [],
  usageSummary: { spent_cents: 0, hours: 0, event_count: 0, by_sku: [], by_user: [] },
  watch: { vms: [], ticks: [], summary: { cents: 0, hours: 0, vm_count: 0 } },
  keys: [],
  adminUsers: [],
  adminDetail: null,
  fleet: [],
  flash: "",
  secret: "",
  matchQuery: "",
  match: null,
  matching: false,
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

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmt(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

let fetchGen = 0;

function render() {
  if (!state.user) return renderAuth();
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
        <div class="brand">Massed Compute <span>desk</span></div>
        <nav class="nav">
          ${tabBtn("match", "Match")}
          ${tabBtn("machines", "Machines")}
          ${tabBtn("usage", "Usage")}
          ${tabBtn("keys", "Keys")}
          ${state.user.role === "admin" ? tabBtn("admin", "Admin") : ""}
          <button class="ghost" id="logout">Sign out</button>
        </nav>
      </header>
      <div id="chrome"></div>
      <div id="view"></div>
      <footer class="foot">${state.meta.mock ? "Mock inventory." : "Live Massed inventory · Workers AI match"}</footer>
    </div>
  `;
  $("#logout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    app.innerHTML = "";
    renderAuth();
  });
  for (const b of document.querySelectorAll(".nav [data-tab]")) {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  }
}

function paintNav() {
  for (const b of document.querySelectorAll(".nav [data-tab]")) {
    b.classList.toggle("active", b.dataset.tab === state.tab);
  }
}

function paintChrome() {
  const el = $("#chrome");
  if (!el) return;
  el.innerHTML = `
    ${state.flash ? `<div class="flash">${esc(state.flash)}</div>` : ""}
    ${state.secret ? `<div class="ok secret">New key (copy now): ${esc(state.secret)}</div>` : ""}
  `;
}

function paintView() {
  const el = $("#view");
  if (!el) return;
  el.innerHTML = view();
  bindView();
}

function switchTab(id) {
  if (!id) return;
  state.tab = id;
  state.flash = "";
  paintNav();
  paintView();
  refreshTab();
}

function tabBtn(id, label) {
  return `<button data-tab="${id}" class="${state.tab === id ? "active" : ""}">${label}</button>`;
}

function renderAuth() {
  app.innerHTML = `
    <div class="auth">
      <div class="brand">Massed Compute <span>desk</span></div>
      <h1>Sign in</h1>
      <p class="lead">First account is admin. GPU rental stays on your proxy budget.</p>
      ${state.flash ? `<div class="flash">${esc(state.flash)}</div>` : ""}
      <form id="auth-form">
        <label>Email</label>
        <input name="email" type="email" required autocomplete="username" />
        <label>Password</label>
        <input name="password" type="password" required minlength="8" autocomplete="current-password" />
        <div class="row" style="margin-top:16px">
          <button class="primary" type="submit" data-mode="login">Log in</button>
          <button class="ghost slim" type="submit" data-mode="register">Create account</button>
        </div>
      </form>
    </div>
  `;
  const form = $("#auth-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = e.submitter?.dataset.mode || "login";
    const fd = new FormData(form);
    try {
      const data = await api(mode === "register" ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
      });
      state.user = data.user;
      state.flash = "";
      state.tab = "match";
      app.innerHTML = "";
      render();
      refreshTab();
    } catch (err) {
      state.flash = err.message;
      renderAuth();
    }
  });
}

function statusStrip() {
  const isAdmin = state.user.role === "admin";
  const m = state.massed;
  if (isAdmin) {
    return `
      <div class="grid stats">
        <div class="card"><div class="k">Account</div><div class="v" style="font-size:16px">${m?.connected ? "Connected" : "Offline"}</div></div>
        <div class="card"><div class="k">Burn</div><div class="v">${money(m?.burnCentsPerHour || 0)}/hr</div></div>
        <div class="card"><div class="k">Running</div><div class="v">${m?.running ?? 0}</div></div>
        <div class="card"><div class="k">Recharge</div><div class="v">${money(Number(m?.billing?.rechargeAmountCents || 0))}</div><div class="s">at ${money(Number(m?.billing?.rechargeThresholdCents || 0))}</div></div>
      </div>
    `;
  }
  return `
    <div class="grid stats">
      <div class="card"><div class="k">Budget left</div><div class="v">${money(state.user.credit_cents)}</div></div>
      <div class="card"><div class="k">Spent</div><div class="v">${money(state.user.spent_cents)}</div></div>
      <div class="card"><div class="k">Cap</div><div class="v">${state.user.max_concurrent}</div><div class="s">concurrent VMs</div></div>
    </div>
  `;
}

function skuCard(pick, primary) {
  if (!pick) return "";
  const s = pick.sku;
  return `
    <div class="card match-result">
      <h2>${primary ? "Recommended" : "Alternative"}</h2>
      <div class="mono">${esc(s.productName)}</div>
      <div class="s">${esc(s.description)} · ${s.vcpu} vCPU · ${s.ramGib} GiB · ${s.storageGb} GB</div>
      <div class="price">${money(s.priceCentsPerHour)}/hr</div>
      <div class="s">${pick.inStock ? `${s.capacity} in stock` : "Out of stock"}</div>
      <p class="lead" style="margin-top:10px">${esc(pick.reason)}</p>
      ${pick.inStock ? `<button class="primary slim" data-launch="${esc(s.productName)}">Launch</button>` : ""}
    </div>
  `;
}

function matchView() {
  const m = state.match;
  return `
    <h1>Match a setup</h1>
    <p class="lead">Describe the job. Cloudflare Workers AI picks the cheapest SKU on your allowlist that can do it.</p>
    ${statusStrip()}
    <form id="match-form" class="card match-form">
      <textarea name="query" placeholder="e.g. fine-tune Llama 8B overnight, need ~24GB VRAM, keep it cheap">${esc(state.matchQuery)}</textarea>
      <div class="actions">
        <button class="primary slim" type="submit" ${state.matching ? "disabled" : ""}>${state.matching ? "Matching…" : "Recommend"}</button>
        <span class="hint">Llama 3.1 8B on Workers AI · live Massed prices</span>
      </div>
    </form>
    ${m?.pick ? skuCard(m.pick, true) : ""}
    ${m?.alternatives?.length ? `<div class="match-alts">${m.alternatives.map((a) => skuCard(a, false)).join("")}</div>` : ""}
  `;
}

function usageView() {
  const s = state.usageSummary || { spent_cents: 0, hours: 0, event_count: 0, by_sku: [], by_user: [] };
  const isAdmin = state.user.role === "admin";
  const m = state.massed;
  return `
    <h1>Usage</h1>
    <p class="lead">${isAdmin ? "Spend from this desk, plus VMs seen on the Massed account (updated every 5 minutes)." : "Debits for VMs you launched here."}</p>
    <div class="grid stats">
      <div class="card"><div class="k">Metered</div><div class="v">${money(s.spent_cents)}</div><div class="s">${s.event_count} events</div></div>
      <div class="card"><div class="k">Hours</div><div class="v">${Number(s.hours || 0).toFixed(2)}</div></div>
      ${isAdmin ? `<div class="card"><div class="k">Massed now</div><div class="v">${money(m?.burnCentsPerHour || 0)}/hr</div></div>` : ""}
      ${isAdmin ? `<div class="card"><div class="k">Watched</div><div class="v">${money(state.watch?.summary?.cents || 0)}</div></div>` : ""}
    </div>
    ${isAdmin ? `
    <div class="card" style="margin-bottom:14px">
      <h2>Massed history</h2>
      ${watchVmTable(state.watch?.vms || [])}
    </div>` : ""}
    <div class="card">
      <h2>Events</h2>
      ${usageTable(state.usage, isAdmin)}
    </div>
  `;
}

function view() {
  if (state.tab === "match") return matchView();
  if (state.tab === "usage") return usageView();
  if (state.tab === "machines") {
    return `
      <h1>Machines</h1>
      <p class="lead">VMs launched through this desk. Terminate wipes the disk.</p>
      <div class="card">${instanceTable(state.instances, true)}</div>
    `;
  }
  if (state.tab === "keys") {
    return `
      <h1>Agent keys</h1>
      <p class="lead">The agent talks only to this proxy — never to Massed.</p>
      <div class="card">
        <form id="key-form" class="row">
          <input name="name" placeholder="name, e.g. claude" required />
          <button class="primary slim" type="submit">Create</button>
        </form>
        <table style="margin-top:16px">
          <thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            ${state.keys.map((k) => `
              <tr>
                <td>${esc(k.name)}</td>
                <td class="mono">${esc(k.key_prefix)}…</td>
                <td class="mono">${esc(fmt(k.created_at))}</td>
                <td class="mono">${esc(fmt(k.last_used_at))}</td>
                <td><button class="linkish danger" data-del-key="${k.id}">revoke</button></td>
              </tr>`).join("") || `<tr><td colspan="5">No keys yet.</td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Skill</h2>
        <pre>GPU_PROXY_URL=${location.origin}
GPU_PROXY_API_KEY=gpk_…</pre>
        <p class="lead"><a href="/skill.md">skill.md</a></p>
      </div>
    `;
  }
  if (state.tab === "admin") return renderAdmin();
  return "";
}

function renderAdmin() {
  const d = state.adminDetail;
  return `
    <h1>Admin</h1>
    <p class="lead">Roles, GPU allowlist, proxy budget, concurrent cap.</p>
    <div class="split">
      <div class="card">
        <h2>Users</h2>
        <table>
          <thead><tr><th>User</th><th>Role</th><th>Budget</th><th>Running</th></tr></thead>
          <tbody>
            ${state.adminUsers.map((u) => `
              <tr class="user-row" data-user="${u.id}">
                <td>${esc(u.email)}</td>
                <td><span class="pill ${u.role === "admin" ? "admin" : ""}">${esc(u.role)}</span></td>
                <td class="mono">${money(u.credit_cents)}</td>
                <td>${u.running ?? 0} / ${u.max_concurrent}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <div class="card">
        ${d ? adminDetailHtml(d) : "<p class='lead'>Select a user.</p>"}
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Fleet</h2>
      ${instanceTable(state.fleet, false, true)}
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Massed live</h2>
      ${upstreamTable(state.upstream)}
    </div>
  `;
}

function adminDetailHtml(d) {
  const u = d.user;
  const gpus = state.inventory.gpus || [];
  const allowed = new Set(u.allowed_gpus);
  const all = allowed.has("*");
  return `
    <h2>${esc(u.email)}</h2>
    <form id="admin-user">
      <label>Role</label>
      <select name="role">
        <option value="user" ${u.role === "user" ? "selected" : ""}>user</option>
        <option value="admin" ${u.role === "admin" ? "selected" : ""}>admin</option>
      </select>
      <label>Proxy budget (cents)</label>
      <input name="credit_cents" type="number" min="0" value="${u.credit_cents}" />
      <label>Max concurrent</label>
      <input name="max_concurrent" type="number" min="0" max="32" value="${u.max_concurrent}" />
      <label>Allowed GPUs</label>
      <div class="checks">
        <label><input type="checkbox" name="gpu" value="*" ${all ? "checked" : ""} /> all SKUs</label>
        ${gpus.map((g) => `<label><input type="checkbox" name="gpu" value="${esc(g.productName)}" ${!all && allowed.has(g.productName) ? "checked" : ""} /> ${esc(g.productName)}</label>`).join("")}
      </div>
      <button class="primary slim" type="submit">Save</button>
    </form>
    <h2 style="margin-top:24px">VMs</h2>
    ${instanceTable(d.instances || [], false)}
    <h2 style="margin-top:24px">Usage</h2>
    ${usageTable(d.usage || [])}
  `;
}

function instanceTable(rows, actions, showEmail = false) {
  if (!rows?.length) return `<p class="lead">None.</p>`;
  return `
    <table>
      <thead><tr>
        ${showEmail ? "<th>User</th>" : ""}
        <th>Name</th><th>SKU</th><th>Status</th><th>$/hr</th><th>Launched</th><th>Ended</th>
        ${actions ? "<th></th>" : ""}
      </tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            ${showEmail ? `<td>${esc(r.email || "")}</td>` : ""}
            <td class="mono">${esc(r.name)}<div class="s">${esc(r.ip || "")}</div></td>
            <td class="mono">${esc(r.product_name)}</td>
            <td><span class="pill ${r.status === "running" || r.status === "launching" ? "run" : "off"}">${esc(r.status)}</span></td>
            <td class="mono">${money(r.price_cents_per_hour)}</td>
            <td class="mono">${esc(fmt(r.launched_at))}</td>
            <td class="mono">${esc(fmt(r.terminated_at))}</td>
            ${actions ? `<td>${
              r.status === "terminated"
                ? ""
                : `<button class="linkish" data-restart="${r.id}">restart</button>
                   <button class="linkish danger" data-kill="${r.id}">terminate</button>`
            }</td>` : ""}
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function watchVmTable(rows) {
  if (!rows?.length) return `<p class="lead">No samples yet.</p>`;
  return `
    <table>
      <thead><tr><th>Name</th><th>SKU</th><th>Status</th><th>Last seen</th><th>Hours</th><th>Est.</th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td class="mono">${esc(r.name)}</td>
            <td class="mono">${esc(r.product_name || "")}</td>
            <td><span class="pill ${r.ended_at ? "off" : "run"}">${esc(r.ended_at ? "ended" : r.status)}</span></td>
            <td class="mono">${esc(fmt(r.last_seen_at))}</td>
            <td class="mono">${Number(r.hours || 0).toFixed(3)}</td>
            <td class="mono">${money(r.cents)}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function hoursLabel(h) {
  const n = Number(h || 0);
  if (n <= 0) return "—";
  if (n < 1) return `${Math.round(n * 60)}m`;
  if (n < 48) return `${n.toFixed(1)}h`;
  return `${(n / 24).toFixed(1)}d`;
}

function upstreamTable(rows) {
  if (!rows?.length) return `<p class="lead">Nothing running on Massed.</p>`;
  return `
    <table>
      <thead><tr><th>Name</th><th>SKU</th><th>Status</th><th>Uptime</th><th>$/hr</th><th>Accrued</th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td class="mono">${esc(r.name)}</td>
            <td class="mono">${esc(r.productName || "")}</td>
            <td><span class="pill ${r.status === "rented" || r.status === "running" ? "run" : "off"}">${esc(r.status || "")}</span></td>
            <td class="mono">${esc(hoursLabel(r.uptimeHours))}</td>
            <td class="mono">${money(r.priceCentsPerHour || 0)}</td>
            <td class="mono">${money(r.accumulatedCents || 0)}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function usageTable(rows, showEmail = false) {
  if (!rows?.length) return `<p class="lead">No events yet.</p>`;
  return `
    <table>
      <thead><tr>
        <th>When</th>
        ${showEmail ? "<th>User</th>" : ""}
        <th>VM</th><th>SKU</th><th>Hours</th><th>Amount</th>
      </tr></thead>
      <tbody>
        ${rows.map((e) => `
          <tr>
            <td class="mono">${esc(fmt(e.created_at))}</td>
            ${showEmail ? `<td>${esc(e.email || "")}</td>` : ""}
            <td class="mono">${esc(e.instance_name || e.instance_id || "")}</td>
            <td class="mono">${esc(e.product_name || "")}</td>
            <td class="mono">${Number(e.hours || 0).toFixed(3)}</td>
            <td class="mono">${money(e.cents)}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function bindView() {
  $("#match-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = new FormData(e.target).get("query") || "";
    state.matchQuery = String(query);
    state.matching = true;
    state.flash = "";
    paintView();
    try {
      state.match = await api("/api/match", { method: "POST", body: JSON.stringify({ query: state.matchQuery }) });
    } catch (err) {
      state.flash = err.message;
    }
    state.matching = false;
    paintChrome();
    paintView();
  });
  $("#key-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get("name");
    try {
      const data = await api("/api/keys", { method: "POST", body: JSON.stringify({ name }) });
      state.secret = data.key.token;
      await refreshTab();
    } catch (err) {
      state.flash = err.message;
      paintChrome();
    }
  });
  for (const b of document.querySelectorAll("[data-del-key]")) {
    b.addEventListener("click", async () => {
      await api(`/api/keys/${b.dataset.delKey}`, { method: "DELETE" });
      await refreshTab();
    });
  }
  for (const b of document.querySelectorAll("[data-launch]")) {
    b.addEventListener("click", async () => {
      try {
        await api("/api/instances", {
          method: "POST",
          body: JSON.stringify({ productName: b.dataset.launch }),
        });
        switchTab("machines");
      } catch (err) {
        state.flash = err.message;
        render();
      }
    });
  }
  for (const b of document.querySelectorAll("[data-kill]")) {
    b.addEventListener("click", async () => {
      if (!confirm("Terminate destroys the disk. Continue?")) return;
      await api(`/api/instances/${b.dataset.kill}/terminate`, { method: "POST" });
      await refreshTab();
    });
  }
  for (const b of document.querySelectorAll("[data-restart]")) {
    b.addEventListener("click", async () => {
      await api(`/api/instances/${b.dataset.restart}/restart`, { method: "POST" });
      await refreshTab();
    });
  }
  for (const row of document.querySelectorAll("[data-user]")) {
    row.addEventListener("click", async () => {
      state.adminDetail = await api(`/api/admin/users/${row.dataset.user}`);
      render();
    });
  }
  $("#admin-user")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const gpus = [...e.target.querySelectorAll("input[name=gpu]:checked")].map((i) => i.value);
    try {
      await api(`/api/admin/users/${state.adminDetail.user.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          role: fd.get("role"),
          credit_cents: Number(fd.get("credit_cents")),
          max_concurrent: Number(fd.get("max_concurrent")),
          allowed_gpus: gpus.includes("*") ? ["*"] : gpus,
        }),
      });
      state.adminDetail = await api(`/api/admin/users/${state.adminDetail.user.id}`);
      await refreshTab();
    } catch (err) {
      state.flash = err.message;
      render();
    }
  });
}

async function refreshTab() {
  const my = ++fetchGen;
  const tab = state.tab;
  try {
    if (tab === "match" && state.user.role === "admin" && !state.massed) {
      const acc = await api("/api/account");
      if (my !== fetchGen) return;
      state.massed = acc.massed || null;
    } else if (tab === "usage") {
      const path = state.user.role === "admin" ? "/api/admin/usage" : "/api/usage";
      const u = await api(path);
      if (my !== fetchGen) return;
      state.usage = u.events || [];
      state.usageSummary = u.summary || { spent_cents: 0, hours: 0, event_count: 0, by_sku: [], by_user: [] };
      if (u.massed) state.massed = u.massed;
      if (u.watch) state.watch = u.watch;
    } else if (tab === "machines") {
      const data = await api("/api/instances");
      if (my !== fetchGen) return;
      state.instances = data.instances;
    } else if (tab === "keys") {
      const data = await api("/api/keys");
      if (my !== fetchGen) return;
      state.keys = data.keys;
    } else if (tab === "admin") {
      const [users, fleet, inv, up] = await Promise.all([
        api("/api/admin/users"),
        api("/api/admin/fleet"),
        api("/api/admin/catalog"),
        api("/api/admin/upstream"),
      ]);
      if (my !== fetchGen) return;
      state.adminUsers = users.users;
      state.fleet = fleet.instances;
      state.inventory = inv;
      state.upstream = up.instances || [];
    } else {
      return;
    }
    if (state.tab === tab) paintView();
  } catch (err) {
    if (err.message === "Unauthorized") {
      state.user = null;
      renderAuth();
      return;
    }
    if (my === fetchGen) {
      state.flash = err.message;
      paintChrome();
    }
  }
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function boot() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    if (typeof me.mock === "boolean") state.meta.mock = me.mock;
    render();
    refreshTab();
  } catch {
    renderAuth();
  }
}

boot();
