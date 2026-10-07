import { labStatus } from "./lab";

/**
 * First-run tutorial state. The UI owns the step ids it shows ("connect", "invite", "limits", "ssh", ...) and
 * POSTs the ones a person has ticked off or dismissed. The server adds `auto`: steps it can prove from data,
 * so the checklist reflects reality even if the person did the work somewhere else (or on another device).
 */
const DONE = "__done";
const stepKey = (s: string) => `step:${s}`;

export async function onboardingState(env: Env, userId: string, isAdmin: boolean) {
  const stored = await env.DB.prepare("SELECT step FROM onboarding_progress WHERE user_id = ?").bind(userId).all<{ step: string }>();
  const rows = (stored.results ?? []).map((r) => r.step);
  const steps = rows.filter((s) => s.startsWith("step:")).map((s) => s.slice(5));
  const done = rows.includes(DONE);

  const count = async (sql: string, ...b: unknown[]) =>
    Number((await env.DB.prepare(sql).bind(...b).first<{ n: number }>())?.n ?? 0);
  const auto: string[] = [];
  if (isAdmin) {
    const lab = await labStatus(env, false);
    if (lab.state === "connected" || lab.state === "api_key") auto.push("connect");
    if ((await count("SELECT COUNT(*) AS n FROM users")) > 1 || (await count("SELECT COUNT(*) AS n FROM invites")) > 0) auto.push("invite");
    if ((await count("SELECT COUNT(*) AS n FROM users WHERE role != 'admin' AND (credit_cents > 0 OR allowed_gpus NOT LIKE '%\"*\"%')")) > 0
      || (await count("SELECT COUNT(*) AS n FROM invites WHERE credit_cents > 0")) > 0) auto.push("limits");
    if ((await count("SELECT COUNT(*) AS n FROM usage_events")) > 0) auto.push("overview", "usage");
  } else {
    if ((await count("SELECT COUNT(*) AS n FROM user_ssh_keys WHERE user_id = ?", userId)) > 0) auto.push("ssh");
    if ((await count("SELECT COUNT(*) AS n FROM instances WHERE user_id = ? AND mc_uuid IS NOT NULL", userId)) > 0) auto.push("launch");
    if ((await count("SELECT COUNT(*) AS n FROM users WHERE id = ? AND (credit_cents > 0 OR spent_cents > 0)", userId)) > 0) auto.push("budget");
  }
  if ((await count("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND kind = 'agent'", userId)) > 0) auto.push("agent");
  return { done, steps: [...new Set([...steps, ...auto])], stored: steps, auto };
}

export async function saveOnboarding(env: Env, userId: string, body: Record<string, unknown>) {
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  const add = (step: string) =>
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO onboarding_progress (user_id, step, done_at) VALUES (?, ?, ?)").bind(userId, step, now));
  if (Array.isArray(body.steps)) {
    for (const s of body.steps.map(String).filter((x) => /^[a-z_]{1,32}$/.test(x)).slice(0, 40)) add(stepKey(s));
  }
  if (body.done === true) add(DONE);
  if (body.done === false) stmts.push(env.DB.prepare("DELETE FROM onboarding_progress WHERE user_id = ? AND step = ?").bind(userId, DONE));
  if (body.reset === true) stmts.push(env.DB.prepare("DELETE FROM onboarding_progress WHERE user_id = ?").bind(userId));
  if (stmts.length) await env.DB.batch(stmts);
}
