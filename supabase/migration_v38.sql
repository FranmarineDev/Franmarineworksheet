-- Daily Worksheet v3.8 — a named diver with no logged dive is not a dive.
-- Diver names carry over from the previous day, so a slot can hold a name for someone who didn't dive.
-- The app no longer writes those into worksheets.summary->'divers'; this keeps the view honest for any old rows too.
create or replace view public.diver_hours as
select j.job_no, j.project, w.ws_date, w.locked,
       d->>'name'                 as diver,
       (d->>'dives')::int         as dives,
       (d->>'bottom_min')::int    as bottom_min,
       (d->>'dive_min')::int      as dive_min,
       (d->>'max_depth')::numeric as max_depth_m
from public.worksheets w
join public.jobs j on j.id = w.job_id
cross join lateral jsonb_array_elements(coalesce(w.summary->'divers', '[]'::jsonb)) d
where coalesce((d->>'dives')::int, 0) > 0;
alter view public.diver_hours set (security_invoker = on);

-- One-off clean-up of summaries saved before the fix (14 entries on 8 sheets when first run, 14 Nov 2026)
update public.worksheets w
set summary = jsonb_set(w.summary, '{divers}', (select coalesce(jsonb_agg(d order by o), '[]'::jsonb)
  from jsonb_array_elements(w.summary->'divers') with ordinality x(d, o) where coalesce((d->>'dives')::int, 0) > 0))
where exists (select 1 from jsonb_array_elements(coalesce(w.summary->'divers', '[]'::jsonb)) d where coalesce((d->>'dives')::int, 0) = 0);
