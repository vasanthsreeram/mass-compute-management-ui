import { getSetting } from "./lab";

/** Best-effort email to every admin. Never throws: a mail failure must not break metering. */
export async function emailAdmins(env: Env, subject: string, text: string): Promise<number> {
  if (!env.EMAIL || env.MOCK_MASSED === "1") return 0;
  const admins = await env.DB.prepare("SELECT email FROM users WHERE role = 'admin'").all<{ email: string }>();
  const from = env.MAIL_FROM || "noreply@massedui.vasanth.cloud";
  let sent = 0;
  for (const { email } of admins.results ?? []) {
    try {
      await env.EMAIL.send({
        to: email,
        from: { email: from, name: "Massed Compute desk" },
        subject,
        text,
        html: `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
      });
      sent += 1;
    } catch (e) {
      console.error(JSON.stringify({ message: "admin email failed", error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return sent;
}

export async function appUrl(env: Env): Promise<string> {
  const base = (env.APP_URL as string | undefined) || (await getSetting(env, "app_origin")) || "";
  return base.replace(/\/+$/, "");
}
