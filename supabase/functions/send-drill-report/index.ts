// Supabase Edge Function: send-drill-report
// Emails the drill-report PDF (already uploaded by the app) to HSEQ, cc the job region's managers.
// Secrets: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_URL, DRILL_TO (default below)

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const DEFAULT_TO = "belinda.brooks@franmarine.com.au";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const auth = req.headers.get("Authorization") ?? "";
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);

    const { report_id } = await req.json();
    if (!report_id) return json({ error: "report_id required" }, 400);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: rep, error } = await admin.from("drill_reports")
      .select("*, jobs(job_no, project, region, location, client, supervisor)").eq("id", report_id).single();
    if (error || !rep) return json({ error: "report not found" }, 404);
    if (rep.email_status === "sent") return json({ to: rep.emailed_to ?? [], cc: rep.emailed_cc ?? [], already: true });

    const region = rep.jobs?.region;
    const { data: mgrs } = await admin.from("profiles").select("email").eq("role", "manager").eq("region", region);
    const to = (Deno.env.get("DRILL_TO") ?? DEFAULT_TO).split(",").map((s) => s.trim()).filter(Boolean);
    const cc = (mgrs ?? []).map((m) => m.email).filter((e) => e && !to.includes(e));

    const { data: file, error: dlErr } = await admin.storage.from("worksheet-files").download(rep.pdf_path);
    if (dlErr || !file) {
      await admin.from("drill_reports").update({ email_status: "failed", email_error: "PDF not found in storage" }).eq("id", report_id);
      return json({ error: "PDF not found in storage" }, 500);
    }
    const pdf = new Uint8Array(await file.arrayBuffer());

    const date = new Date(rep.ws_date + "T00:00:00").toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
    const subject = `Emergency Drill Report — ${rep.jobs?.job_no} ${rep.jobs?.project} — ${date}`;
    const appUrl = Deno.env.get("APP_URL") ?? "";
    const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;color:#1a2332">
  <div style="background:#002060;color:#fff;padding:14px 18px;border-bottom:5px solid #2e8bc0">
    <div style="font-size:18px;font-weight:700;letter-spacing:1px">FRANMARINE</div>
    <div style="font-size:12px;opacity:.85">Daily Worksheet — emergency drill report</div>
  </div>
  <div style="padding:16px 18px;font-size:14px">
    <p>Hi Belinda,</p>
    <p>Please find attached the emergency drill report for <b>${esc(rep.jobs?.job_no)} — ${esc(rep.jobs?.project)}</b> on <b>${date}</b>.</p>
    <table style="border-collapse:collapse;font-size:14px">
      <tr><td style="padding:4px 10px 4px 0;color:#6b7280">Drill type</td><td style="padding:4px 0">${esc(rep.drill_type)}</td></tr>
      <tr><td style="padding:4px 10px 4px 0;color:#6b7280">Location</td><td style="padding:4px 0">${esc(rep.jobs?.location ?? "")}</td></tr>
      <tr><td style="padding:4px 10px 4px 0;color:#6b7280">Dive supervisor</td><td style="padding:4px 0">${esc(rep.jobs?.supervisor ?? "")}</td></tr>
      <tr><td style="padding:4px 10px 4px 0;color:#6b7280">Attendees</td><td style="padding:4px 0">${esc((rep.attendees ?? []).join(", "))}</td></tr>
      <tr><td style="padding:4px 10px 4px 0;color:#6b7280">Submitted by</td><td style="padding:4px 0">${esc(rep.sent_by_name)}</td></tr>
    </table>
    ${appUrl ? `<p style="margin-top:16px"><a href="${appUrl}" style="color:#002060">Open the Daily Worksheet</a></p>` : ""}
    <p style="color:#6b7280;font-size:12px;margin-top:18px">Sent automatically from the Franmarine Daily Worksheet. ${esc(region)} managers are copied.</p>
  </div>
</div>`;
    const text = `Emergency drill report attached.\n\n${rep.jobs?.job_no} — ${rep.jobs?.project} — ${date}\nDrill type: ${rep.drill_type}\nLocation: ${rep.jobs?.location ?? ""}\nAttendees: ${(rep.attendees ?? []).join(", ")}\nSubmitted by: ${rep.sent_by_name}\n\n${appUrl}`;

    const transporter = nodemailer.createTransport({
      host: Deno.env.get("SMTP_HOST") ?? "smtp.office365.com", port: Number(Deno.env.get("SMTP_PORT") ?? 587), secure: false, requireTLS: true,
      auth: { user: Deno.env.get("SMTP_USER"), pass: Deno.env.get("SMTP_PASS") },
    });
    try {
      await transporter.sendMail({ from: Deno.env.get("SMTP_FROM") ?? `"Franmarine Worksheet" <${Deno.env.get("SMTP_USER")}>`, to, cc, subject, text, html,
        attachments: [{ filename: rep.file_name ?? "EmergencyDrill.pdf", content: pdf, contentType: "application/pdf" }] });
      await admin.from("drill_reports").update({ email_status: "sent", emailed_to: to, emailed_cc: cc, emailed_at: new Date().toISOString(), email_error: null }).eq("id", report_id);
      return json({ to, cc });
    } catch (e) {
      await admin.from("drill_reports").update({ email_status: "failed", email_error: String(e?.message ?? e) }).eq("id", report_id);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  } catch (e) { return json({ error: String(e?.message ?? e) }, 500); }
});
