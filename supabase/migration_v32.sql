-- Daily Worksheet v3.2 — managers may delete a job in their region once it has no live day sheets (voided ones cascade with it)
drop policy if exists "jobs: managers delete" on public.jobs;
create policy "jobs: managers delete" on public.jobs for delete to authenticated
  using (public.is_manager() and public.can_see_region(region)
         and not exists (select 1 from public.worksheets w where w.job_id = jobs.id and w.voided_at is null));
