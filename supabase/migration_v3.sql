-- Daily Worksheet v3 — run once in the Supabase SQL editor (safe to re-run)
-- Close-out: extra recipients the supervisor adds for one day's report (client / stakeholders)
alter table public.closeout_reports add column if not exists extra_to text[] not null default '{}';
alter table public.closeout_reports add column if not exists emailed_cc text[];
-- S4: day sheets are voided, never deleted
alter table public.worksheets add column if not exists voided_at timestamptz;
alter table public.worksheets add column if not exists voided_by_name text;
alter table public.worksheets add column if not exists void_reason text;
-- S5: notifiable-incident determination and regulator notification record (WHS Act s 35-39)
alter table public.incidents add column if not exists notifiable jsonb;
-- optional hardening: stop managers deleting worksheets from the client (void instead)
-- drop policy if exists "managers delete worksheets" on public.worksheets;
alter table public.jobs add column if not exists dive_plan jsonb;   -- dive plan PDF on the job card (same shape as swms)
