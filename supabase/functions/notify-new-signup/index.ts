// Supabase Edge Function: notify-new-signup
// Emails every manager when someone signs up. New sign-ups are guests (no access) until a manager
// approves them under ⚙ Manage → Users.
// Called by the database (trigger on auth.users via pg_net) with { user_id } — not by the app.
// verify_jwt is off because the database has no user session; the function only ever emails about
// a real guest profile that has not been announced yet, once, so a stray call can't spam anyone.
//
// Secrets: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_URL, SIGNUP_TO (optional extra recipients)

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { user_id } = await req.json().catch(() => ({}));
    if (!user_id || typeof user_id !== "string") return json({ error: "user_id required" }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: p } = await admin.from("profiles").select("id, email, full_name, role, created_at, signup_notified_at").eq("id", user_id).maybeSingle();
    if (!p || p.role !== "guest") return json({ skipped: "not a pending guest" });
    if (p.signup_notified_at) return json({ skipped: "already notified" });
    if (Date.now() - new Date(p.created_at).getTime() > 7 * 24 * 3600 * 1000) return json({ skipped: "too old" });

    // Claim the notification first so two calls can't both send
    const { data: claimed } = await admin.from("profiles").update({ signup_notified_at: new Date().toISOString() })
      .eq("id", user_id).is("signup_notified_at", null).select("id");
    if (!claimed?.length) return json({ skipped: "already notified" });

    const { data: mgrs } = await admin.from("profiles").select("email").eq("role", "manager");
    const extra = (Deno.env.get("SIGNUP_TO") ?? "").split(",").map((s) => s.trim());
    const to = [...new Set([...(mgrs ?? []).map((m) => m.email), ...extra])].filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e ?? "")));
    if (!to.length) return json({ error: "no managers to notify" }, 500);

    const appUrl = Deno.env.get("APP_URL") ?? "";
    const name = p.full_name || p.email;
    const when = new Date(p.created_at).toLocaleString("en-AU", { timeZone: "Australia/Perth", dateStyle: "medium", timeStyle: "short" }) + " AWST";
    const subject = `New sign-up awaiting approval — ${name}`;
    const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;color:#1a2332">
  <div style="background:#002060;color:#fff;padding:14px 18px;border-bottom:5px solid #2e8bc0">
    <div style="font-size:18px;font-weight:700;letter-spacing:1px">FRANMARINE</div>
    <div style="font-size:12px;opacity:.85">Daily Worksheet — new account</div>
  </div>
  <div style="padding:16px 18px">
    <p style="margin:0 0 12px">Someone has signed up to the Daily Worksheet. They have <b>no access</b> until a manager approves them.</p>
    <table style="border-collapse:collapse;font-size:14px">
      <tr><td style="padding:4px 10px;color:#6b7280">Name</td><td style="padding:4px 10px">${esc(p.full_name || "—")}</td></tr>
      <tr><td style="padding:4px 10px;color:#6b7280">Email</td><td style="padding:4px 10px">${esc(p.email)}</td></tr>
      <tr><td style="padding:4px 10px;color:#6b7280">Signed up</td><td style="padding:4px 10px">${esc(when)}</td></tr>
    </table>
    <p style="margin-top:14px">To approve: open the app → ⚙ Manage → 🔑 Users → <b>Awaiting approval</b>, set their role and region, and tap Approve. If you don't know them, tap Reject.</p>
    ${appUrl ? `<p style="margin-top:18px"><a href="${appUrl}" style="background:#002060;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">Open the Daily Worksheet</a></p>` : ""}
    <p style="color:#6b7280;font-size:12px;margin-top:18px">Sent automatically to all managers. Only approve people you recognise.</p>
  </div>
</div>`;
    const text = `New sign-up awaiting approval\n\nName: ${p.full_name || "—"}\nEmail: ${p.email}\nSigned up: ${when}\n\nThey have no access until a manager approves them: app → Manage → Users → Awaiting approval.\n\n${appUrl}`;

    const transporter = nodemailer.createTransport({
      host: Deno.env.get("SMTP_HOST") ?? "smtp.office365.com",
      port: Number(Deno.env.get("SMTP_PORT") ?? 587),
      secure: false, requireTLS: true,
      auth: { user: Deno.env.get("SMTP_USER"), pass: Deno.env.get("SMTP_PASS") },
    });
    try {
      await transporter.sendMail({ from: Deno.env.get("SMTP_FROM") ?? `"Franmarine Worksheet" <${Deno.env.get("SMTP_USER")}>`, to, subject, text, html });
      return json({ sent_to: to });
    } catch (e) {
      await admin.from("profiles").update({ signup_notified_at: null }).eq("id", user_id);   // allow a retry
      return json({ error: String((e as Error)?.message ?? e) }, 500);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
