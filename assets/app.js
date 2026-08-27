const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");

const state = {
  user: null,
  tab: "overview",
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

function render() {
  if (!state.user) return renderAuth();
  app.innerHTML = `
    <div class="wrap">
      <header class="top">
        <div class="brand">MASSED COMPUTE <small>Management UI</small></div>
        <nav class="nav">
          ${tabBtn("overview", "Overview")}
          ${tabBtn("usage", "Usage")}
          ${tabBtn("machines", "Machines")}
          ${tabBtn("catalog", "Catalog")}
          ${tabBtn("keys", "Agent keys")}
          ${state.user.role === "admin" ? tabBtn("admin", "Admin") : ""}
          <button class="ghost" id="logout">Sign out</button>
        </nav>
      </header>
      ${state.flash ? `<div class="flash">${esc(state.flash)}</div>` : ""}
      ${state.secret ? `<div class="ok secret">New key (copy now, shown once): ${esc(state.secret)}</div>` : ""}
      ${view()}
      <footer class="foot">
        ${state.meta.mock ? "Mock inventory (no live Massed key)." : "Live Massed Compute inventory."}
      </footer>
    </div>
  `;
  $("#logout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    render();
  });
  for (const b of document.querySelectorAll(".nav [data-tab]")) {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      state.flash = "";
      loadTab();
    });
  }
  bindView();
}

function tabBtn(id, label) {
  return `<button data-tab="${id}" class="${state.tab === id ? "active" : ""}">${label}</button>`;
}

function renderAuth() {
  app.innerHTML = `
    <div class="auth">
      <div class="brand">MASSED COMPUTE <small>Management UI</small></div>
      <h1>Sign in</h1>
      <p class="lead">Email + password. First account becomes admin.</p>
      ${state.flash ? `<div class="flash">${esc(state.flash)}</div>` : ""}
      <form id="auth-form">
        <label>Email</label>
        <input name="email" type="email" required autocomplete="username" />
        <label>Password</label>
        <input name="password" type="password" required minlength="8" autocomplete="current-password" />
        <div class="row" style="margin-top:16px">
          <button class="primary" type="submit" data-mode="login">Log in</button>
          <button class="ghost" type="submit" data-mode="register">Create account</button>
        </div>
      </form>
      <p class="lead" style="margin-top:18px">GPU VMs are billed against your proxy budget. Upstream capacity is Massed Compute.</p>
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
      state.tab = "overview";
      await loadTab();
    } catch (err) {
      state.flash = err.message;
      renderAuth();
    }
  });
}

function overviewView() {
  const isAdmin = state.user.role === "admin";
  const m = state.massed;
  const recharge = m?.billing || {};
  if (isAdmin) {
    const live = !!m?.connected;
    return `
      <h1>${esc(state.user.email)}</h1>
      <p class="lead">${live
        ? "Live Massed Compute account (the operator key). Massed does not expose wallet dollars over API — this is burn, running VMs, and recharge settings."
        : `Not reading the Massed account. ${esc(m?.error || "Check MASSED_COMPUTE_API_KEY.")}`}</p>
      <div class="grid stats">
        <div class="card"><div class="k">Massed status</div><div class="v" style="font-size:18px">${live ? "Connected" : "Offline"}</div><div class="s">${m?.mock ? "Mock mode" : "Token validated against Massed"}</div></div>
        <div class="card"><div class="k">Massed burn</div><div class="v">${money(m?.burnCentsPerHour || 0)}/hr</div><div class="s">Sum of running SKUs</div></div>
        <div class="card"><div class="k">Running VMs</div><div class="v">${m?.running ?? 0}</div><div class="s">${m?.longRunning24h ?? 0} over 24h · ${m?.longRunning7d ?? 0} over 7d</div></div>
        <div class="card"><div class="k">Accrued on running</div><div class="v">${money(m?.accumulatedCents || 0)}</div><div class="s">uptime × $/hr — terminated VMs are not in the API</div></div>
        <div class="card"><div class="k">Auto-recharge</div><div class="v">${money(Number(recharge.rechargeAmountCents || 0))}</div><div class="s">when Massed balance hits ${money(Number(recharge.rechargeThresholdCents || 0))}</div></div>
        <div class="card"><div class="k">Billing method</div><div class="v" style="font-size:18px">${esc(recharge.billingMethod || "—")}</div><div class="s">Wallet $ is only on Massed’s billing page</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <h2>Massed running VMs</h2>
        ${upstreamTable(m?.instances || [])}
      </div>
    `;
  }
  return `
    <h1>${esc(state.user.email)}</h1>
    <p class="lead">This is your proxy budget, assigned by an admin. It is not the Massed wallet.</p>
    <div class="grid stats">
      <div class="card"><div class="k">Proxy budget left</div><div class="v">${money(state.user.credit_cents)}</div><div class="s">Allocated by an admin</div></div>
      <div class="card"><div class="k">Spent</div><div class="v">${money(state.user.spent_cents)}</div></div>
      <div class="card"><div class="k">Role</div><div class="v">${esc(state.user.role)}</div><div class="s">max ${state.user.max_concurrent} concurrent</div></div>
      <div class="card"><div class="k">Allowed GPUs</div><div class="v" style="font-size:14px">${esc(state.user.allowed_gpus.join(", ") || "none")}</div></div>
    </div>
  `;
}

function usageView() {
  const s = state.usageSummary || { spent_cents: 0, hours: 0, event_count: 0, by_sku: [], by_user: [] };
  const isAdmin = state.user.role === "admin";
  const m = state.massed;
  return `
    <h1>Usage</h1>
    <p class="lead">${isAdmin
      ? "Massed has no past-usage API. This Worker polls running VMs every 5 minutes and keeps its own ledger (including after they terminate). Proxy tenant metering is separate."
      : "Timestamped debit events for VMs you launched through this proxy."}</p>
    <div class="grid stats">
      <div class="card"><div class="k">Metered spend</div><div class="v">${money(s.spent_cents)}</div><div class="s">${s.event_count} events</div></div>
      <div class="card"><div class="k">Hours</div><div class="v">${Number(s.hours || 0).toFixed(2)}</div></div>
      ${isAdmin ? `<div class="card"><div class="k">Massed burn now</div><div class="v">${money(m?.burnCentsPerHour || 0)}/hr</div><div class="s">${m?.running ?? 0} running · accrued ${money(m?.accumulatedCents || 0)}</div></div>` : ""}
      ${isAdmin ? `<div class="card"><div class="k">Watched Massed spend</div><div class="v">${money(state.watch?.summary?.cents || 0)}</div><div class="s">${state.watch?.summary?.vm_count || 0} VMs sampled · ${Number(state.watch?.summary?.hours || 0).toFixed(2)} h</div></div>` : ""}
    </div>
    ${isAdmin ? `
    <div class="card" style="margin-top:16px">
      <h2>Massed running (live)</h2>
      <div class="row" style="margin-bottom:12px"><button class="primary slim" id="watch-now">Sample Massed now</button></div>
      ${upstreamTable(m?.instances || [])}
    </div>
    <div class="card" style="margin-top:16px">
      <h2>Massed watch history</h2>
      ${watchVmTable(state.watch?.vms || [])}
    </div>` : ""}
    ${s.by_sku?.length ? `
    <div class="card" style="margin-top:16px">
      <h2>By SKU</h2>
      <table>
        <thead><tr><th>SKU</th><th>Hours</th><th>Amount</th></tr></thead>
        <tbody>
          ${s.by_sku.map((r) => `<tr><td class="mono">${esc(r.product_name)}</td><td class="mono">${Number(r.hours || 0).toFixed(3)}</td><td class="mono">${money(r.cents)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>` : ""}
    ${isAdmin && s.by_user?.length ? `
    <div class="card" style="margin-top:16px">
      <h2>By user</h2>
      <table>
        <thead><tr><th>Email</th><th>Hours</th><th>Amount</th></tr></thead>
        <tbody>
          ${s.by_user.map((r) => `<tr><td>${esc(r.email)}</td><td class="mono">${Number(r.hours || 0).toFixed(3)}</td><td class="mono">${money(r.cents)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>` : ""}
    <div class="card" style="margin-top:16px">
      <h2>Events</h2>
      ${usageTable(state.usage, isAdmin)}
    </div>
  `;
}

function view() {
  if (state.tab === "overview") return overviewView();
  if (state.tab === "usage") return usageView();
  if (state.tab === "machines") {
    return `
      <h1>Machines</h1>
      <div class="card">${instanceTable(state.instances, true)}</div>
    `;
  }
  if (state.tab === "catalog") {
    const images = state.inventory.images || [];
    return `
      <h1>Catalog</h1>
      <p class="lead">Only SKUs on your allowlist are shown. Launch spends your proxy budget; terminate destroys the disk.</p>
      <div class="card">
        <table>
          <thead><tr><th>SKU</th><th>Specs</th><th>$/hr</th><th>Stock</th><th></th></tr></thead>
          <tbody>
            ${(state.inventory.gpus || []).map((g) => `
              <tr>
                <td class="mono">${esc(g.productName)}<div class="s">${esc(g.description)}</div></td>
                <td>${g.vcpu} vCPU · ${g.ramGib} GiB · ${g.storageGb} GB</td>
                <td class="mono">${money(g.priceCentsPerHour)}</td>
                <td>${g.capacity}</td>
                <td>
                  <button class="primary slim" data-launch="${esc(g.productName)}">Launch</button>
                </td>
              </tr>`).join("") || `<tr><td colspan="5">No GPUs assigned. Ask an admin.</td></tr>`}
          </tbody>
        </table>
        <label>Image</label>
        <select id="image-id">
          ${images.map((i) => `<option value="${i.vm_image_id}">${esc(i.vm_image_name)} (${i.vm_image_id})</option>`).join("")}
        </select>
      </div>
    `;
  }
  if (state.tab === "keys") {
    return `
      <h1>Agent keys</h1>
      <p class="lead">Give this to your coding agent. It never talks to Massed Compute — only to this proxy, under your budget and GPU allowlist.</p>
      <div class="card">
        <form id="key-form" class="row">
          <input name="name" placeholder="key name, e.g. claude" required />
          <button class="primary slim" type="submit">Create key</button>
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
      <div class="card" style="margin-top:16px">
        <h2>Copy-skill snippet</h2>
        <pre>GPU_PROXY_URL=${location.origin}
GPU_PROXY_API_KEY=gpk_…</pre>
        <p class="lead">Skill file: <a href="/skill.md">/skill.md</a></p>
      </div>
    `;
  }
  if (state.tab === "admin") {
    return renderAdmin();
  }
  return "";
}

function renderAdmin() {
  const d = state.adminDetail;
  return `
    <h1>Admin</h1>
    <p class="lead">Promote admins, set each user’s GPU allowlist, proxy budget, and concurrent cap. Usage is timestamped per VM.</p>
    <div class="split">
      <div class="card">
        <h2>Users</h2>
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Proxy budget</th><th>Running</th></tr></thead>
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
    <div class="card" style="margin-top:16px">
      <h2>Proxy fleet</h2>
      ${instanceTable(state.fleet, false, true)}
    </div>
    <div class="card" style="margin-top:16px">
      <h2>Massed account (live)</h2>
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
      <label>Proxy budget (cents) — not the Massed wallet</label>
      <input name="credit_cents" type="number" min="0" value="${u.credit_cents}" />
      <label>Max concurrent VMs</label>
      <input name="max_concurrent" type="number" min="0" max="32" value="${u.max_concurrent}" />
      <label>Allowed GPUs</label>
      <div class="checks">
        <label><input type="checkbox" name="gpu" value="*" ${all ? "checked" : ""} /> * all SKUs</label>
        ${gpus.map((g) => `<label><input type="checkbox" name="gpu" value="${esc(g.productName)}" ${!all && allowed.has(g.productName) ? "checked" : ""} /> ${esc(g.productName)}</label>`).join("")}
      </div>
      <button class="primary slim" type="submit">Save permissions</button>
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
        <th>Name</th><th>SKU</th><th>Status</th><th>$/hr</th><th>Launched</th><th>Terminated</th>
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
  if (!rows?.length) return `<p class="lead">No samples yet. Cron polls Massed every 5 minutes, or use Sample Massed now.</p>`;
  return `
    <table>
      <thead><tr><th>Name</th><th>SKU</th><th>Status</th><th>First seen</th><th>Last seen</th><th>Hours</th><th>Est. $</th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td class="mono">${esc(r.name)}<div class="s">${esc(r.uuid)}</div></td>
            <td class="mono">${esc(r.product_name || "")}</td>
            <td><span class="pill ${r.ended_at ? "off" : "run"}">${esc(r.ended_at ? "ended" : r.status)}</span></td>
            <td class="mono">${esc(fmt(r.first_seen_at))}</td>
            <td class="mono">${esc(fmt(r.last_seen_at))}${r.ended_at ? `<div class="s">ended ${esc(fmt(r.ended_at))}</div>` : ""}</td>
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
  if (!rows?.length) return `<p class="lead">No running instances on the Massed account. Massed’s API only lists currently rented VMs — past usage is not returned.</p>`;
  return `
    <table>
      <thead><tr><th>Name</th><th>SKU</th><th>Status</th><th>Uptime</th><th>$/hr</th><th>Accrued</th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td class="mono">${esc(r.name)}<div class="s">${esc(r.uuid || "")}</div></td>
            <td class="mono">${esc(r.productName || "")}</td>
            <td><span class="pill ${r.status === "rented" || r.status === "running" ? "run" : "off"}">${esc(r.status || "")}</span></td>
            <td class="mono">${esc(hoursLabel(r.uptimeHours))}<div class="s">${esc(fmt(r.created))}</div></td>
            <td class="mono">${money(r.priceCentsPerHour || 0)}</td>
            <td class="mono">${money(r.accumulatedCents || 0)}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function usageTable(rows, showEmail = false) {
  if (!rows?.length) return `<p class="lead">No usage events yet.</p>`;
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
  $("#watch-now")?.addEventListener("click", async () => {
    try {
      await api("/api/admin/meter", { method: "POST" });
      state.flash = "Massed sample saved.";
      await loadTab();
    } catch (err) {
      state.flash = err.message;
      render();
    }
  });
  $("#key-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get("name");
    try {
      const data = await api("/api/keys", { method: "POST", body: JSON.stringify({ name }) });
      state.secret = data.key.token;
      await loadTab();
    } catch (err) {
      state.flash = err.message;
      render();
    }
  });
  for (const b of document.querySelectorAll("[data-del-key]")) {
    b.addEventListener("click", async () => {
      await api(`/api/keys/${b.dataset.delKey}`, { method: "DELETE" });
      await loadTab();
    });
  }
  for (const b of document.querySelectorAll("[data-launch]")) {
    b.addEventListener("click", async () => {
      const imageId = Number($("#image-id")?.value || 0) || undefined;
      try {
        await api("/api/instances", {
          method: "POST",
          body: JSON.stringify({ productName: b.dataset.launch, imageId }),
        });
        state.tab = "machines";
        await loadTab();
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
      await loadTab();
    });
  }
  for (const b of document.querySelectorAll("[data-restart]")) {
    b.addEventListener("click", async () => {
      await api(`/api/instances/${b.dataset.restart}/restart`, { method: "POST" });
      await loadTab();
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
      await loadTab();
    } catch (err) {
      state.flash = err.message;
      render();
    }
  });
}

async function loadTab() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    state.massed = me.massed || null;
    if (state.tab === "overview") {
      /* massed snapshot already on /api/me */
    } else if (state.tab === "usage") {
      const path = state.user.role === "admin" ? "/api/admin/usage" : "/api/usage";
      const u = await api(path);
      state.usage = u.events || [];
      state.usageSummary = u.summary || { spent_cents: 0, hours: 0, event_count: 0, by_sku: [], by_user: [] };
      if (u.massed) state.massed = u.massed;
      if (u.watch) state.watch = u.watch;
    } else if (state.tab === "machines") {
      state.instances = (await api("/api/instances")).instances;
    } else if (state.tab === "catalog") {
      state.inventory = await api("/api/inventory");
    } else if (state.tab === "keys") {
      state.keys = (await api("/api/keys")).keys;
    } else if (state.tab === "admin") {
      const [users, fleet, inv, up] = await Promise.all([
        api("/api/admin/users"),
        api("/api/admin/fleet"),
        api("/api/admin/catalog"),
        api("/api/admin/upstream"),
      ]);
      state.adminUsers = users.users;
      state.fleet = fleet.instances;
      state.inventory = inv;
      state.upstream = up.instances || [];
    }
  } catch (err) {
    if (err.message === "Unauthorized") {
      state.user = null;
    } else {
      state.flash = err.message;
    }
  }
  render();
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
    state.meta = await api("/api/meta");
  } catch { /* ignore */ }
  try {
    const me = await api("/api/me");
    state.user = me.user;
    await loadTab();
  } catch {
    renderAuth();
  }
}

boot();
