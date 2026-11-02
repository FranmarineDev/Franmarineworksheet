-- =====================================================================
-- Franmarine Daily Worksheet — Supabase schema  (v2)
-- Run the whole file in: Supabase dashboard → SQL Editor → New query → Run
-- Safe to re-run: every statement is idempotent.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Profiles (one row per login, auto-created) ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'supervisor' check (role in ('manager', 'supervisor')),
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists role   text not null default 'supervisor';
alter table public.profiles add column if not exists region text check (region in ('NSW', 'WA'));   -- home region
update public.profiles set region = 'NSW' where region is null;   -- everyone belongs to a region
alter table public.profiles alter column region set default 'NSW';
alter table public.profiles alter column region set not null;

-- First person to sign up becomes a manager; everyone after is a supervisor
-- until a manager changes their role in Table Editor → profiles.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role, region)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
          case when (select count(*) from public.profiles) = 0 then 'manager' else 'supervisor' end,
          'NSW')   -- new people start in NSW; a manager moves them to WA if needed
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'manager');
$$;

-- Home region of the signed-in user.
create or replace function public.my_region()
returns text language sql stable security definer set search_path = public as $$
  select region from public.profiles where id = auth.uid();
$$;

-- Can the signed-in user see things belonging to this region? Strictly their own.
create or replace function public.can_see_region(r text)
returns boolean language sql stable security definer set search_path = public as $$
  select r = public.my_region();
$$;

-- ---------- Crew list (names offered when building a team roster) ----------
create table if not exists public.crew (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  position   text,
  region     text not null default 'NSW' check (region in ('NSW', 'WA')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

update public.crew set region = 'NSW' where region is null;
alter table public.crew alter column region set default 'NSW';
alter table public.crew alter column region set not null;

-- ---------- Equipment / fleet list (offered in "Equipment Used Onsite") ----------
create table if not exists public.equipment (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  category   text,
  region     text not null default 'NSW' check (region in ('NSW', 'WA')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.equipment enable row level security;
drop policy if exists "equipment: read"           on public.equipment;
drop policy if exists "equipment: managers write" on public.equipment;
create policy "equipment: read"           on public.equipment for select to authenticated using (public.can_see_region(region));
create policy "equipment: managers write" on public.equipment for all    to authenticated
  using (public.is_manager() and public.can_see_region(region)) with check (public.is_manager() and public.can_see_region(region));

-- ---------- Jobs ----------
create table if not exists public.jobs (
  id          uuid primary key default gen_random_uuid(),
  job_no      text not null,
  project     text not null,
  client      text,
  location    text,
  vessel      text,
  region      text not null default 'NSW' check (region in ('NSW', 'WA')),
  supervisor  text,
  contact     text,
  contact_ph  text,
  status      text not null default 'active' check (status in ('active', 'complete')),
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists jobs_status_idx on public.jobs (status, created_at desc);
alter table public.jobs add column if not exists archived_at timestamptz;
alter table public.jobs add column if not exists start_date date;                    -- planned first day on site
alter table public.jobs add column if not exists supervisor_notified_at timestamptz; -- notify-job-assigned function
alter table public.jobs add column if not exists supervisor_notified_to text;
alter table public.jobs add column if not exists swms jsonb;
alter table public.jobs add column if not exists crew text[] not null default '{}';   -- names rostered on the job (pre-fills day 1's team)                         -- SWMS attached to the job (same shape as a worksheet's); files at job/<id>/swms/

-- ---------- Worksheets (one per job per day; the whole form lives in `data`) ----------
create table if not exists public.worksheets (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs (id) on delete cascade,
  ws_date         date not null,
  supervisor      text,
  data            jsonb not null default '{}'::jsonb,
  summary         jsonb,                            -- compact figures for reporting (written by the app)
  version         integer not null default 1,      -- optimistic concurrency
  locked          boolean not null default false,  -- signed off
  locked_by_name  text,
  locked_at       timestamptz,
  created_by      uuid references public.profiles (id),
  updated_by      uuid references public.profiles (id),
  updated_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (job_id, ws_date)
);
alter table public.worksheets add column if not exists summary        jsonb;
alter table public.worksheets add column if not exists locked         boolean not null default false;
alter table public.worksheets add column if not exists locked_by_name text;
alter table public.worksheets add column if not exists locked_at      timestamptz;
create index if not exists worksheets_job_date_idx on public.worksheets (job_id, ws_date desc);

-- ---------- Row Level Security ----------
alter table public.profiles   enable row level security;
alter table public.crew       enable row level security;
alter table public.jobs       enable row level security;
alter table public.worksheets enable row level security;

drop policy if exists "profiles: read all"     on public.profiles;
drop policy if exists "profiles: edit own"     on public.profiles;
drop policy if exists "profiles: managers edit" on public.profiles;
drop policy if exists "crew: read"             on public.crew;
drop policy if exists "crew: managers write"   on public.crew;
drop policy if exists "jobs: staff"            on public.jobs;
drop policy if exists "jobs: read"             on public.jobs;
drop policy if exists "jobs: managers write"   on public.jobs;
drop policy if exists "worksheets: staff"      on public.worksheets;
drop policy if exists "worksheets: read"       on public.worksheets;
drop policy if exists "worksheets: insert"     on public.worksheets;
drop policy if exists "worksheets: update"     on public.worksheets;
drop policy if exists "worksheets: managers delete" on public.worksheets;

-- Everyone signed in can see profiles / crew / jobs / worksheets
create policy "profiles: read all" on public.profiles for select to authenticated using (true);
create policy "profiles: edit own" on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id and role = (select role from public.profiles p where p.id = auth.uid()));
-- Managers set everyone's role and home region (the app's Users panel)
create policy "profiles: managers edit" on public.profiles for update to authenticated
  using (public.is_manager() and public.can_see_region(region)) with check (public.is_manager());
  -- (using = the person is currently in my region; with check has no region test so a
  --  manager can hand someone over to the other region)

-- Everything below is REGION-SCOPED: you only ever see your own region.
create policy "crew: read"           on public.crew for select to authenticated using (public.can_see_region(region));
create policy "crew: managers write" on public.crew for all    to authenticated
  using (public.is_manager() and public.can_see_region(region)) with check (public.is_manager() and public.can_see_region(region));

-- Jobs: managers create / edit / complete / delete within their region; supervisors read their region
create policy "jobs: read"           on public.jobs for select to authenticated using (public.can_see_region(region));
create policy "jobs: managers write" on public.jobs for all    to authenticated
  using (public.is_manager() and public.can_see_region(region)) with check (public.is_manager() and public.can_see_region(region));

-- Worksheets follow their job's region. A signed-off (locked) sheet can only be
-- changed by a manager (that is how it gets unlocked).
create or replace function public.can_see_job(j uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.jobs where id = j and public.can_see_region(region));
$$;
create policy "worksheets: read"   on public.worksheets for select to authenticated using (public.can_see_job(job_id));
create policy "worksheets: insert" on public.worksheets for insert to authenticated with check (public.can_see_job(job_id));
create policy "worksheets: update" on public.worksheets for update to authenticated
  using (public.can_see_job(job_id) and (not locked or public.is_manager())) with check (public.can_see_job(job_id));
create policy "worksheets: managers delete" on public.worksheets for delete to authenticated
  using (public.is_manager() and public.can_see_job(job_id));

-- ---------- Incidents / near-misses (sent to the region's managers by the notify-incident function) ----------
create table if not exists public.incidents (
  id                   uuid primary key default gen_random_uuid(),
  worksheet_id         uuid references public.worksheets (id) on delete set null,
  job_id               uuid not null references public.jobs (id) on delete cascade,
  ws_date              date not null,
  type                 text not null,
  severity             text not null check (severity in ('Low', 'Medium', 'High')),
  occurred_at          time,
  people               text,
  location             text,
  description          text not null,
  actions              text,
  injury               text,
  work_stopped         text,
  photos               jsonb not null default '[]'::jsonb,       -- storage paths
  status               text not null default 'open' check (status in ('open', 'acknowledged', 'closed')),
  reported_by          uuid references public.profiles (id),
  reported_by_name     text,
  acknowledged_by      uuid references public.profiles (id),
  acknowledged_by_name text,
  acknowledged_at      timestamptz,
  email_status         text not null default 'pending' check (email_status in ('pending', 'sent', 'failed')),
  email_error          text,
  emailed_to           text[],
  emailed_at           timestamptz,
  pdf_path             text,                                    -- storage path of the generated PDF
  created_at           timestamptz not null default now()
);
alter table public.incidents add column if not exists pdf_path text;
create index if not exists incidents_job_idx on public.incidents (job_id, created_at desc);
alter table public.incidents enable row level security;
drop policy if exists "incidents: read"          on public.incidents;
drop policy if exists "incidents: report"        on public.incidents;
drop policy if exists "incidents: managers edit" on public.incidents;
create policy "incidents: read"   on public.incidents for select to authenticated using (public.can_see_job(job_id));
create policy "incidents: report" on public.incidents for insert to authenticated with check (public.can_see_job(job_id));
-- reporter may attach photos right after reporting; managers acknowledge / close
create policy "incidents: managers edit" on public.incidents for update to authenticated
  using (public.can_see_job(job_id) and (public.is_manager() or reported_by = auth.uid()))
  with check (public.can_see_job(job_id));

-- ---------- Emergency drill reports emailed to HSEQ (send-drill-report function) ----------
create table if not exists public.drill_reports (
  id            uuid primary key default gen_random_uuid(),
  worksheet_id  uuid references public.worksheets (id) on delete set null,
  job_id        uuid not null references public.jobs (id) on delete cascade,
  ws_date       date not null,
  drill_type    text,
  pdf_path      text not null,            -- storage path of the generated PDF
  file_name     text,
  attendees     text[],
  steps         integer,
  sent_by       uuid references public.profiles (id),
  sent_by_name  text,
  email_status  text not null default 'pending' check (email_status in ('pending', 'sent', 'failed')),
  email_error   text,
  emailed_to    text[],
  emailed_cc    text[],
  emailed_at    timestamptz,
  created_at    timestamptz not null default now()
);
alter table public.drill_reports enable row level security;
drop policy if exists "drill_reports: read"   on public.drill_reports;
drop policy if exists "drill_reports: insert" on public.drill_reports;
create policy "drill_reports: read"   on public.drill_reports for select to authenticated using (public.can_see_job(job_id));
create policy "drill_reports: insert" on public.drill_reports for insert to authenticated with check (public.can_see_job(job_id));

-- ---------- Day close-out reports emailed to the region's managers (send-closeout-report function) ----------
create table if not exists public.closeout_reports (
  id            uuid primary key default gen_random_uuid(),
  worksheet_id  uuid references public.worksheets (id) on delete set null,
  job_id        uuid not null references public.jobs (id) on delete cascade,
  ws_date       date not null,
  pdf_path      text not null,
  file_name     text,
  summary_text  text,
  sent_by       uuid references public.profiles (id),
  sent_by_name  text,
  email_status  text not null default 'pending' check (email_status in ('pending', 'sent', 'failed')),
  email_error   text,
  emailed_to    text[],
  emailed_at    timestamptz,
  created_at    timestamptz not null default now()
);
alter table public.closeout_reports add column if not exists summary jsonb;
alter table public.closeout_reports add column if not exists emailed_cc text[];
alter table public.closeout_reports enable row level security;
drop policy if exists "closeout_reports: read"   on public.closeout_reports;
drop policy if exists "closeout_reports: insert" on public.closeout_reports;
create policy "closeout_reports: read"   on public.closeout_reports for select to authenticated using (public.can_see_job(job_id));
create policy "closeout_reports: insert" on public.closeout_reports for insert to authenticated with check (public.can_see_job(job_id));

-- ---------- Storage bucket for SWMS / permit files ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('worksheet-files', 'worksheet-files', false, 26214400)      -- 25 MB per file
on conflict (id) do update set public = false;

drop policy if exists "worksheet-files: read"   on storage.objects;
drop policy if exists "worksheet-files: write"  on storage.objects;
drop policy if exists "worksheet-files: update" on storage.objects;
drop policy if exists "worksheet-files: delete" on storage.objects;
-- Object paths are "<worksheet id>/<file id>/<page>" (visibility follows the worksheet)
-- or "job/<job id>/swms/<page>" (visibility follows the job)
create or replace function public.can_see_file(path text)
returns boolean language sql stable security definer set search_path = public as $$
  select case when split_part(path, '/', 1) = 'job'
    then exists (select 1 from public.jobs j where j.id::text = split_part(path, '/', 2) and public.can_see_job(j.id))
    else exists (select 1 from public.worksheets w where w.id::text = split_part(path, '/', 1) and public.can_see_job(w.job_id))
  end;
$$;
create policy "worksheet-files: read"   on storage.objects for select to authenticated using (bucket_id = 'worksheet-files' and public.can_see_file(name));
create policy "worksheet-files: write"  on storage.objects for insert to authenticated with check (bucket_id = 'worksheet-files' and public.can_see_file(name));
create policy "worksheet-files: update" on storage.objects for update to authenticated using (bucket_id = 'worksheet-files' and public.can_see_file(name));
create policy "worksheet-files: delete" on storage.objects for delete to authenticated using (bucket_id = 'worksheet-files' and public.can_see_file(name));

-- ---------- Reporting views (read these from the SQL editor, or feed CrewHub / the regional report) ----------
create or replace view public.job_summary as
select j.id, j.job_no, j.project, j.client, j.region, j.status,
       count(w.id)                                   as days_worked,
       min(w.ws_date)                                as first_day,
       max(w.ws_date)                                as last_day,
       count(w.id) filter (where w.locked)           as days_signed_off,
       coalesce(sum((w.summary->>'dives')::int), 0)  as dives,
       round(coalesce(sum((w.summary->>'bottom_min')::numeric), 0) / 60, 1) as bottom_hours,
       round(coalesce(sum((w.summary->>'onsite_min')::numeric), 0) / 60, 1) as onsite_hours,
       count(w.id) filter (where w.summary->>'drill' is not null and w.summary->>'drill' <> '') as drills,
       coalesce(sum((w.summary->>'permits')::int), 0) as permits
from public.jobs j
left join public.worksheets w on w.job_id = j.id
group by j.id;

create or replace view public.diver_hours as
select j.job_no, j.project, w.ws_date, w.locked,
       d->>'name'                 as diver,
       (d->>'dives')::int         as dives,
       (d->>'bottom_min')::int    as bottom_min,
       (d->>'dive_min')::int      as dive_min,
       (d->>'max_depth')::numeric as max_depth_m
from public.worksheets w
join public.jobs j on j.id = w.job_id
cross join lateral jsonb_array_elements(coalesce(w.summary->'divers', '[]'::jsonb)) d;

-- Make the views run as the person querying them, so region scoping applies there too.
alter view public.job_summary set (security_invoker = on);
alter view public.diver_hours set (security_invoker = on);


-- ---------- Storage usage (managers) ----------
create or replace function public.storage_usage()
returns jsonb language plpgsql stable security definer set search_path = public, storage as $$
declare r jsonb;
begin
  if not public.is_manager() then raise exception 'managers only'; end if;
  select jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'files_bytes', coalesce((select sum((o.metadata->>'size')::bigint) from storage.objects o where o.bucket_id = 'worksheet-files'), 0),
    'files_count', (select count(*) from storage.objects o where o.bucket_id = 'worksheet-files'),
    'by_job', coalesce((
      select jsonb_agg(x order by (x->>'bytes')::bigint desc) from (
        select jsonb_build_object('job_no', j.job_no, 'status', j.status, 'archived_at', j.archived_at, 'region', j.region,
                                  'bytes', sum((o.metadata->>'size')::bigint)) as x
        from storage.objects o
        join public.worksheets w on w.id::text = split_part(o.name, '/', 1)
        join public.jobs j on j.id = w.job_id
        where o.bucket_id = 'worksheet-files' and public.can_see_region(j.region)
        group by j.id, j.job_no, j.status, j.archived_at, j.region) s), '[]'::jsonb)
  ) into r;
  return r;
end $$;
grant execute on function public.storage_usage() to authenticated;
