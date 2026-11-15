-- Daily Worksheet v4.1 — one nominated supervisor per day sheet (agreed with Sam, 15 Nov 2026)
--  • Each job and day sheet carries supervisor_id (a user account), not just a typed name.
--  • Only the nominated supervisor can edit an unsigned sheet. Managers can edit any sheet (signed or not);
--    every edit made by anyone other than the nominated supervisor is recorded field by field in worksheet_edits.
--  • Anyone signed in (not a guest) can start a job or a new day and nominate its supervisor.
--    Changing the nominated supervisor on an existing sheet is a manager action (logged).
--  • Files on a sheet: the nominated supervisor while unsigned; managers always. Job files: managers or the job's creator.

-- ---------- columns + backfill (exact name match within the region) ----------
alter table public.jobs       add column if not exists supervisor_id uuid references public.profiles(id) on delete set null;
alter table public.worksheets add column if not exists supervisor_id uuid references public.profiles(id) on delete set null;
create index if not exists jobs_supervisor_id_idx       on public.jobs(supervisor_id);
create index if not exists worksheets_supervisor_id_idx on public.worksheets(supervisor_id);

update public.jobs j set supervisor_id = p.id
from public.profiles p
where j.supervisor_id is null and p.role <> 'guest' and p.region = j.region
  and lower(trim(p.full_name)) = lower(trim(j.supervisor));

update public.worksheets w set supervisor_id = p.id
from public.jobs j, public.profiles p
where w.job_id = j.id and w.supervisor_id is null and p.role <> 'guest' and p.region = j.region
  and lower(trim(p.full_name)) = lower(trim(coalesce(w.supervisor, w.data->'fields'->>'da_supervisor')));

-- ---------- audit of edits by anyone other than the nominated supervisor ----------
create table if not exists public.worksheet_edits (
  id bigint generated always as identity primary key,
  worksheet_id uuid not null references public.worksheets(id) on delete cascade,
  at timestamptz not null default now(),
  by_id uuid, by_name text,
  field text not null, old_value text, new_value text
);
create index if not exists worksheet_edits_ws_idx on public.worksheet_edits(worksheet_id, at);
alter table public.worksheet_edits enable row level security;
drop policy if exists "worksheet_edits: read" on public.worksheet_edits;
create policy "worksheet_edits: read" on public.worksheet_edits for select to authenticated
  using (exists (select 1 from public.worksheets w where w.id = worksheet_id and public.can_see_job(w.job_id)));
-- no insert/update/delete policies: rows are written only by the trigger below

create or replace function public.audit_worksheet_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); who text;
  jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '');
begin
  if jwt_role <> 'authenticated' then return new; end if;   -- service role / direct SQL
  if new.supervisor_id is distinct from old.supervisor_id and not public.is_manager() then
    raise exception 'only a manager can change the nominated supervisor';
  end if;
  if uid is not distinct from old.supervisor_id and new.supervisor_id is not distinct from old.supervisor_id then
    return new;   -- the nominated supervisor editing their own sheet
  end if;
  select full_name into who from public.profiles where id = uid;

  if new.supervisor_id is distinct from old.supervisor_id then
    insert into public.worksheet_edits (worksheet_id, by_id, by_name, field, old_value, new_value)
    values (new.id, uid, who, 'Nominated supervisor',
            (select full_name from public.profiles where id = old.supervisor_id), (select full_name from public.profiles where id = new.supervisor_id));
  end if;
  -- field-by-field changes
  insert into public.worksheet_edits (worksheet_id, by_id, by_name, field, old_value, new_value)
  select new.id, uid, who, coalesce(o.key, n.key), left(o.value, 2000), left(n.value, 2000)
  from jsonb_each_text(coalesce(old.data->'fields', '{}'::jsonb)) o
  full join jsonb_each_text(coalesce(new.data->'fields', '{}'::jsonb)) n on n.key = o.key
  where coalesce(o.value, '') is distinct from coalesce(n.value, '');
  -- signatures (keys only — the images are too large to copy)
  insert into public.worksheet_edits (worksheet_id, by_id, by_name, field, old_value, new_value)
  select new.id, uid, who, 'signature: ' || coalesce(o.key, n.key),
         case when o.key is null then null else 'signed' end, case when n.key is null then 'removed' else 'signed (changed)' end
  from jsonb_each(coalesce(old.data->'sigs', '{}'::jsonb)) o
  full join jsonb_each(coalesce(new.data->'sigs', '{}'::jsonb)) n on n.key = o.key
  where o.value is distinct from n.value;
  -- whole sections
  insert into public.worksheet_edits (worksheet_id, by_id, by_name, field, old_value, new_value)
  select new.id, uid, who, s.k, left((old.data->s.k)::text, 2000), left((new.data->s.k)::text, 2000)
  from unnest(array['team', 'activity', 'equipment', 'swms', 'plan', 'permits', 'divingMode']) s(k)
  where (old.data->s.k) is distinct from (new.data->s.k);
  if old.locked is distinct from new.locked then
    insert into public.worksheet_edits (worksheet_id, by_id, by_name, field, old_value, new_value)
    values (new.id, uid, who, 'signed off', old.locked::text, new.locked::text);
  end if;
  return new;
end $$;
revoke all on function public.audit_worksheet_update() from public, anon, authenticated;
drop trigger if exists audit_worksheet_update on public.worksheets;
create trigger audit_worksheet_update before update on public.worksheets
  for each row execute function public.audit_worksheet_update();

-- ---------- who may update a sheet ----------
drop policy if exists "worksheets: update" on public.worksheets;
create policy "worksheets: update" on public.worksheets for update to authenticated
  using (public.can_see_job(job_id) and (public.is_manager() or (supervisor_id = (select auth.uid()) and not locked)))
  with check (public.can_see_job(job_id));

-- ---------- anyone signed in (not a guest) can start a job; its creator can finish setting it up ----------
drop policy if exists "jobs: insert" on public.jobs;
create policy "jobs: insert" on public.jobs for insert to authenticated
  with check (not public.is_guest() and public.can_see_region(region));
drop policy if exists "jobs: creator update" on public.jobs;
create policy "jobs: creator update" on public.jobs for update to authenticated
  using (created_by = (select auth.uid()) and public.can_see_region(region))
  with check (created_by = (select auth.uid()) and public.can_see_region(region));

-- ---------- files ----------
create or replace function public.can_write_file(path text)
returns boolean language sql stable security definer set search_path = public as $$
  select case when split_part(path, '/', 1) = 'job'
    then exists (select 1 from public.jobs j where j.id::text = split_part(path, '/', 2) and public.can_see_job(j.id)
                 and (public.is_manager() or j.created_by = auth.uid()))
    else exists (select 1 from public.worksheets w where w.id::text = split_part(path, '/', 1) and public.can_see_job(w.job_id)
                 and (public.is_manager() or (w.supervisor_id = auth.uid() and not w.locked)))
  end;
$$;
