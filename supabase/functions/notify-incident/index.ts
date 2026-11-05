// Supabase Edge Function: notify-incident
// Emails every manager in the job's region when an incident is reported.
// Called by the app right after it inserts the incident row:  functions.invoke('notify-incident', { body: { incident_id } })
//
// Secrets (Edge Functions → Secrets):  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_URL
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    // Who is calling? Must be a signed-in user.
    const auth = req.headers.get("Authorization") ?? "";
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);

    const { incident_id } = await req.json();
    if (!incident_id) return json({ error: "incident_id required" }, 400);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: inc, error } = await admin.from("incidents")
      .select("*, jobs(job_no, project, region, location, client)").eq("id", incident_id).single();
    if (error || !inc) return json({ error: "incident not found" }, 404);
    if (inc.email_status === "sent") return json({ sent_to: inc.emailed_to ?? [], already: true });

    const region = inc.jobs?.region;
    const { data: mgrs } = await admin.from("profiles").select("email, full_name").eq("role", "manager").eq("region", region);
    // Region managers + HSEQ (HSEQ_TO secret, default Belinda)
    const hseq = (Deno.env.get("HSEQ_TO") ?? "belinda.brooks@franmarine.com.au").split(",").map((s) => s.trim()).filter(Boolean);
    const to = [...new Set([...(mgrs ?? []).map((m) => m.email).filter(Boolean), ...hseq])];
    if (!to.length) {
      await admin.from("incidents").update({ email_status: "failed", email_error: `no managers in ${region}` }).eq("id", incident_id);
      return json({ sent_to: [], error: `no managers in ${region}` });
    }

    const appUrl = Deno.env.get("APP_URL") ?? "";
    const sev = inc.severity;
    const colour = sev === "High" ? "#c0392b" : sev === "Medium" ? "#e67e22" : "#6b7280";
    const date = new Date(inc.ws_date + "T00:00:00").toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
    const nf = (inc.notifiable ?? {}) as Record<string, string>;
    const notifiable = nf.status === "Yes";
    const subject = `${notifiable ? "[NOTIFIABLE] " : ""}[${sev.toUpperCase()}] ${inc.type} — ${inc.jobs?.job_no} ${inc.jobs?.project} — ${date}`;
    const row = (k: string, v: unknown) => v ? `<tr><td style="padding:6px 10px;color:#6b7280;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 10px">${esc(v)}</td></tr>` : "";
    const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;color:#1a2332">
  <div style="background:#002060;color:#fff;padding:14px 18px;border-bottom:5px solid #2e8bc0">
    <div style="font-size:18px;font-weight:700;letter-spacing:1px">FRANMARINE</div>
    <div style="font-size:12px;opacity:.85">Daily Worksheet — incident notification</div>
  </div>
  <div style="padding:16px 18px">
    <div style="display:inline-block;background:${colour};color:#fff;font-weight:700;padding:3px 10px;border-radius:4px;font-size:12px">${esc(sev)} SEVERITY</div>
    <h2 style="margin:10px 0 4px;font-size:18px">${esc(inc.type)}</h2>
    <div style="color:#6b7280;font-size:13px">${esc(inc.jobs?.job_no)} · ${esc(inc.jobs?.project)} · ${esc(inc.jobs?.location ?? "")} · ${date}${inc.occurred_at ? " " + esc(String(inc.occurred_at).slice(0, 5)) : ""}</div>
    <table style="border-collapse:collapse;margin-top:14px;font-size:14px;width:100%">
      ${row("Reported by", inc.reported_by_name)}
      ${row("People involved", inc.people)}
      ${row("Where", inc.location)}
      ${row("What happened", inc.description)}
      ${row("Immediate actions", inc.actions)}
      ${row("Injury", inc.injury)}
      ${row("Work stopped", inc.work_stopped)}
      ${nf.status ? row("Notifiable (WHS Act s 35–39)", nf.status) : ""}
      ${notifiable ? row("Regulator", nf.regulator) + row("Became aware", nf.aware_time) + row("Regulator notified", nf.notified_time ? `${nf.notified_time} by ${nf.method ?? ""} (${nf.notified_by ?? ""})` : "NOT YET NOTIFIED — notify immediately") + row("Reference", nf.reference) + row("Site preserved", nf.site_preserved) : ""}
      ${row("Photos", (inc.photos ?? []).length ? `${inc.photos.length} — see attached PDF` : "")}
    </table>
    ${appUrl ? `<p style="margin-top:18px"><a href="${appUrl}" style="background:#002060;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">Open the Daily Worksheet</a></p>` : ""}
    <p style="color:#6b7280;font-size:12px;margin-top:18px">Please acknowledge the incident on the dashboard once you have followed up. This email was sent automatically to the ${esc(region)} managers and HSEQ.</p>
  </div>
</div>`;
    const text = `${sev.toUpperCase()} — ${inc.type}\n${inc.jobs?.job_no} ${inc.jobs?.project} — ${date}\n\nReported by: ${inc.reported_by_name}\nPeople: ${inc.people ?? ""}\nWhere: ${inc.location ?? ""}\n\nWhat happened:\n${inc.description}\n\nImmediate actions:\n${inc.actions ?? ""}\n\nInjury: ${inc.injury ?? ""}   Work stopped: ${inc.work_stopped ?? ""}\n\n${appUrl}`;

    // Attach the PDF the app generated, if it is there
    const attachments: { filename: string; content: Uint8Array; contentType: string }[] = [];
    if (inc.pdf_path) {
      const { data: file } = await admin.storage.from("worksheet-files").download(inc.pdf_path);
      if (file) attachments.push({ filename: `${inc.jobs?.job_no}_${inc.ws_date}_Incident.pdf`.replace(/\s+/g, "_"), content: new Uint8Array(await file.arrayBuffer()), contentType: "application/pdf" });
    }

    const transporter = nodemailer.createTransport({
      host: Deno.env.get("SMTP_HOST") ?? "smtp.office365.com",
      port: Number(Deno.env.get("SMTP_PORT") ?? 587),
      secure: false,
      requireTLS: true,
      auth: { user: Deno.env.get("SMTP_USER"), pass: Deno.env.get("SMTP_PASS") },
    });
    try {
      await transporter.sendMail({ from: Deno.env.get("SMTP_FROM") ?? `"Franmarine Worksheet" <${Deno.env.get("SMTP_USER")}>`, to, subject, text, html, attachments, priority: sev === "High" ? "high" : "normal" });
      await admin.from("incidents").update({ email_status: "sent", emailed_to: to, emailed_at: new Date().toISOString(), email_error: null }).eq("id", incident_id);
      return json({ sent_to: to });
    } catch (e) {
      await admin.from("incidents").update({ email_status: "failed", email_error: String(e?.message ?? e) }).eq("id", incident_id);
      return json({ sent_to: [], error: String(e?.message ?? e) }, 500);
    }
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
