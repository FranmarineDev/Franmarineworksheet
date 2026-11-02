// Supabase Edge Function: send-closeout-report
// Emails the day close-out PDF (already uploaded by the app) to the job region's managers.
// Secrets: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_URL, CLOSEOUT_CC (optional extra recipients)

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const hrs = (m: unknown) => m == null ? "—" : `${Math.floor(Number(m) / 60)}h ${String(Number(m) % 60).padStart(2, "0")}m`;

// Email-safe card grid (tables, inline styles — renders in Outlook)
const card = (l: string, v: unknown) => `<td style="padding:4px"><div style="border:1px solid #d7dde5;background:#f8f9fb;border-radius:4px;padding:6px 10px"><div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.3px">${esc(l)}</div><div style="font-weight:700;font-size:13px;margin-top:2px">${esc(v) || "—"}</div></div></td>`;
const grid = (items: [string, unknown][], per = 3) => {
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += per) rows.push(`<tr>${items.slice(i, i + per).map(([l, v]) => card(l, v)).join("")}${"<td></td>".repeat(Math.max(0, per - items.slice(i, i + per).length))}</tr>`);
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;table-layout:fixed;margin:2px -4px 6px">${rows.join("")}</table>`;
};
const band = (t: string) => `<div style="background:#002060;color:#fff;font-weight:700;font-size:12px;letter-spacing:.5px;text-transform:uppercase;padding:7px 12px;border-left:7px solid #2e8bc0;margin:14px 0 8px">${esc(t)}</div>`;
const head = (t: string) => `<div style="background:#e8edf7;color:#002060;font-weight:700;font-size:12px;padding:5px 10px;border-left:4px solid #2e8bc0;margin:10px 0 4px">${esc(t)}</div>`;
const para = (t: unknown) => `<div style="padding:2px 10px;font-size:13px;white-space:pre-wrap">${esc(t || "—")}</div>`;

function summaryHTML(d: any): string {
  if (!d) return "";
  const times = (d.times ?? []) as [string, string][];
  return band("Day details") +
    grid([["Project", d.project], ["Job No.", d.job_no], ["Date", d.date], ["Location", d.location], ["Vessel / Facility", d.vessel], ["Client", d.client], ["Supervisor", d.supervisor], ["Region", d.region], ["Mode", d.diving === false ? "Non-diving" : "Diving"]]) +
    head("Times") + grid(times, 4) +
    grid([["Paid hours", hrs(d.paid_min)], ["Onsite hours", hrs(d.onsite_min)], ["Team", `${(d.team ?? []).length}${(d.team ?? []).length ? " — " + d.team.join(", ") : ""}`]]) +
    (d.diving === false ? "" : grid([["Dives", `${d.dives ?? 0}${(d.divers ?? []).length ? " (" + d.divers.map((x: any) => `${x.name} ×${x.dives}`).join(", ") + ")" : ""}`], ["Bottom time", hrs(d.bottom_min)], ["Drill", d.drill]])) +
    grid([["SWMS", d.swms], ["Equipment", (d.equipment ?? []).join(", ")], ["Incidents", (d.incidents ?? []).length ? d.incidents.map((i: any) => `${i.severity} ${i.type}`).join("; ") : "none"]]) +
    band("Close-out") +
    head("Progress made today") + para(d.progress) +
    head("Challenges faced") + para(d.challenges) +
    head("Improvement suggestions") + para(d.improvements) +
    (d.tomorrow ? head("Plan for tomorrow") + para(d.tomorrow) : "") +
    ((d.issues ?? []).length ? `<div style="margin-top:12px;padding:8px 12px;border:1px solid #f0c36d;background:#fff8e6;border-radius:4px;font-size:12px"><b>Still missing on the sheet:</b> ${esc(d.issues.join(", "))}</div>` : `<div style="margin-top:12px;color:#27ae60;font-size:12px"><b>✓ Sheet complete</b></div>`);
}

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
    const cc = (Deno.env.get("CLOSEOUT_CC") ?? "").split(",").map((s) => s.trim()).filter((e) => e && !to.includes(e));
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
    const body = rep.summary ? summaryHTML(rep.summary)
      : `<pre style="background:#f4f6fa;border:1px solid #d7dde5;border-radius:6px;padding:12px;font:12.5px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap">${esc(rep.summary_text ?? "")}</pre>`;
    const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:680px;color:#1a2332">
  <div style="background:#002060;color:#fff;padding:14px 18px;border-bottom:5px solid #2e8bc0">
    <div style="font-size:18px;font-weight:700;letter-spacing:1px">FRANMARINE</div>
    <div style="font-size:12px;opacity:.85">Daily Worksheet — day close-out</div>
  </div>
  <div style="padding:16px 18px;font-size:14px">
    <div style="font-size:17px;font-weight:700;color:#002060">${esc(rep.jobs?.job_no)} — ${esc(rep.jobs?.project)}</div>
    <div style="color:#6b7280;font-size:13px;margin-bottom:6px">${date} · ${esc(region)} · submitted by ${esc(rep.sent_by_name)} · full report attached</div>
    ${body}
    ${appUrl ? `<p style="margin-top:16px"><a href="${appUrl}" style="background:#002060;color:#fff;text-decoration:none;padding:9px 14px;border-radius:6px;font-weight:600;font-size:13px">Open the Daily Worksheet</a></p>` : ""}
    <p style="color:#6b7280;font-size:12px;margin-top:18px">Sent automatically from the Franmarine Daily Worksheet to the ${esc(region)} managers.</p>
  </div>
</div>`;
    const text = `${rep.summary_text ?? ""}\n\nSubmitted by: ${rep.sent_by_name}\n${appUrl}`;

    const transporter = nodemailer.createTransport({
      host: Deno.env.get("SMTP_HOST") ?? "smtp.office365.com", port: Number(Deno.env.get("SMTP_PORT") ?? 587), secure: false, requireTLS: true,
      auth: { user: Deno.env.get("SMTP_USER"), pass: Deno.env.get("SMTP_PASS") },
    });
    try {
      await transporter.sendMail({ from: Deno.env.get("SMTP_FROM") ?? `"Franmarine Worksheet" <${Deno.env.get("SMTP_USER")}>`, to, cc, subject, text, html,
        attachments: [{ filename: rep.file_name ?? "DayCloseOut.pdf", content: pdf, contentType: "application/pdf" }] });
      await admin.from("closeout_reports").update({ email_status: "sent", emailed_to: to, emailed_cc: cc, emailed_at: new Date().toISOString(), email_error: null }).eq("id", report_id);
      return json({ to, cc });
    } catch (e) {
      await admin.from("closeout_reports").update({ email_status: "failed", email_error: String(e?.message ?? e) }).eq("id", report_id);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  } catch (e) { return json({ error: String(e?.message ?? e) }, 500); }
});
