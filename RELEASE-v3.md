# Daily Worksheet v3 — production runbook

Target: FranmarineDev/Franmarineworksheet (GitHub Pages) + Supabase project **Franmarine Paperwork** (`anecqzkjxxgwfshckqjd`).
Everything below is additive. Nothing deletes or rewrites existing rows. Total hands-on time ≈ 20 minutes.

**Do the steps in this order.** The new `index.html` selects columns that only exist after step 1 — pushing the page first takes the dashboard down for everyone.

---

## 0. Before you start (5 min)

- [ ] Pick a time after the last sheet is signed off (after 17:00) and not the evening before a Defence job start.
- [ ] Open the Supabase dashboard → SQL Editor, and GitHub → the repo, in two tabs.
- [ ] Confirm nobody has a sheet open: dashboard shows no "TODAY OPEN" badge, or ask.
- [ ] Note the current commit on `main` (for rollback): `git log -1 --oneline main`.

## 1. Database — run two SQL files (3 min)

In the Supabase SQL Editor, paste and **Run** each file in full, in this order. Both are safe to re-run.

1. `supabase/migration_v3.sql`
   Adds: `closeout_reports.extra_to`, `worksheets.voided_at / voided_by_name / void_reason`, `incidents.notifiable`, `jobs.dive_plan`.
2. `supabase/mgmt_stats.sql`
   Adds: `profiles.can_view_management`, `incidents.injury_class / days_lost`, function `mgmt_stats(int)`, tables `controlled_docs` + `doc_reviews` with policies and 4 seed rows, `reports` storage bucket.

Verify (paste in the SQL editor):

```sql
select column_name from information_schema.columns where table_name='worksheets' and column_name in ('voided_at','void_reason');          -- 2 rows
select column_name from information_schema.columns where table_name='incidents' and column_name in ('notifiable','injury_class');        -- 2 rows
select column_name from information_schema.columns where table_name='profiles' and column_name='can_view_management';                   -- 1 row
select doc_no, next_review from controlled_docs order by doc_no;                                                                         -- 4 rows
select id from storage.buckets where id='reports';                                                                                       -- 1 row
```

Grant management access (edit names to match `profiles.full_name`):

```sql
update profiles set can_view_management = true where full_name in ('Kirby Hamilton', 'Sam Diamond', 'Belinda Brooks');
select full_name, role, region, can_view_management from profiles where can_view_management;
```

Fix the seeded review dates to match the real register (approval date and next review):

```sql
update controlled_docs set rev='23', approval_date='2026-xx-xx', last_review='2026-xx-xx', next_review='2027-xx-xx' where doc_no='OPS-DOC-002';
-- same for FUS-DIVE-TPL and HSE-REG-001; OPS-FRM-014 was seeded with today's date, which is correct for the first release
```

Test the RPC as yourself: the SQL editor runs as postgres (no JWT), so the flag check will refuse it there — that is correct behaviour. It is exercised from the app in step 4.

## 2. Edge functions (3 min)

Redeploy the two changed functions (old versions keep working, they just ignore the new fields — so this can also be done the next morning):

```
supabase functions deploy send-closeout-report --project-ref anecqzkjxxgwfshckqjd
supabase functions deploy notify-incident      --project-ref anecqzkjxxgwfshckqjd
```

Or paste each `index.ts` into the dashboard editor for that function and deploy. No new secrets are needed.

## 3. App (2 min)

Merge `v3` into `main` and push (or upload the four files). GitHub Pages redeploys in about a minute.

```
git checkout main && git merge v3 && git push
```

Crews with the app open get "↻ App updated — reload". Their in-progress sheet survives the reload.

## 4. Smoke test (10 min) — do this on an iPad in Safari, signed in as yourself

- [ ] Login lands on **Management View** (you have the flag). Tiles show numbers, not an error toast. If you see "✗ management access required" the flag update in step 1 missed your name.
- [ ] Open **East paperwork** → Jobs dashboard shows the existing jobs with their day sheets.
- [ ] Open an existing signed-off sheet: everything reads as before, new fields are blank, PDF export works, footer shows `OPS-FRM-014 Rev 1`.
- [ ] Create a test job **FS0000 – Release test**, open today's sheet:
  - [ ] Project Overview: set classification, pick 24-hour times in Start/End of Day → pinned rows appear top/bottom of Daily Activities.
  - [ ] Toolbox: dive plan briefing fields save.
  - [ ] SWMS & Dive Plan: drop a PDF in the Dive Plan slot → renders; Plan No./Rev fill in.
  - [ ] Diving Log: tick certs on a fit-to-dive row and sign → stamp appears under the signature. Add a dive, sign diver + supervisor verify.
  - [ ] Quick Log (📋 Log Activity): bottom sheet with ticking clock; add a line.
  - [ ] Day Close-Out: compliance panel renders; add an "Also send to" address (your own) and send the close-out → email arrives with you on CC.
  - [ ] Incident: fill one with Notifiable = No, send → email arrives; Notifiable = Yes shows the red block.
  - [ ] Options → Sign off & lock → then Unlock as manager → reason prompt → Close-Out shows the change log → PDF has a Record Control page.
  - [ ] Options → ⛔ Void this day sheet → reason → sheet disappears from the dashboard (row still in the table).
- [ ] Manage → Controlled documents: register shows 4 rows; record a review on one; Specimen PDF opens.
- [ ] Management View → Monthly report → Preview opens a PDF.
- [ ] Sign out, sign in as a **supervisor** account → lands on the Jobs dashboard, no "‹ Management" button.
- [ ] Mark FS0000 complete (keep it — it is the proof the release was tested).

## 5. If something is wrong — rollback (2 min)

App only: `git revert HEAD && git push` (Pages redeploys in a minute). The database columns can stay; the old app ignores them.
Database: nothing to undo — all additions are nullable or defaulted and unused by the old app.

## Known gaps (not blockers)

- `monthly-report` edge function and its pg_cron schedule are not written yet — the Monthly report button lists nothing until the first issue; Preview works now.
- `incident_actions` table not built — "Corrective actions overdue" tile reads 0.
- "Send reminder to supervisors" on drill-downs shows a toast only.
- The compliance panel is advisory; the only hard gates are the reason prompts on sign-off-with-gaps, unlock and void.
- Hyperbaric doctor has no WA default — Sam to supply the Fiona Stanley on-call number.

## What changed (for the commit / Sam)

Dashboard: bundled jobs with day cards, Manage menu, completed-jobs filter, new header. Worksheet: Project Overview tab first; 24-hour pickers; pinned payroll rows; drill alert; signature-warning modal; Quick Log sheet; client acknowledgement; close-out extra recipients. Compliance (WHS Reg 2025 Pt 4.8 / AS/NZS 2299.1): classification block, dive plan briefing + upload, fit-to-dive cert declaration, s 180 dive log order + incident field, s 181 per-dive verification with user/time stamps, vessel POB, MaintainX plant tick, notifiable-incident determination, void instead of delete, controlled-form footer + change log + export log, compliance check panel and PDF page. Management View for flagged users. Controlled-document register with review prompts and filing PDFs.

---

## v3.1 (Fri 6 Nov, after first-morning feedback)

**Database first** — paste `supabase/migration_v31.sql` into the SQL editor and Run (safe to re-run). It adds incident withdrawal columns + status, lets management-flagged users see both regions, and excludes withdrawn incidents from `mgmt_stats`. The v3.1 page selects the new incident columns, so merge the app only after this has run.

**App** — `git checkout main && git merge v3.1 && git push`.

Changes: Withdraw button on incidents (reporter or manager, reason required; record kept, drops off the day, close-out and management figures); signature stamp reads "captured on <login>'s login" since crew sign on the supervisor's device; dive plan reference falls back to the PDF file name when it is not FUS-DIVE numbered, D-03 treats a missing revision as review not fail; Close-Out summary rebuilds every time the tab opens; East/West segment on the Jobs dashboard for management users.

## v3.4 — monthly report scheduler

1. Edge Functions → Secrets → add `CRON_SECRET` (any long random string, e.g. from a password generator).
2. SQL editor → paste `supabase/migration_v34.sql`, replace `CRON_SECRET_VALUE` with the same string, Run. It enables pg_cron + pg_net, lets the scheduler call `mgmt_stats`, and schedules `monthly-ops-report` for 00:00 UTC on the 1st (11:00 AEDT / 10:00 AEST).
3. Test without waiting: Management View → Monthly report → "Issue last month's report now". The file lands in the `reports` bucket as `YYYY-MM-monthly-report.html` and is emailed to everyone with Management View (+ `MONTHLY_TO` secret, optional).
