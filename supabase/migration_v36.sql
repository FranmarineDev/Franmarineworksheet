-- Daily Worksheet v3.6 — work type on the job card (diving / non-diving); non-diving jobs get no dive log, dive plan or diving rules
alter table public.jobs add column if not exists work_type text not null default 'diving';
alter table public.jobs drop constraint if exists jobs_work_type_check;
alter table public.jobs add constraint jobs_work_type_check check (work_type in ('diving','nondiving'));
