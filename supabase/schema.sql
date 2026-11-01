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

-- First person to sign up becomes a manager; everyone after is a supervisor
-- until a manager changes their role in Table Editor → profiles.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
          case when (select count(*) from public.profiles) = 0 then 'manager' else 'supervisor' end)
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

-- ---------- Crew list (names offered when building a team roster) ----------
create table if not exists public.crew (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  position   text,
  region     text check (region in ('NSW', 'WA')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

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
  using (public.is_manager()) with check (public.is_manager());

create policy "crew: read"           on public.crew for select to authenticated using (true);
create policy "crew: managers write" on public.crew for all    to authenticated using (public.is_manager()) with check (public.is_manager());

-- Jobs: managers create / edit / complete / delete; supervisors read
create policy "jobs: read"           on public.jobs for select to authenticated using (true);
create policy "jobs: managers write" on public.jobs for all    to authenticated using (public.is_manager()) with check (public.is_manager());

-- Worksheets: anyone signed in can create and edit, but a signed-off (locked)
-- sheet can only be changed by a manager (that is how it gets unlocked).
create policy "worksheets: read"   on public.worksheets for select to authenticated using (true);
create policy "worksheets: insert" on public.worksheets for insert to authenticated with check (true);
create policy "worksheets: update" on public.worksheets for update to authenticated
  using (not locked or public.is_manager()) with check (true);
create policy "worksheets: managers delete" on public.worksheets for delete to authenticated using (public.is_manager());

-- ---------- Storage bucket for SWMS / permit files ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('worksheet-files', 'worksheet-files', false, 26214400)      -- 25 MB per file
on conflict (id) do update set public = false;

drop policy if exists "worksheet-files: read"   on storage.objects;
drop policy if exists "worksheet-files: write"  on storage.objects;
drop policy if exists "worksheet-files: update" on storage.objects;
drop policy if exists "worksheet-files: delete" on storage.objects;
create policy "worksheet-files: read"   on storage.objects for select to authenticated using (bucket_id = 'worksheet-files');
create policy "worksheet-files: write"  on storage.objects for insert to authenticated with check (bucket_id = 'worksheet-files');
create policy "worksheet-files: update" on storage.objects for update to authenticated using (bucket_id = 'worksheet-files');
create policy "worksheet-files: delete" on storage.objects for delete to authenticated using (bucket_id = 'worksheet-files');

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

-- Views inherit the RLS of the tables underneath, so they need a login too.
