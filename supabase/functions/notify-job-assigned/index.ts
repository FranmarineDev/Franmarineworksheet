// Supabase Edge Function: notify-job-assigned
// Emails the supervisor named on a job that they have been put on it (job no., project, start date,
// location, client). Called by the app when a manager saves a job with a new/changed supervisor.
// The supervisor is matched to a user account by name (profiles.full_name, same region).
// Secrets: SMTP_HOST/PORT/USER/PASS/FROM, APP_URL.

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const auth = req.headers.get("Authorization") ?? "";
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: me } = await admin.from("profiles").select("role, region, full_name, email").eq("id", user.id).single();
    if (me?.role !== "manager") return json({ error: "only managers can assign jobs" }, 403);

    const { job_id } = await req.json().catch(() => ({}));
    if (!job_id) return json({ error: "job_id required" }, 400);
    const { data: job } = await admin.from("jobs").select("*").eq("id", job_id).single();
    if (!job) return json({ error: "job not found" }, 404);
    if (!job.supervisor) return json({ skipped: "no supervisor on the job" });

    // Find the supervisor's account by name within the job's region (exact first, then loose match)
    const { data: people } = await admin.from("profiles").select("id, email, full_name").eq("region", job.region);
    const want = norm(job.supervisor);
    const sup = (people ?? []).find((p) => norm(p.full_name) === want)
      ?? (people ?? []).find((p) => want && (norm(p.full_name).includes(want) || want.includes(norm(p.full_name))));
    if (!sup?.email) return json({ skipped: `no user account named "${job.supervisor}" in ${job.region} — nothing sent` });

    const appUrl = Deno.env.get("APP_URL") ?? "";
    const start = job.start_date ? new Date(job.start_date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "to be confirmed";
    const row = (l: string, v: unknown) => v ? `<tr><td style="padding:4px 10px 4px 0;color:#6b7280;font-size:13px;white-space:nowrap">${esc(l)}</td><td style="padding:4px 0;font-size:14px;font-weight:600">${esc(v)}</td></tr>` : "";
    const subject = `You're on ${job.job_no} — ${job.project} (starts ${start})`;
    const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:620px;color:#1a2332">
  <div style="background:#002060;color:#fff;padding:14px 18px;border-bottom:5px solid #2e8bc0">
    <div style="font-size:18px;font-weight:700;letter-spacing:1px">FRANMARINE</div>
    <div style="font-size:12px;opacity:.85">Daily Worksheet — job assignment</div>
  </div>
  <div style="padding:16px 18px;font-size:14px">
    <p>Hi ${esc(sup.full_name?.split(" ")[0] || "")},</p>
    <p>${esc(me.full_name || me.email)} has put you down as supervisor on a job:</p>
    <table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 14px">
      ${row("Job No.", job.job_no)}${row("Project", job.project)}${row("Start date", start)}${row("Client", job.client)}${row("Location", job.location)}${row("Vessel / Facility", job.vessel)}${row("Client contact", job.contact ? `${job.contact}${job.contact_ph ? " · " + job.contact_ph : ""}` : "")}
    </table>
    ${job.swms?.name ? `<p>The SWMS for this job (<b>${esc(job.swms.name)}</b>) is attached, and it will already be on the first day's worksheet for sign-off.</p>` : ""}
    <p>The job is on your dashboard in the Daily Worksheet. On the day, open the job card and tap <b>+ Today's worksheet</b>.</p>
    ${appUrl ? `<p style="margin-top:16px"><a href="${appUrl}" style="background:#002060;color:#fff;text-decoration:none;padding:9px 14px;border-radius:6px;font-weight:600;font-size:13px">Open the Daily Worksheet</a></p>` : ""}
    <p style="color:#6b7280;font-size:12px;margin-top:18px">Sent automatically from the Franmarine Daily Worksheet. Questions — reply to ${esc(me.email)}.</p>
  </div>
</div>`;
    const text = `You've been put on ${job.job_no} — ${job.project}\nStart: ${start}\n${job.client ? "Client: " + job.client + "\n" : ""}${job.location ? "Location: " + job.location + "\n" : ""}${appUrl}`;

    const transporter = nodemailer.createTransport({
      host: Deno.env.get("SMTP_HOST") ?? "smtp.office365.com", port: Number(Deno.env.get("SMTP_PORT") ?? 587), secure: false, requireTLS: true,
      auth: { user: Deno.env.get("SMTP_USER"), pass: Deno.env.get("SMTP_PASS") },
    });
    const attachments: { filename: string; content: Uint8Array; contentType: string }[] = [];
    if (job.swms?.raw && !String(job.swms.raw).startsWith("data:")) {
      const { data: file } = await admin.storage.from("worksheet-files").download(job.swms.raw);
      if (file) attachments.push({ filename: String(job.swms.name || "SWMS.pdf").replace(/\.pdf$/i, "") + ".pdf", content: new Uint8Array(await file.arrayBuffer()), contentType: "application/pdf" });
    }
    await transporter.sendMail({ from: Deno.env.get("SMTP_FROM") ?? `"Franmarine Worksheet" <${Deno.env.get("SMTP_USER")}>`, to: sup.email, replyTo: me.email ?? undefined, subject, text, html, attachments });
    await admin.from("jobs").update({ supervisor_notified_at: new Date().toISOString(), supervisor_notified_to: sup.email }).eq("id", job_id);
    return json({ to: sup.email, name: sup.full_name });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
