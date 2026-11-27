-- v43: managers can opt out of the daily close-out emails (applied 27 Nov 2026)
-- send-closeout-report (v13) leaves profiles with closeout_emails = false off the To and CC lists.
alter table public.profiles add column if not exists closeout_emails boolean not null default true;
comment on column public.profiles.closeout_emails is 'false = manager does not receive the daily close-out emails';
update public.profiles set closeout_emails = false where email = 'alana.owers@franmarine.com.au';
