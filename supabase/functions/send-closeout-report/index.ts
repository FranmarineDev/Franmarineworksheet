// Supabase Edge Function: send-closeout-report
// Emails the day close-out PDF (already uploaded by the app) to the job region's managers.
// Secrets: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_URL, CLOSEOUT_CC (optional extra recipients)

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";
import { closeoutEmail, attachmentName } from "./email.ts";

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
    const { data: rep, error } = await admin.from("closeout_reports")
      .select("*, jobs(job_no, project, region, location, client, supervisor)").eq("id", report_id).single();
    if (error || !rep) return json({ error: "report not found" }, 404);
    if (rep.email_status === "sent") return json({ to: rep.emailed_to ?? [], cc: rep.emailed_cc ?? [], already: true });

    const region = rep.jobs?.region;
    const { data: mgrs } = await admin.from("profiles").select("email").eq("role", "manager").eq("region", region);
    const to = (mgrs ?? []).map((m) => m.email).filter(Boolean);
    // CC = standing CLOSEOUT_CC secret + any addresses the supervisor added on this day's sheet (client / stakeholders)
    const extra = Array.isArray(rep.extra_to) ? rep.extra_to : [];
    const cc = [...(Deno.env.get("CLOSEOUT_CC") ?? "").split(","), ...extra]
      .map((s) => String(s).trim()).filter((e, i, a) => e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !to.includes(e) && a.indexOf(e) === i);
    if (!to.length) { await admin.from("closeout_reports").update({ email_status: "failed", email_error: `no managers in ${region}` }).eq("id", report_id); return json({ error: `no managers in ${region}` }, 500); }

    const { data: file, error: dlErr } = await admin.storage.from("worksheet-files").download(rep.pdf_path);
    if (dlErr || !file) {
      await admin.from("closeout_reports").update({ email_status: "failed", email_error: "PDF not found in storage" }).eq("id", report_id);
      return json({ error: "PDF not found in storage" }, 500);
    }
    const pdf = new Uint8Array(await file.arrayBuffer());

    const date = new Date(rep.ws_date + "T00:00:00").toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
    const subject = `Day Close-Out — ${rep.jobs?.job_no} ${rep.jobs?.project} — ${date}`;
    const appUrl = Deno.env.get("APP_URL") ?? "";
    // Layout "A · Summary first" (email.ts). Reports saved before the app stored a summary fall back to the plain text.
    const html = rep.summary
      ? closeoutEmail(rep.summary, { jobNo: rep.jobs?.job_no, project: rep.jobs?.project, region, sentBy: rep.sent_by_name, wsDate: rep.ws_date,
          appUrl, pdfBytes: pdf.byteLength, ccNames: extra })
      : `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#1a2332"><p style="font-size:16px;font-weight:700;color:#002060">${esc(rep.jobs?.job_no)} — ${esc(rep.jobs?.project)} · ${date}</p>
<pre style="background:#f4f6fa;border:1px solid #d7dde5;border-radius:6px;padding:12px;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap">${esc(rep.summary_text ?? "")}</pre>
${appUrl ? `<p><a href="${appUrl}">Open the Daily Worksheet</a></p>` : ""}</div>`;
    const text = `${rep.summary_text ?? ""}\n\nSubmitted by: ${rep.sent_by_name}\n${appUrl}`;

    const transporter = nodemailer.createTransport({
      host: Deno.env.get("SMTP_HOST") ?? "smtp.office365.com", port: Number(Deno.env.get("SMTP_PORT") ?? 587), secure: false, requireTLS: true,
      auth: { user: Deno.env.get("SMTP_USER"), pass: Deno.env.get("SMTP_PASS") },
    });
    try {
      await transporter.sendMail({ from: Deno.env.get("SMTP_FROM") ?? `"Franmarine Worksheet" <${Deno.env.get("SMTP_USER")}>`, to, cc, subject, text, html,
        attachments: [{ filename: attachmentName(rep.file_name), content: pdf, contentType: "application/pdf" }] });
      await admin.from("closeout_reports").update({ email_status: "sent", emailed_to: to, emailed_cc: cc, emailed_at: new Date().toISOString(), email_error: null }).eq("id", report_id);
      return json({ to, cc });
    } catch (e) {
      await admin.from("closeout_reports").update({ email_status: "failed", email_error: String(e?.message ?? e) }).eq("id", report_id);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  } catch (e) { return json({ error: String(e?.message ?? e) }, 500); }
});
