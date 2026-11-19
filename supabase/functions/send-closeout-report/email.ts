// Day close-out email — layout "A · Summary first" (agreed with Sam, 19 Nov 2026).
// Email-safe: tables + inline styles (Outlook), one column that reads on a phone, a small <style> block for
// phone tweaks (clients that drop it still get a readable layout) and iOS data-detector suppression for times.
// No imports, so it can be previewed outside Deno.

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const hrs = (m: unknown) => m == null || m === "" || isNaN(Number(m)) ? "—" : `${Math.floor(Number(m) / 60)}h ${String(Number(m) % 60).padStart(2, "0")}m`;
const cap = (s: unknown) => { const t = String(s ?? "").trim(); return t ? t[0].toUpperCase() + t.slice(1) : ""; };

const NAVY = "#002060", ACCENT = "#2e8bc0", TEXT = "#1a2332", BODY = "#3d4654", MUTED = "#5b6472", LINE = "#dfe4ec", SOFT = "#eef1f5";
const FONT = "Arial, Helvetica, sans-serif";

const TIME_LABELS: Record<string, string> = {
  "Start Day": "start", "Departed Workshop": "left workshop", "Arrived Onsite": "on site", "Job Completed": "job done",
  "Departed Site": "off site", "Arrived Workshop": "workshop", "Finished Day": "finish",
};

const h2 = (t: string, first = false) =>
  `<tr><td style="padding:${first ? 6 : 20}px 0 6px;font-family:${FONT};font-size:13px;font-weight:700;color:${NAVY};text-transform:uppercase;letter-spacing:.8px;border-bottom:2px solid ${NAVY}">${esc(t)}</td></tr>`;
const para = (t: unknown) =>
  `<tr><td class="fm-p" style="padding:8px 0 0;font-family:${FONT};font-size:15px;line-height:1.55;color:${TEXT};white-space:pre-wrap">${esc(String(t ?? "").trim() || "—")}</td></tr>`;
const kpi = (label: string, value: string) =>
  `<td class="fm-kpi" valign="top" style="padding:12px 14px;border:1px solid ${LINE};font-family:${FONT}">` +
  `<div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.5px">${esc(label)}</div>` +
  `<div style="font-size:20px;font-weight:700;color:${NAVY};margin-top:4px;white-space:nowrap">${esc(value)}</div></td>`;
const row = (label: string, value: unknown, last = false) => {
  const b = last ? "" : `border-bottom:1px solid ${SOFT};`;
  const v = String(value ?? "").trim();
  return `<tr><td class="fm-lbl" valign="top" width="130" style="width:130px;padding:9px 12px 9px 0;${b}font-family:${FONT};font-size:14px;color:${MUTED}">${esc(label)}</td>` +
    `<td class="fm-val" valign="top" style="padding:9px 0;${b}font-family:${FONT};font-size:14px;line-height:1.5;color:${v ? TEXT : MUTED}">${esc(v || "None recorded")}</td></tr>`;
};

export function attachmentName(fileName: unknown) {
  // "F12221_2026-11-15_DayCloseOut.pdf" → "F12221 2026-11-15 Day Close-Out.pdf"
  return String(fileName || "Day Close-Out.pdf").replace(/_/g, " ").replace(/DayCloseOut/g, "Day Close-Out");
}

export function closeoutEmail(d: any, opt: { jobNo?: string; project?: string; region?: string; sentBy?: string; wsDate?: string;
  appUrl?: string; pdfBytes?: number; ccNames?: string[] }) {
  const s = d ?? {};
  const jobNo = s.job_no || opt.jobNo || "", project = s.project || opt.project || "", region = s.region || opt.region || "";
  const wsDate = s.date || opt.wsDate || "";
  const dateLong = wsDate ? new Date(wsDate + "T00:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "";
  const place = [s.location, s.vessel, s.client].filter((x: unknown) => String(x ?? "").trim()).map(esc).join(" · ");
  const diving = s.diving !== false;
  const team: string[] = Array.isArray(s.team) ? s.team.filter(Boolean) : [];
  const issues: string[] = Array.isArray(s.issues) ? s.issues : [];
  const supervisor = s.supervisor || opt.sentBy || "";

  const status = issues.length
    ? `<span style="display:inline-block;background:#fff4e0;color:#8a5300;font-family:${FONT};font-size:13px;font-weight:700;padding:5px 10px;border-radius:999px">${issues.length} item${issues.length === 1 ? "" : "s"} missing on the sheet</span>`
    : `<span style="display:inline-block;background:#e7f5ec;color:#1b6b3a;font-family:${FONT};font-size:13px;font-weight:700;padding:5px 10px;border-radius:999px">&#10003; Sheet complete</span>`;

  const kpis = diving
    ? [["Paid hours", hrs(s.paid_min)], ["On site", hrs(s.onsite_min)], ["Dives", String(s.dives ?? 0)], ["Bottom time", hrs(s.bottom_min)]]
    : [["Paid hours", hrs(s.paid_min)], ["On site", hrs(s.onsite_min)], ["Team", String(team.length)], ["Mode", "Non-diving"]];
  // 2 × 2 grid: fits a phone without squeezing, still compact on desktop
  const kpiTable = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;table-layout:fixed">` +
    `<tr>${kpi(kpis[0][0], kpis[0][1])}${kpi(kpis[1][0], kpis[1][1])}</tr><tr>${kpi(kpis[2][0], kpis[2][1])}${kpi(kpis[3][0], kpis[3][1])}</tr></table>`;

  const times = (Array.isArray(s.times) ? s.times : []).filter((t: any) => t?.[1])
    .map((t: any) => `${esc(t[1])} ${esc(TIME_LABELS[t[0]] ?? String(t[0]).toLowerCase())}`).join(" · ");
  const divers = (Array.isArray(s.divers) ? s.divers : []).map((x: any) => `${x.name} ×${x.dives}`).join(", ");
  const incidents = (Array.isArray(s.incidents) ? s.incidents : []).map((i: any) => `${i.severity} ${i.type}`).join("; ");

  const notes = h2("Progress today", true) + para(s.progress) +
    h2("Challenges") + para(s.challenges) +
    (String(s.tomorrow ?? "").trim() ? h2("Plan for tomorrow") + para(s.tomorrow) : "") +
    h2("Improvement suggestions") + para(s.improvements) +
    (String(s.client_ack ?? "").trim() ? h2("Client acknowledgement") + para(s.client_ack) : "");

  const details = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">` +
    `<tr><td colspan="2" style="padding:0 0 4px;font-family:${FONT};font-size:13px;font-weight:700;color:${NAVY};text-transform:uppercase;letter-spacing:.8px;border-bottom:2px solid ${NAVY}">Day details</td></tr>` +
    (times ? `<tr><td class="fm-lbl" valign="top" width="130" style="width:130px;padding:9px 12px 9px 0;border-bottom:1px solid ${SOFT};font-family:${FONT};font-size:14px;color:${MUTED}">Times</td><td class="fm-val" valign="top" style="padding:9px 0;border-bottom:1px solid ${SOFT};font-family:${FONT};font-size:14px;line-height:1.5;color:${TEXT}">${times}</td></tr>` : "") +
    row(`Team (${team.length})`, team.join(", ")) +
    (diving ? row("Divers", divers) : "") +
    row("SWMS", s.swms) +
    row("Equipment", (Array.isArray(s.equipment) ? s.equipment : []).join(", ")) +
    (diving ? row("Drill", cap(s.drill) || "Not required") : "") +
    row("Incidents", incidents || "None", !issues.length) +
    (issues.length ? row("Missing on the sheet", issues.join(", "), true) : "") +
    `</table>`;

  const kb = opt.pdfBytes ? ` (PDF, ${Math.max(1, Math.round(opt.pdfBytes / 1024))} KB)` : " (PDF)";
  const button = opt.appUrl
    ? `<table role="presentation" cellspacing="0" cellpadding="0" class="fm-btnwrap"><tr><td bgcolor="${NAVY}" style="border-radius:6px"><a class="fm-btn" href="${esc(opt.appUrl)}" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:6px">Open the Daily Worksheet</a></td></tr></table>`
    : "";
  const cc = (opt.ccNames ?? []).filter(Boolean);
  const pre = `${jobNo} ${project} — ${issues.length ? issues.length + " missing" : "complete"}. ${String(s.progress ?? "").replace(/\s+/g, " ").slice(0, 120)}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="x-apple-disable-message-reformatting">
<title>Day close-out ${esc(jobNo)}</title>
<style>
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font:inherit!important}
u + #body a{color:inherit;text-decoration:none}
@media (max-width:620px){
  .fm-pad{padding-left:18px!important;padding-right:18px!important}
  .fm-outer{padding:0!important}
  .fm-card{border-radius:0!important}
  .fm-title{font-size:22px!important}
  .fm-p{font-size:16px!important}
  .fm-lbl{display:block!important;width:auto!important;padding:10px 0 0!important;border-bottom:0!important;font-size:12px!important}
  .fm-val{display:block!important;padding:2px 0 10px!important;font-size:15px!important}
  .fm-btnwrap,.fm-btnwrap td{width:100%!important}
  .fm-btn{display:block!important;text-align:center!important;font-size:16px!important;padding:14px 20px!important}
}
</style></head>
<body id="body" style="margin:0;padding:0;background:${SOFT}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(pre)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="${SOFT}" style="background:${SOFT}"><tr><td align="center" class="fm-outer" style="padding:24px 12px">
<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="fm-card" style="max-width:600px;background:#ffffff;border-radius:6px;border-collapse:separate">
<tr><td style="background:${NAVY};border-bottom:4px solid ${ACCENT};border-radius:6px 6px 0 0;padding:16px 28px" class="fm-pad">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
<td style="font-family:${FONT};font-size:15px;font-weight:700;letter-spacing:2px;color:#ffffff">FRANMARINE</td>
<td align="right" style="font-family:${FONT};font-size:13px;color:#c9d4ea">Day close-out</td></tr></table></td></tr>

<tr><td class="fm-pad" style="padding:24px 28px 6px">
<div style="font-family:${FONT};font-size:13px;color:${MUTED};letter-spacing:.4px">${esc(jobNo)}${region ? " · " + esc(region) : ""}</div>
<div class="fm-title" style="font-family:${FONT};font-size:24px;line-height:1.25;font-weight:700;color:${NAVY};margin:4px 0 6px">${esc(project)}</div>
<div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${BODY}">${esc(dateLong)}${place ? " · " + place : ""}</div>
<div style="margin-top:12px;font-family:${FONT};font-size:13px;color:${BODY}">${status}&nbsp;&nbsp;Supervisor <b style="color:${TEXT}">${esc(supervisor)}</b></div>
</td></tr>

<tr><td class="fm-pad" style="padding:16px 28px 4px">${kpiTable}</td></tr>

<tr><td class="fm-pad" style="padding:14px 28px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${notes}</table></td></tr>

<tr><td class="fm-pad" style="padding:26px 28px 4px">${details}</td></tr>

<tr><td class="fm-pad" style="padding:20px 28px 26px">${button}
<div style="font-family:${FONT};font-size:13px;color:${BODY};margin-top:${button ? 12 : 0}px">Full report attached${kb}</div></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
<div class="fm-pad" style="max-width:600px;margin:14px auto 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};text-align:left">Sent automatically from the Franmarine Daily Worksheet to the ${esc(region)} managers${cc.length ? ", cc " + esc(cc.join(", ")) : ""}.</div>
</td></tr></table>
</body></html>`;
}
