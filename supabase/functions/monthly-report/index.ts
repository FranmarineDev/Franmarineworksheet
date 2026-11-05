// Supabase Edge Function: monthly-report
// Builds the Monthly Operations & HSEQ Report for the previous calendar month from mgmt_stats(),
// files it in the `reports` bucket as YYYY-MM-monthly-report.html and emails it to everyone with
// Management View (profiles.can_view_management) plus MONTHLY_TO (optional, comma-separated).
//
// Called two ways:
//   • pg_cron on the 1st (see migration_v34.sql): POST with header x-cron-secret = CRON_SECRET
//   • from the app by a management user: { resend: "<file>" } re-emails an issued report,
//     { issue: true } issues the previous month now, { preview: true } returns the HTML without filing/emailing
// Secrets: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_URL, CRON_SECRET, MONTHLY_TO (optional)

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const n = (v: unknown) => (v == null || v === "" ? 0 : Number(v));
const hrs = (m: unknown) => m == null ? "—" : `${Math.floor(n(m) / 60)}h ${String(n(m) % 60).padStart(2, "0")}m`;

// Previous calendar month in Australia/Sydney: label, and how many days back mgmt_stats should look
function previousMonth(now = new Date()) {
  const syd = new Date(now.toLocaleString("en-US", { timeZone: "Australia/Sydney" }));
  const first = new Date(syd.getFullYear(), syd.getMonth(), 1);              // 1st of the current month
  const prev = new Date(first.getFullYear(), first.getMonth() - 1, 1);       // 1st of the previous month
  const daysInPrev = Math.round((first.getTime() - prev.getTime()) / 86400000);
  const key = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
  const label = prev.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
  // mgmt_stats uses current_date - period_days as the start; on the 1st that lands on the 1st of the previous month
  return { key, label, period_days: daysInPrev + (syd.getDate() - 1) };
}

/* ---------- report HTML (self-contained, prints to A4) ---------- */
const S = {
  band: "background:#002060;color:#fff;font-weight:700;font-size:12px;letter-spacing:.5px;text-transform:uppercase;padding:7px 12px;border-left:7px solid #2e8bc0;margin:18px 0 8px",
  sub: "background:#e8edf7;color:#002060;font-weight:700;font-size:12px;padding:5px 10px;border-left:4px solid #2e8bc0;margin:12px 0 6px",
  th: "background:#f1f4f9;color:#002060;font-size:11px;text-transform:uppercase;letter-spacing:.3px;padding:6px 8px;border:1px solid #d7dde5;text-align:left",
  td: "padding:5px 8px;border:1px solid #d7dde5;font-size:12.5px;vertical-align:top",
};
const table = (heads: string[], rows: (string | number | null | undefined)[][], empty = "Nothing in this period.") =>
  `<table style="border-collapse:collapse;width:100%;margin:4px 0 8px"><thead><tr>${heads.map((h) => `<th style="${S.th}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td style="${S.td}">${esc(c ?? "—")}</td>`).join("")}</tr>`).join("") : `<tr><td style="${S.td};color:#6b7280" colspan="${heads.length}">${esc(empty)}</td></tr>`
  }</tbody></table>`;
const cards = (items: [string, unknown][], per = 4) => {
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += per) rows.push(`<tr>${items.slice(i, i + per).map(([l, v]) => `<td style="padding:4px"><div style="border:1px solid #d7dde5;background:#f8f9fb;border-radius:4px;padding:6px 10px"><div style="font-size:10px;color:#6b7280;text-transform:uppercase">${esc(l)}</div><div style="font-weight:700;font-size:16px;margin-top:2px">${esc(v ?? "—")}</div></div></td>`).join("")}</tr>`);
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed;margin:2px -4px 6px">${rows.join("")}</table>`;
};

function buildReportHTML(d: any, label: string, issuedAt: Date) {
  const E = d.east || {}, W = d.west || {}, T = (k: string) => n(E[k]) + n(W[k]);
  const ew = (k: string) => [n(E[k]), n(W[k]), T(k)];
  const pct = (v: unknown) => v == null ? "—" : `${v}%`;
  const body =
    `<div style="${S.band}">Operations</div>` +
    cards([["Day sheets", T("sheets")], ["Dive hours", (T("dive_min") / 60).toFixed(1)], ["Person-days", T("person_days")], ["Jobs with activity", T("jobs_active")],
      ["Active jobs", T("running_jobs")], ["Dives logged", T("dives")], ["Divers used", T("divers_used")], ["Sign-off within 24h", pct(d.signoff_24h_pct)]]) +
    `<div style="${S.sub}">Regional comparison</div>` +
    table(["Measure", "East", "West", "Total"], [
      ["Day sheets", ...ew("sheets")], ["Dive days / non-dive days", `${n(E.dive_days)} / ${n(E.nondive_days)}`, `${n(W.dive_days)} / ${n(W.nondive_days)}`, `${T("dive_days")} / ${T("nondive_days")}`],
      ["Dives logged", ...ew("dives")], ["Avg dives per dive day", n(E.dive_days) ? (n(E.dives) / n(E.dive_days)).toFixed(1) : "—", n(W.dive_days) ? (n(W.dives) / n(W.dive_days)).toFixed(1) : "—", T("dive_days") ? (T("dives") / T("dive_days")).toFixed(1) : "—"],
      ["Dive hours", (n(E.dive_min) / 60).toFixed(1), (n(W.dive_min) / 60).toFixed(1), (T("dive_min") / 60).toFixed(1)], ["Divers used", ...ew("divers_used")],
      ["Person-days on site", ...ew("person_days")], ["Avg crew per sheet", E.avg_crew ?? "—", W.avg_crew ?? "—", d.avg_crew ?? "—"],
      ["Active jobs", ...ew("running_jobs")], ["Jobs with activity", ...ew("jobs_active")],
      ["Overtime hours (>8 h/day)", n(E.overtime_hours).toFixed(1), n(W.overtime_hours).toFixed(1), (n(E.overtime_hours) + n(W.overtime_hours)).toFixed(1)],
      ["Days over quoted hours", ...ew("over_quote_days")], ["Sign-off within 24h", pct(E.signoff_24h_pct), pct(W.signoff_24h_pct), pct(d.signoff_24h_pct)]]) +
    `<div style="${S.sub}">Sheets per week</div>` + table(["Week", "East", "West", "Total"], (d.weekly || []).map((w: any) => [w.label, n(w.east), n(w.west), n(w.east) + n(w.west)])) +
    `<div style="${S.sub}">Most utilised divers</div>` + table(["Diver", "Region", "Dives", "Dive days", "Jobs", "Bottom time"], (d.top_divers || []).slice(0, 10).map((x: any) => [x.name, x.region, x.dives, x.days, x.jobs, hrs(x.bottom_min)])) +
    `<div style="${S.sub}">Most utilised supervisors</div>` + table(["Supervisor", "Region", "Day sheets", "Jobs", "Dives", "Person-days"], (d.top_supervisors || []).slice(0, 10).map((x: any) => [x.supervisor, x.region, x.sheets, x.jobs, x.dives, x.person_days])) +
    `<div style="${S.sub}">Quoted vs actual hours</div>` + table(["Job", "Region", "Quoted h/day", "Quoted days", "Days", "Actual h", "Days over", "vs quote"], (d.quote_tracking || []).map((q: any) => [`${q.job_no} ${q.project || ""}`, q.region, q.quoted_hours_per_day, q.quoted_days ?? "—", q.days, q.paid_hours, q.days_over, q.over_pct == null ? "—" : `${q.over_pct > 0 ? "+" : ""}${q.over_pct}%`]), "No jobs with quoted hours set.") +
    `<div style="${S.band}">Audit</div>` +
    table(["Item", "East", "West", "Total"], [["Unsigned >48h", ...ew("unsigned_48h")], ["No toolbox talk", ...ew("no_toolbox")], ["No SWMS", ...ew("no_swms")], ["Dive records missing bottom time", ...ew("missing_bt")], ["Edited after sign-off", ...ew("edited_after_lock")], ["Voided", ...ew("voided")]]) +
    `<div style="${S.sub}">Open items at month end</div>` + table(["Age (d)", "Item", "Job / date", "Region", "Supervisor"], (d.open_audit || []).map((a: any) => [Math.floor(n(a.age_days)), a.item, `${a.job_no} · ${a.ws_date}`, a.region, a.supervisor || ""]), "No open audit items.") +
    `<div style="${S.sub}">Sign-off performance by supervisor</div>` + table(["Supervisor", "Region", "Sheets", "Within 24h"], (d.signoff_by_supervisor || []).map((s: any) => [s.supervisor, s.region, s.sheets, `${s.pct}%`])) +
    `<div style="${S.band}">Incidents &amp; HSEQ</div>` +
    cards([["Incidents", T("incidents")], ["Near misses", T("near_misses")], ["FAI / MTI / LTI", `${T("fai")} / ${T("mti")} / ${T("lti")}`], ["Days since LTI", d.days_since_lti ?? "—"], ["Open investigations", T("open_investigations")], ["Actions overdue", T("actions_overdue")], ["Reported within 24h", pct(d.reported_24h_pct ?? 100)], ["Spills", T("spills")]]) +
    `<div style="${S.sub}">Register</div>` + table(["Date", "Job", "Region", "Type", "Class", "What happened", "Status"], (d.incident_register || []).map((i: any) => [i.ws_date, i.job_no, i.region, i.type, i.injury_class || "—", (i.description || "").slice(0, 90), i.status]), "No incidents in the period.") +
    `<div style="${S.band}">Equipment</div>` +
    cards([["Items used", T("items_used")], ["Dive system days", T("dive_system_days")], ["Vessel days", T("vessel_days")], ["Issues noted", T("items_issues")]]) +
    table(["Item", "Category", "Region", "Days", "Jobs", "Last used", "Notes flagged"], (d.equipment_usage || []).slice(0, 40).map((e: any) => [e.item, e.category || "", e.region, e.days, e.jobs, e.last_used || "", e.flagged || 0]));
  const issued = issuedAt.toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Monthly Operations &amp; HSEQ Report — ${esc(label)}</title>
<style>@page{size:A4;margin:14mm} body{margin:0;background:#fff} @media print{.noprint{display:none}}</style></head>
<body><div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:860px;margin:0 auto;color:#1a2332">
  <div style="background:#002060;color:#fff;padding:14px 18px;border-bottom:5px solid #2e8bc0">
    <div style="font-size:18px;font-weight:700;letter-spacing:1px">FRANMARINE</div>
    <div style="font-size:13px;opacity:.9;margin-top:2px">Monthly Operations &amp; HSEQ Report — <b>${esc(label)}</b> · East &amp; West</div>
    <div style="font-size:11px;opacity:.75;margin-top:2px">Issued ${esc(issued)} · OPS-RPT-001 · COMMERCIAL-IN-CONFIDENCE</div>
  </div>
  <div style="padding:10px 18px 18px">${body}
    <p style="color:#6b7280;font-size:11px;margin-top:16px">Generated automatically by the Franmarine Daily Worksheet from the day sheets, incidents and equipment logs for the period. Figures exclude voided sheets and withdrawn incidents. Overtime = paid time beyond 8 h per person per day.</p>
  </div></div></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));

    // Who is calling: the scheduler (secret header) or a management user
    const cronOk = !!Deno.env.get("CRON_SECRET") && req.headers.get("x-cron-secret") === Deno.env.get("CRON_SECRET");
    let caller = "scheduler";
    if (!cronOk) {
      const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
      const { data: { user } } = await asUser.auth.getUser();
      if (!user) return json({ error: "not signed in" }, 401);
      const { data: me } = await admin.from("profiles").select("full_name, can_view_management").eq("id", user.id).single();
      if (!me?.can_view_management) return json({ error: "management access required" }, 403);
      caller = me.full_name ?? user.email ?? "manager";
    }

    // Recipients: everyone with Management View + MONTHLY_TO
    const { data: mg } = await admin.from("profiles").select("email").eq("can_view_management", true);
    const to = [...new Set([...(mg ?? []).map((m) => m.email), ...(Deno.env.get("MONTHLY_TO") ?? "").split(",")].map((s) => String(s ?? "").trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
    if (!to.length) return json({ error: "nobody has management access to send to" }, 500);

    const appUrl = Deno.env.get("APP_URL") ?? "";
    const transporter = nodemailer.createTransport({ host: Deno.env.get("SMTP_HOST") ?? "smtp.office365.com", port: Number(Deno.env.get("SMTP_PORT") ?? 587), secure: false, requireTLS: true, auth: { user: Deno.env.get("SMTP_USER"), pass: Deno.env.get("SMTP_PASS") } });
    const from = Deno.env.get("SMTP_FROM") ?? `"Franmarine Worksheet" <${Deno.env.get("SMTP_USER")}>`;
    const mailFor = (file: string, label: string, html: string, note: string) => transporter.sendMail({
      from, to, subject: `Monthly Operations & HSEQ Report — ${label}`,
      text: `Monthly Operations & HSEQ Report — ${label}\n\nThe full report is attached (${file}).${note ? "\n" + note : ""}\n\n${appUrl}`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:860px;color:#1a2332">${html.replace(/^[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*$/, "")}
        ${appUrl ? `<p style="margin:16px 18px"><a href="${appUrl}" style="background:#002060;color:#fff;text-decoration:none;padding:9px 14px;border-radius:6px;font-weight:600;font-size:13px">Open Management View</a></p>` : ""}
        <p style="color:#6b7280;font-size:12px;margin:0 18px 18px">${esc(note)} Sent automatically to everyone with Management View; the report is also filed in the app under Monthly report.</p></div>`,
      attachments: [{ filename: file, content: html, contentType: "text/html" }],
    });

    // Re-send an issued report as it was filed
    if (body.resend) {
      const file = String(body.resend);
      const { data: f, error } = await admin.storage.from("reports").download(file);
      if (error || !f) return json({ error: "report not found: " + file }, 404);
      const html = await f.text();
      const label = (html.match(/Report — <b>([^<]+)<\/b>/) || [])[1] ?? file.slice(0, 7);
      await mailFor(file, label, html, `Re-sent by ${caller}.`);
      return json({ ok: true, to, file, resent: true });
    }

    // Issue (scheduler, or "issue now" from the app) / preview
    const pm = previousMonth();
    const period_days = Number(body.period_days) > 0 ? Number(body.period_days) : pm.period_days;
    const { data: d, error: rpcErr } = await admin.rpc("mgmt_stats", { period_days });
    if (rpcErr) return json({ error: "mgmt_stats: " + rpcErr.message }, 500);
    const now = new Date();
    const html = buildReportHTML(d, pm.label, now);
    if (body.preview) return new Response(html, { headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } });

    const file = `${pm.key}-monthly-report.html`;
    const { error: upErr } = await admin.storage.from("reports").upload(file, new Blob([html], { type: "text/html" }), { contentType: "text/html", upsert: true });
    if (upErr) return json({ error: "could not file the report: " + upErr.message }, 500);
    await mailFor(file, pm.label, html, caller === "scheduler" ? "" : `Issued by ${caller}.`);
    return json({ ok: true, to, file, period_days, issued_by: caller });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
