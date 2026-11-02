# Franmarine — Daily Worksheet (Supabase edition, v2)

Field worksheet with Franmarine login, a jobs dashboard, cloud sync, sign-off, and reporting.

| File | What it is |
|---|---|
| `index.html` | The whole app: login → jobs dashboard → worksheet. One file. |
| `sw.js` | Service worker — caches the app so it opens with no signal. |
| `supabase/schema.sql` | Tables, security policies, storage bucket, reporting views. Run once (safe to re-run). |
| `manifest.webmanifest`, `icon-*.png` | Add-to-Home-Screen on iPad/iPhone. |

## What it does
- **Jobs dashboard** — running jobs as cards. Managers add/edit/complete jobs; supervisors open worksheets. Each card shows a status signal: **TODAY OPEN**, **SIGNED OFF TODAY**, or **NO WORKSHEET TODAY** (amber, from 9 am), plus who last touched it.
- **One worksheet per job per day.** *+ Today's worksheet* creates it with Job No., Project and Date fixed from the job card (read-only on the sheet) and the **team, diver names, hats, supervisor, chamber details and SWMS copied from the previous day's sheet** on that job. Times, dive entries, drills and signatures start blank.
- **Crew list** (managers, *👥 Crew*) — names offered when building the team roster, so spelling stays consistent and the data stays queryable.
- **Sign off & lock** (Options menu) — supervisor signs the sheet off at end of day; it becomes read-only. Only a manager can unlock. Enforced in the database, not just the screen.
- **Saves on the device instantly, syncs in the background.** Works fully offline; edits (including on sheets you've closed) sync when signal returns — the dashboard shows a banner while anything is waiting.
- **SWMS / permit files** go to Supabase Storage, not into the worksheet. A PDF uploaded with no internet is kept and rendered later. The SWMS carries over day to day without re-uploading.
- **Summary** button per job — days worked, signed-off count, dives, bottom time, time on site, drills, permits, and a per-diver table. The same figures are in the `job_summary` and `diver_hours` SQL views for the regional report / cost tracker.
- Two people on one sheet: the second to sync is told who else edited it and chooses which version to keep.

## One-time setup (about 20 minutes)

### 1. Supabase project
1. supabase.com → **New project** under a **Franmarine** account (not a personal one), region Sydney (`ap-southeast-2`). Add a second owner under Organisation → Team.
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**. This also creates the private `worksheet-files` storage bucket and the reporting views.
3. **Authentication → Providers → Email**: turn **off** "Confirm email".
4. **Authentication → Sign In / Up**: turn **off** "Allow new users to sign up".
5. **Authentication → URL Configuration → Site URL**: your GitHub Pages address, e.g. `https://<username>.github.io/franmarine-worksheet/`.
6. Optional but recommended — **Project Settings → Authentication → SMTP**: use a Franmarine mailbox so password-reset emails come from a Franmarine address rather than Supabase's generic sender (crew ignore those).

### 2. Keys into the app
**Project Settings → API** → copy **Project URL** and the **anon public** key into the two constants near the top of the `<script>` in `index.html`:
```js
const SUPABASE_URL      = 'https://xxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ...';
```
The anon key is safe to publish — row-level security means nothing is readable without a login.

### 3. Users and roles
**Authentication → Users → Add user → Create new user** (email + starting password, tick **Auto Confirm User**).
- The **first** user created becomes a **manager** automatically; everyone after is a **supervisor**.
- To promote someone: **Table Editor → profiles → role** → `manager`. Same place to set `full_name`.
- Supervisors can: open/create/edit worksheets, sign off. Managers can also: add/edit/complete jobs, manage the crew list, unlock sheets.

### 4. Publish
Push to GitHub, Pages set to *Deploy from a branch → main / root*. Open the URL on the iPad → Share → **Add to Home Screen**. The app caches itself on first load, so it opens offline afterwards.

## Updating the app
Edit `index.html`, **bump `CACHE` in `sw.js`** (e.g. `v3` → `v4`), commit, push. Devices pick up the new version on their next online open and show a "reload to update" message. Data lives in Supabase, so updates never touch it.

## Reporting
In the SQL editor (or any Postgres client with a login):
```sql
select * from job_summary order by last_day desc;
select * from diver_hours where ws_date >= '2026-11-01' order by diver, ws_date;
```
`worksheets.summary` holds each day's compact figures; `worksheets.data` is the full sheet as JSON.

## Emails (Edge Functions)
Three functions send mail through `no-reply@franmarine.com.au` (secrets `SMTP_HOST/PORT/USER/PASS/FROM`, `APP_URL`):
- `notify-incident` → the job region's managers + HSEQ (`HSEQ_TO`, default Belinda), incident PDF attached.
- `send-drill-report` → `DRILL_TO` (default Belinda), cc region managers, drill PDF attached.
- `send-closeout-report` → region managers (optional `CLOSEOUT_CC`), day close-out PDF attached. Sent from the **Close-Out** tab.

## Day Close-Out, equipment, QR codes
- **Close-Out** tab: auto summary of the day (times, dives, hours, issues, unsigned items) + progress / challenges / improvements / tomorrow, sent as PDF to the region managers.
- **Equipment Used Onsite**: pick from the equipment list (managers maintain it in Options → Equipment; `equipment` table).
- Pre-start QR codes are per region (`qr/nsw-*.png`, `qr/wa-*.png`) and are shown on the sheet for the job's region.
- **Hours CSV** per job and **Import jobs** from a spreadsheet are in the dashboard (managers).

## Storage
- Signatures are stored small (~3 KB each) inside the worksheet record.
- Uploaded PDFs keep the original file plus rendered page images. On a **completed** job, managers can **🗄 Archive files** on the job card: page images are deleted, originals and all data stay. Download the Worksheet package first if you want the pages laid out.
- Options → Users shows a storage gauge (files and database against the plan limits in `PLAN_LIMITS` in `index.html` — update it when the Supabase plan changes).

## Backups
**Table Editor → worksheets → Export as CSV** for a quick manual backup, or the per-sheet *Save to JSON* in the app. Supabase's own point-in-time backups need a paid plan. Files are in Storage → `worksheet-files`.

## Not yet done
- **Server-side PDF archive** on sign-off (an Edge Function rendering the sheet to PDF into Storage). Needs a headless browser in the function; planned as the next step once this is live. *Export PDF* from the Options menu still works on the device.
