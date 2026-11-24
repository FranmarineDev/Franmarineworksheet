-- Daily Worksheet v4.2 — per-job switch for printing the SWMS pages in every day sheet PDF (24 Nov 2026)
-- On (default, as before): each day sheet PDF reproduces the SWMS pages.
-- Off: day sheets keep the SWMS sign-off and signatures only; the worksheet package adds the SWMS pages once at the end.
alter table public.jobs add column if not exists swms_pages_daily boolean not null default true;
