-- Daily Worksheet v3 — Management View + controlled documents. Run AFTER migration_v3.sql. Safe to re-run.
-- Management View — one RPC returning both regions' figures for a period.
-- security definer + flag check so a management user reads cross-region totals without widening RLS.
alter table public.profiles add column if not exists can_view_management boolean not null default false;
alter table public.incidents add column if not exists injury_class text check (injury_class in ('FAI','MTI','LTI'));
alter table public.incidents add column if not exists days_lost int;

create or replace function public.mgmt_stats(period_days int default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ok boolean; since date := current_date - period_days; res jsonb := '{}'::jsonb; r text; reg jsonb;
  ot_std constant int := 480;   -- paid minutes per person per day before overtime counts (8 h)
begin
  select can_view_management into ok from profiles where id = auth.uid();
  if not coalesce(ok, false) then raise exception 'management access required'; end if;

  foreach r in array array['NSW','WA'] loop
    select jsonb_build_object(
      'running_jobs',  (select count(*) from jobs j where j.region = r and j.status = 'active'),
      'supervisors',   (select count(distinct supervisor) from jobs j where j.region = r and j.status = 'active' and supervisor is not null),
      'sheets',        (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since and w.voided_at is null),
      'unsigned_48h',  (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.locked = false and w.voided_at is null and w.created_at < now() - interval '48 hours'),
      'no_toolbox',    (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since and w.voided_at is null and coalesce(w.data->'fields'->>'tb_cl_9','') = ''),
      'no_swms',       (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since and w.voided_at is null and (w.data->'swms') is null and j.swms is null),
      'missing_bt',    (select count(*) from worksheets w join jobs j on j.id = w.job_id, generate_series(0,7) i, generate_series(0,5) s
                          where j.region = r and w.ws_date >= since and w.voided_at is null
                            and coalesce(w.data->'fields'->>format('d%ss%s_leftSurf', i, s),'') <> ''
                            and coalesce(w.data->'fields'->>format('d%ss%s_totalBottom', i, s),'') = ''),
      'hazards',       (select count(*) from worksheets w join jobs j on j.id = w.job_id, generate_series(0,7) i
                          where j.region = r and w.ws_date >= since and coalesce(w.data->'fields'->>format('tb_hz_%s_hazard', i),'') <> '')
                       + (select count(*) from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and j.region = r and x.ws_date >= since and x.type = 'Near miss'),
      'edited_after_lock', (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since
                          and exists (select 1 from jsonb_array_elements(coalesce(w.data->'changeLog','[]'::jsonb)) c where c->>'action' = 'Unlocked')),
      'voided',        (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.voided_at >= since),
      'incidents',     (select count(*) from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and j.region = r and x.ws_date >= since),
      'near_misses',   (select count(*) from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and j.region = r and x.ws_date >= since and x.type = 'Near miss'),
      'fai',           (select count(*) from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and j.region = r and x.ws_date >= since and x.injury_class = 'FAI'),
      'mti',           (select count(*) from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and j.region = r and x.ws_date >= since and x.injury_class = 'MTI'),
      'lti',           (select count(*) from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and j.region = r and x.ws_date >= since and x.injury_class = 'LTI'),
      'days_since_lti',(select current_date - max(x.ws_date) from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and j.region = r and x.injury_class = 'LTI'),
      'open_investigations', (select count(*) from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and j.region = r and x.status = 'open'),
      'actions_overdue', 0,
      'spills',        (select count(*) from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and j.region = r and x.ws_date >= since and x.type like 'Environmental%'),
      'reported_24h_pct', (select coalesce(round(100.0 * count(*) filter (where x.created_at <= (x.ws_date + coalesce(x.occurred_at, time '12:00')) + interval '24 hours') / nullif(count(*),0)), 100)
                          from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and j.region = r and x.ws_date >= since),
      'items_used',    (select count(distinct e->>'item') from worksheets w join jobs j on j.id = w.job_id, jsonb_array_elements(coalesce(w.data->'equipment','[]'::jsonb)) e where j.region = r and w.ws_date >= since),
      'dive_system_days', (select count(distinct w.id) from worksheets w join jobs j on j.id = w.job_id, jsonb_array_elements(coalesce(w.data->'equipment','[]'::jsonb)) e join equipment q on q.name = e->>'item' where j.region = r and w.ws_date >= since and q.category = 'Dive system'),
      'vessel_days',   (select count(distinct w.id) from worksheets w join jobs j on j.id = w.job_id, jsonb_array_elements(coalesce(w.data->'equipment','[]'::jsonb)) e join equipment q on q.name = e->>'item' where j.region = r and w.ws_date >= since and q.category = 'Vessel'),
      'items_issues',  (select count(distinct e->>'item') from worksheets w join jobs j on j.id = w.job_id, jsonb_array_elements(coalesce(w.data->'equipment','[]'::jsonb)) e where j.region = r and w.ws_date >= since and (e->>'notes') ~* '(fault|repair|damage|service|replaced|leak)'),
      'idle_30',       (select count(*) from equipment q where q.region = r and q.active and not exists (select 1 from worksheets w join jobs j on j.id = w.job_id, jsonb_array_elements(coalesce(w.data->'equipment','[]'::jsonb)) e where j.region = r and w.ws_date >= current_date - 30 and e->>'item' = q.name)),
      'no_equipment',  (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since and w.voided_at is null and jsonb_array_length(coalesce(w.data->'equipment','[]'::jsonb)) = 0),
      'dive_min',      (select coalesce(sum((w.summary->>'bottom_min')::int),0) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since),
      'person_days',   (select coalesce(sum(jsonb_array_length(coalesce(w.data->'team','[]'::jsonb))),0) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since),
      'jobs_active',   (select count(distinct w.job_id) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since),
      'avg_crew',      (select round(avg(jsonb_array_length(coalesce(w.data->'team','[]'::jsonb))),1) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since),
      'signoff_24h_pct', (select coalesce(round(100.0 * count(*) filter (where w.locked_at <= w.created_at + interval '24 hours') / nullif(count(*) filter (where w.locked),0)), 0) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since),
      'dive_days',     (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since and w.voided_at is null and coalesce(w.data->>'divingMode','true') <> 'false'),
      'nondive_days',  (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since and w.voided_at is null and coalesce(w.data->>'divingMode','true') = 'false'),
      'dives',         (select coalesce(sum(case when w.summary->>'dives' ~ '^\d+$' then (w.summary->>'dives')::int else 0 end),0) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since and w.voided_at is null),
      'divers_used',   (select count(distinct w.data->'fields'->>format('diver_%s_name', i)) from worksheets w join jobs j on j.id = w.job_id, generate_series(0,7) i
                          where j.region = r and w.ws_date >= since and w.voided_at is null and coalesce(w.data->'fields'->>format('diver_%s_name', i),'') <> ''
                            and exists (select 1 from generate_series(0,5) s where coalesce(w.data->'fields'->>format('d%ss%s_leftSurf', i, s),'') <> '')),
      'overtime_hours',(select coalesce(round(sum(greatest(0, case when w.summary->>'paid_min' ~ '^\d+$' then (w.summary->>'paid_min')::int else 0 end - ot_std) * greatest(1, jsonb_array_length(coalesce(w.data->'team','[]'::jsonb)))) / 60.0, 1), 0)
                          from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since and w.voided_at is null),
      'over_quote_days', (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = r and w.ws_date >= since and w.voided_at is null and j.quoted_hours_per_day is not null
                          and case when w.summary->>'paid_min' ~ '^\d+$' then (w.summary->>'paid_min')::int else 0 end > j.quoted_hours_per_day * 60)
    ) into reg;
    res := res || jsonb_build_object(case when r = 'NSW' then 'east' else 'west' end, reg);
  end loop;

  res := res || jsonb_build_object(
    'as_of', now(),
    'days_since_lti', (select current_date - max(ws_date) from incidents where coalesce(status,'') <> 'withdrawn' and injury_class = 'LTI'),
    'reported_24h_pct', (select coalesce(round(100.0 * count(*) filter (where created_at <= (ws_date + coalesce(occurred_at, time '12:00')) + interval '24 hours') / nullif(count(*),0)), 100) from incidents where coalesce(status,'') <> 'withdrawn' and ws_date >= since),
    'avg_crew', (select round(avg(jsonb_array_length(coalesce(data->'team','[]'::jsonb))),1) from worksheets where ws_date >= since),
    'signoff_24h_pct', (select coalesce(round(100.0 * count(*) filter (where locked_at <= created_at + interval '24 hours') / nullif(count(*) filter (where locked),0)), 0) from worksheets where ws_date >= since),
    'incident_register', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'ws_date', x.ws_date, 'job_no', j.job_no, 'region', j.region, 'type', x.type, 'severity', x.severity, 'injury_class', x.injury_class, 'days_lost', x.days_lost, 'description', x.description, 'people', x.people, 'actions', x.actions, 'status', x.status, 'reported_by_name', x.reported_by_name, 'notifiable', x.notifiable) order by x.ws_date desc), '[]'::jsonb)
                          from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and x.ws_date >= since),
    'equipment_usage', (select coalesce(jsonb_agg(row order by row->>'days' desc), '[]'::jsonb) from (
                          select jsonb_build_object('item', e->>'item', 'category', max(q.category), 'region', j.region, 'days', count(distinct w.id), 'jobs', count(distinct w.job_id), 'last_used', max(w.ws_date),
                                 'flagged', count(*) filter (where (e->>'notes') ~* '(fault|repair|damage|service|replaced|leak)')) row
                          from worksheets w join jobs j on j.id = w.job_id, jsonb_array_elements(coalesce(w.data->'equipment','[]'::jsonb)) e left join equipment q on q.name = e->>'item'
                          where w.ws_date >= since and coalesce(e->>'item','') <> '' group by e->>'item', j.region) s),
    'open_audit', (select coalesce(jsonb_agg(jsonb_build_object('age_days', extract(epoch from now() - w.created_at)/86400, 'item', 'Unsigned day sheet', 'job_no', j.job_no, 'ws_date', w.ws_date, 'region', j.region, 'supervisor', w.supervisor) order by w.created_at), '[]'::jsonb)
                    from worksheets w join jobs j on j.id = w.job_id where w.locked = false and w.voided_at is null and w.created_at < now() - interval '48 hours'),
    'weekly', (select coalesce(jsonb_agg(jsonb_build_object('label', to_char(wk, 'DD Mon'), 'east', (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = 'NSW' and w.ws_date >= wk::date and w.ws_date < wk::date + 7), 'west', (select count(*) from worksheets w join jobs j on j.id = w.job_id where j.region = 'WA' and w.ws_date >= wk::date and w.ws_date < wk::date + 7)) order by wk), '[]'::jsonb)
               from generate_series(date_trunc('week', current_date)::date - 49, date_trunc('week', current_date)::date, interval '7 days') wk),
    'top_divers', (select coalesce(jsonb_agg(row order by (row->>'dives')::int desc, (row->>'bottom_min')::int desc), '[]'::jsonb) from (
                     select jsonb_build_object('name', x.n, 'region', j.region, 'dives', count(*), 'days', count(distinct w.id), 'jobs', count(distinct w.job_id),
                                               'bottom_min', sum(case when x.bt ~ '^\d+$' then x.bt::int else 0 end)) row
                     from worksheets w join jobs j on j.id = w.job_id, generate_series(0,7) i, generate_series(0,5) s,
                          lateral (select w.data->'fields'->>format('diver_%s_name', i) n, w.data->'fields'->>format('d%ss%s_leftSurf', i, s) ls, w.data->'fields'->>format('d%ss%s_totalBottom', i, s) bt) x
                     where w.ws_date >= since and w.voided_at is null and coalesce(x.n,'') <> '' and coalesce(x.ls,'') <> ''
                     group by x.n, j.region) t),
    'top_supervisors', (select coalesce(jsonb_agg(row order by (row->>'sheets')::int desc), '[]'::jsonb) from (
                     select jsonb_build_object('supervisor', w.supervisor, 'region', j.region, 'sheets', count(*), 'jobs', count(distinct w.job_id),
                                               'dives', coalesce(sum(case when w.summary->>'dives' ~ '^\d+$' then (w.summary->>'dives')::int else 0 end),0),
                                               'person_days', coalesce(sum(jsonb_array_length(coalesce(w.data->'team','[]'::jsonb))),0)) row
                     from worksheets w join jobs j on j.id = w.job_id where w.ws_date >= since and w.voided_at is null and w.supervisor is not null group by w.supervisor, j.region) t),
    'quote_tracking', (select coalesce(jsonb_agg(row order by (row->>'over_pct')::numeric desc nulls last), '[]'::jsonb) from (
                     select jsonb_build_object('job_no', j.job_no, 'project', j.project, 'region', j.region, 'status', j.status, 'supervisor', j.supervisor,
                                               'quoted_hours_per_day', j.quoted_hours_per_day, 'quoted_days', j.quoted_days,
                                               'days', count(w.id), 'paid_hours', round(sum(case when w.summary->>'paid_min' ~ '^\d+$' then (w.summary->>'paid_min')::int else 0 end) / 60.0, 1),
                                               'days_over', count(*) filter (where case when w.summary->>'paid_min' ~ '^\d+$' then (w.summary->>'paid_min')::int else 0 end > j.quoted_hours_per_day * 60),
                                               'quoted_total', j.quoted_hours_per_day * coalesce(j.quoted_days, count(w.id)),
                                               'over_pct', round(100.0 * sum(case when w.summary->>'paid_min' ~ '^\d+$' then (w.summary->>'paid_min')::int else 0 end) / 60.0 / nullif(j.quoted_hours_per_day * coalesce(j.quoted_days, count(w.id)), 0) - 100, 0)) row
                     from jobs j join worksheets w on w.job_id = j.id and w.voided_at is null
                     where j.quoted_hours_per_day is not null and exists (select 1 from worksheets w2 where w2.job_id = j.id and w2.ws_date >= since)
                     group by j.id) t),
    'signoff_by_supervisor', (select coalesce(jsonb_agg(jsonb_build_object('supervisor', s.supervisor, 'region', s.region, 'sheets', s.n, 'pct', s.pct)), '[]'::jsonb) from (
                     select w.supervisor, j.region, count(*) n, coalesce(round(100.0 * count(*) filter (where w.locked_at <= w.created_at + interval '24 hours') / nullif(count(*) filter (where w.locked),0)),0) pct
                     from worksheets w join jobs j on j.id = w.job_id where w.ws_date >= since and w.supervisor is not null group by w.supervisor, j.region) s),
    'drill', jsonb_build_object(
      'unsigned_48h', (select coalesce(jsonb_agg(jsonb_build_object('job', j.job_no, 'date', w.ws_date, 'supervisor', w.supervisor, 'last_edit', w.updated_by_name, 'region', j.region) order by w.created_at), '[]'::jsonb) from worksheets w join jobs j on j.id = w.job_id where w.locked = false and w.voided_at is null and w.created_at < now() - interval '48 hours'),
      'no_toolbox', (select coalesce(jsonb_agg(jsonb_build_object('job', j.job_no, 'date', w.ws_date, 'supervisor', w.supervisor, 'region', j.region) order by w.ws_date desc), '[]'::jsonb) from worksheets w join jobs j on j.id = w.job_id where w.ws_date >= since and w.voided_at is null and coalesce(w.data->'fields'->>'tb_cl_9','') = ''),
      'no_swms', (select coalesce(jsonb_agg(jsonb_build_object('job', j.job_no, 'date', w.ws_date, 'supervisor', w.supervisor, 'region', j.region) order by w.ws_date desc), '[]'::jsonb) from worksheets w join jobs j on j.id = w.job_id where w.ws_date >= since and w.voided_at is null and (w.data->'swms') is null and j.swms is null),
      'edited_after_lock', (select coalesce(jsonb_agg(jsonb_build_object('job', j.job_no, 'date', w.ws_date, 'by', c->>'by', 'reason', c->>'reason', 'at', c->>'at', 'region', j.region)), '[]'::jsonb) from worksheets w join jobs j on j.id = w.job_id, jsonb_array_elements(coalesce(w.data->'changeLog','[]'::jsonb)) c where w.ws_date >= since and c->>'action' = 'Unlocked'),
      'voided', (select coalesce(jsonb_agg(jsonb_build_object('job', j.job_no, 'date', w.ws_date, 'by', w.voided_by_name, 'reason', w.void_reason, 'region', j.region)), '[]'::jsonb) from worksheets w join jobs j on j.id = w.job_id where w.voided_at >= since),
      'open_investigations', (select coalesce(jsonb_agg(jsonb_build_object('job', j.job_no, 'date', x.ws_date, 'type', x.type, 'severity', x.severity, 'reported_by', x.reported_by_name, 'region', j.region)), '[]'::jsonb) from incidents x join jobs j on j.id = x.job_id where coalesce(x.status,'') <> 'withdrawn' and x.status = 'open'),
      'no_equipment', (select coalesce(jsonb_agg(jsonb_build_object('job', j.job_no, 'date', w.ws_date, 'supervisor', w.supervisor, 'region', j.region) order by w.ws_date desc), '[]'::jsonb) from worksheets w join jobs j on j.id = w.job_id where w.ws_date >= since and w.voided_at is null and jsonb_array_length(coalesce(w.data->'equipment','[]'::jsonb)) = 0),
      'dive_mode', (select coalesce(jsonb_agg(jsonb_build_object('job', j.job_no, 'date', w.ws_date, 'mode', case when coalesce(w.data->>'divingMode','true') = 'false' then 'Non-diving' else 'Diving' end, 'dives', coalesce(w.summary->>'dives','0'), 'supervisor', w.supervisor, 'region', j.region) order by w.ws_date desc), '[]'::jsonb)
                     from worksheets w join jobs j on j.id = w.job_id where w.ws_date >= since and w.voided_at is null),
      'running_jobs', (select coalesce(jsonb_agg(jsonb_build_object('job', j.job_no, 'project', j.project, 'client', j.client, 'supervisor', j.supervisor, 'started', j.start_date, 'region', j.region) order by j.start_date desc nulls last), '[]'::jsonb) from jobs j where j.status = 'active'),
      'overtime', (select coalesce(jsonb_agg(jsonb_build_object('job', j.job_no, 'date', w.ws_date, 'crew', greatest(1, jsonb_array_length(coalesce(w.data->'team','[]'::jsonb))), 'paid_hours', round(x.pm / 60.0, 1), 'ot_hours', round((x.pm - ot_std) * greatest(1, jsonb_array_length(coalesce(w.data->'team','[]'::jsonb))) / 60.0, 1), 'supervisor', w.supervisor, 'region', j.region) order by w.ws_date desc), '[]'::jsonb)
                     from worksheets w join jobs j on j.id = w.job_id, lateral (select case when w.summary->>'paid_min' ~ '^\d+$' then (w.summary->>'paid_min')::int else 0 end pm) x
                     where w.ws_date >= since and w.voided_at is null and x.pm > ot_std),
      'over_quote', (select coalesce(jsonb_agg(jsonb_build_object('job', j.job_no, 'date', w.ws_date, 'quoted_h_day', j.quoted_hours_per_day, 'paid_hours', round(x.pm / 60.0, 1), 'over_by_h', round((x.pm - j.quoted_hours_per_day * 60) / 60.0, 1), 'supervisor', w.supervisor, 'region', j.region) order by w.ws_date desc), '[]'::jsonb)
                     from worksheets w join jobs j on j.id = w.job_id, lateral (select case when w.summary->>'paid_min' ~ '^\d+$' then (w.summary->>'paid_min')::int else 0 end pm) x
                     where w.ws_date >= since and w.voided_at is null and j.quoted_hours_per_day is not null and x.pm > j.quoted_hours_per_day * 60)
    )
  );
  return res;
end $$;
grant execute on function public.mgmt_stats(int) to authenticated;

-- Reports bucket for the monthly PDF. Issued by the monthly-report edge function on the 1st of each month at 06:00
-- Australia/Sydney for the previous calendar month. pg_cron runs in UTC: 06:00 AEDT = 19:00 UTC on the last day of the
-- previous month (AEST = 20:00 UTC); simplest is to schedule 20:00 UTC on day 1 (07:00 AEDT / 06:00 AEST) and let the
-- function compute "previous month" from the Sydney date.
--   select cron.schedule('monthly-report', '0 20 1 * *',
--     $$ select net.http_post(url := current_setting('app.functions_url') || '/monthly-report',
--                             headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_key'), 'Content-Type', 'application/json'),
--                             body := '{}'::jsonb) $$);
insert into storage.buckets (id, name, public) values ('reports', 'reports', false) on conflict (id) do nothing;

-- Controlled documents register + review log (ISO 7.5.2, audit rule A-06). Everyone can read; managers write.
create table if not exists public.controlled_docs (
  id uuid primary key default gen_random_uuid(),
  doc_no text not null unique, title text not null, rev text, review_months int not null default 12,
  approver text, approval_date date, owner text, region text check (region in ('NSW','WA')),
  last_review date, last_review_by text, next_review date, active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.doc_reviews (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid references public.controlled_docs (id) on delete cascade,
  reviewed_at timestamptz not null default now(), reviewed_by text, outcome text check (outcome in ('no_change','revised','withdrawn')),
  new_rev text, notes text
);
alter table public.controlled_docs enable row level security;
alter table public.doc_reviews enable row level security;
drop policy if exists "docs read" on public.controlled_docs;
create policy "docs read" on public.controlled_docs for select to authenticated using (true);
drop policy if exists "docs write" on public.controlled_docs;
create policy "docs write" on public.controlled_docs for all to authenticated using (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'manager')) with check (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'manager'));
drop policy if exists "reviews read" on public.doc_reviews;
create policy "reviews read" on public.doc_reviews for select to authenticated using (true);
drop policy if exists "reviews write" on public.doc_reviews;
create policy "reviews write" on public.doc_reviews for insert to authenticated with check (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'manager'));
-- Seed the documents the worksheet depends on (edit dates to match the register)
insert into public.controlled_docs (doc_no, title, rev, review_months, approver, approval_date, owner, last_review, next_review) values
  ('OPS-FRM-014', 'Daily Worksheet (app form)', '1', 12, 'HSEQ Manager', current_date, 'HSEQ Manager', current_date, current_date + interval '12 months'),
  ('OPS-DOC-002', 'Safe Work Method Statement template', '23', 12, 'HSEQ Manager', null, 'HSEQ Manager', null, null),
  ('FUS-DIVE-TPL', 'Dive Plan template', 'A', 12, 'HSEQ Manager', null, 'Regional Manager East', null, null),
  ('HSE-REG-001', 'Legal and other requirements register', null, 6, 'HSEQ Manager', null, 'HSEQ Manager', null, null)
on conflict (doc_no) do nothing;
