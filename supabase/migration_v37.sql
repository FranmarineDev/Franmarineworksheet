-- Daily Worksheet v3.7 — managers may delete any job in their region; every deletion is logged
drop policy if exists "jobs: managers delete" on public.jobs;
create policy "jobs: managers delete" on public.jobs for delete to authenticated
  using (public.is_manager() and public.can_see_region(region));

create table if not exists public.deleted_jobs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid, job_no text, project text, region text, client text,
  sheets int default 0, signed_sheets int default 0, incidents int default 0,
  deleted_by uuid default auth.uid(), deleted_by_name text, reason text,
  deleted_at timestamptz not null default now()
);
alter table public.deleted_jobs enable row level security;
drop policy if exists "deleted_jobs: managers insert" on public.deleted_jobs;
create policy "deleted_jobs: managers insert" on public.deleted_jobs for insert to authenticated with check (public.is_manager());
drop policy if exists "deleted_jobs: managers read" on public.deleted_jobs;
create policy "deleted_jobs: managers read" on public.deleted_jobs for select to authenticated using (public.is_manager());
