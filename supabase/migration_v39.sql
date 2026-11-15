-- Daily Worksheet v3.9 — access hardening (agreed with Kirby, 15 Nov 2026)
--  1. A user editing their own profile can change their name only — not role, region, email or Management View.
--  4. Only someone who already has Management View can grant or remove it.
--  3. Files behind a signed-off day sheet can only be changed by managers; job files (job/<id>/...) are manager-only to write.
-- Edge functions (service role) and direct SQL are unaffected.

-- ---------- 1 + 4: profile changes ----------
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare caller uuid := auth.uid(); caller_mgr boolean; caller_mv boolean;
  jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '');
begin
  if jwt_role not in ('authenticated', 'anon') then return new; end if;   -- service role (edge functions) / direct SQL
  select role = 'manager', coalesce(can_view_management, false) into caller_mgr, caller_mv from profiles where id = caller;
  if new.id is distinct from old.id or new.email is distinct from old.email then
    raise exception 'id and email cannot be changed here';
  end if;
  if (new.role is distinct from old.role or new.region is distinct from old.region) and not coalesce(caller_mgr, false) then
    raise exception 'only a manager can change role or region';
  end if;
  if new.can_view_management is distinct from old.can_view_management and not coalesce(caller_mv, false) then
    raise exception 'only someone with Management View can grant or remove it';
  end if;
  return new;
end $$;
revoke all on function public.guard_profile_update() from public, anon, authenticated;

drop trigger if exists guard_profile_update on public.profiles;
create trigger guard_profile_update before update on public.profiles
  for each row execute function public.guard_profile_update();

-- ---------- 3: files ----------
-- Writable when: job files → manager who can see the job; sheet files → can see the sheet and (sheet not signed off, or manager)
create or replace function public.can_write_file(path text)
returns boolean language sql stable security definer set search_path = public as $$
  select case when split_part(path, '/', 1) = 'job'
    then public.is_manager() and exists (select 1 from public.jobs j where j.id::text = split_part(path, '/', 2) and public.can_see_job(j.id))
    else exists (select 1 from public.worksheets w where w.id::text = split_part(path, '/', 1)
                 and public.can_see_job(w.job_id) and (not w.locked or public.is_manager()))
  end;
$$;
revoke all on function public.can_write_file(text) from public, anon;
grant execute on function public.can_write_file(text) to authenticated;

drop policy if exists "worksheet-files: write"  on storage.objects;
drop policy if exists "worksheet-files: update" on storage.objects;
drop policy if exists "worksheet-files: delete" on storage.objects;
create policy "worksheet-files: write"  on storage.objects for insert to authenticated
  with check (bucket_id = 'worksheet-files' and public.can_write_file(name));
create policy "worksheet-files: update" on storage.objects for update to authenticated
  using (bucket_id = 'worksheet-files' and public.can_write_file(name))
  with check (bucket_id = 'worksheet-files' and public.can_write_file(name));
create policy "worksheet-files: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'worksheet-files' and public.can_write_file(name));

-- Signed-in helpers don't need to be callable logged out
revoke execute on function public.can_see_file(text), public.can_see_job(uuid), public.can_see_region(text),
  public.is_manager(), public.my_region(), public.mgmt_stats(integer), public.storage_usage() from anon, public;
grant execute on function public.can_see_file(text), public.can_see_job(uuid), public.can_see_region(text),
  public.is_manager(), public.my_region(), public.mgmt_stats(integer), public.storage_usage() to authenticated;
