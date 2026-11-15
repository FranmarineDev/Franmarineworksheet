-- Daily Worksheet v4.0 — open sign-up with manager approval (15 Nov 2026)
-- Self sign-ups become GUESTS: no region, no access to jobs, sheets, files, crew, equipment, documents or other users.
-- Every manager is emailed (edge function notify-new-signup) once the sign-up's email address is confirmed.
-- A manager approves under Manage → Users → Awaiting approval by setting role + region, or rejects (remove-user).
-- Invited people are unaffected: they still start as supervisors and the invite sets their role/region.
-- Supabase settings this relies on: Authentication → Sign In / Providers → "Allow new users to sign up" ON,
-- and Email → "Confirm email" ON (so a sign-up has to prove they own the address before anyone is notified).

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('manager', 'supervisor', 'guest'));
alter table public.profiles alter column region drop not null;   -- guests have no region until approved
alter table public.profiles add column if not exists signup_notified_at timestamptz;

create or replace function public.is_guest()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'guest' from public.profiles where id = auth.uid()), true);   -- no profile = no access
$$;
revoke execute on function public.is_guest() from public, anon;
grant execute on function public.is_guest() to authenticated;

-- Ask the edge function to email the managers (fire-and-forget; a failure never blocks the sign-up)
create or replace function public.notify_new_signup(uid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://anecqzkjxxgwfshckqjd.supabase.co/functions/v1/notify-new-signup',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('user_id', uid));
exception when others then
  raise warning 'notify_new_signup failed: %', sqlerrm;
end $$;
revoke execute on function public.notify_new_signup(uuid) from public, anon, authenticated;

-- New auth user → profile. Invited (or the very first account) = supervisor in NSW as before; anyone else = guest.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare first_user boolean := (select count(*) from public.profiles) = 0;
        invited boolean := new.invited_at is not null;
begin
  insert into public.profiles (id, email, full_name, role, region)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
          case when first_user then 'manager' when invited then 'supervisor' else 'guest' end,
          case when first_user or invited then 'NSW' else null end)
  on conflict (id) do nothing;
  if not first_user and not invited and new.email_confirmed_at is not null then
    perform public.notify_new_signup(new.id);   -- email confirmation is off: announce straight away
  end if;
  return new;
end $$;

-- Email confirmation is on: announce when the address is confirmed
create or replace function public.handle_user_confirmed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null
     and exists (select 1 from public.profiles where id = new.id and role = 'guest' and signup_notified_at is null) then
    perform public.notify_new_signup(new.id);
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row execute function public.handle_user_confirmed();

-- Guests see only their own profile and no controlled documents
drop policy if exists "profiles: read all" on public.profiles;
create policy "profiles: read all" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or not public.is_guest());
drop policy if exists "docs read" on public.controlled_docs;
create policy "docs read" on public.controlled_docs for select to authenticated using (not public.is_guest());
drop policy if exists "reviews read" on public.doc_reviews;
create policy "reviews read" on public.doc_reviews for select to authenticated using (not public.is_guest());

-- Any manager can approve a guest (guests have no region yet); otherwise managers edit people in their own region
drop policy if exists "profiles: managers edit" on public.profiles;
create policy "profiles: managers edit" on public.profiles for update to authenticated
  using (public.is_manager() and (public.can_see_region(region) or role = 'guest'))
  with check (public.is_manager());

-- v40b (applied by hand in the SQL editor, 15 Nov): the old "edit own" check looked up profiles from inside a
-- profiles policy, which became infinite recursion once the read policy changed. Role/region/Management View
-- are already pinned by the guard_profile_update trigger (v39), so the check only needs to confirm it's your row.
drop policy if exists "profiles: edit own" on public.profiles;
create policy "profiles: edit own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
