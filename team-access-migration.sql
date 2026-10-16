-- Team access for Client Pulse: let a team member (e.g. a VA) sign in with
-- their own account and work on the coach's clients.
-- Run once in the Supabase SQL editor against the Client Pulse project.
--
-- ORDER: deploy the app version that reads coach_members first. It also works
-- before this runs (no table yet → everyone is treated as a solo coach).
--
-- What it does:
--   1. coach_members table: one row per team member → the coach they work for.
--      Only you (SQL editor) can add or remove rows; nobody can grant themselves access.
--   2. can_access_coach(): true for the coach themselves and their team members.
--   3. Replaces every existing policy on public.clients with:
--        select / insert / update → coach or team member
--        delete                   → coach only (the app never deletes; archive instead)
--      Anonymous (logged-out) requests still see zero rows.
--
-- Runs as one transaction: if anything fails, nothing changes.

begin;

-- 1. Membership ----------------------------------------------------------------
create table if not exists public.coach_members (
  member_id  uuid primary key references auth.users (id) on delete cascade,
  coach_id   uuid not null    references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  check (member_id <> coach_id)
);

alter table public.coach_members enable row level security;

drop policy if exists "coach_members: member reads own row" on public.coach_members;
create policy "coach_members: member reads own row" on public.coach_members
  for select to authenticated using (member_id = auth.uid());

drop policy if exists "coach_members: coach reads own team" on public.coach_members;
create policy "coach_members: coach reads own team" on public.coach_members
  for select to authenticated using (coach_id = auth.uid());
-- No insert/update/delete policies on purpose: membership is managed here only.

-- 2. Access check ----------------------------------------------------------------
-- security definer so the check doesn't depend on coach_members' own RLS.
create or replace function public.can_access_coach(target uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select target = auth.uid()
      or exists (
        select 1 from public.coach_members m
        where m.member_id = auth.uid() and m.coach_id = target
      );
$$;

revoke all on function public.can_access_coach(uuid) from public, anon;
grant execute on function public.can_access_coach(uuid) to authenticated;

-- 3. Client policies ---------------------------------------------------------------
alter table public.clients enable row level security;

-- Drop whatever policies exist today (names aren't recorded in the repo).
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'clients' loop
    execute format('drop policy %I on public.clients', p.policyname);
  end loop;
end $$;

create policy "clients: coach or team can read" on public.clients
  for select to authenticated using (public.can_access_coach(coach_id));

create policy "clients: coach or team can add" on public.clients
  for insert to authenticated with check (public.can_access_coach(coach_id));

create policy "clients: coach or team can edit" on public.clients
  for update to authenticated
  using (public.can_access_coach(coach_id))
  with check (public.can_access_coach(coach_id));

create policy "clients: only coach can delete" on public.clients
  for delete to authenticated using (coach_id = auth.uid());

commit;

-- Check the result:
-- select tablename, policyname, cmd from pg_policies where tablename in ('clients', 'coach_members');


-- ── Managing your team (run separately, any time) ────────────────────────────
--
-- Give the VA access — after they've clicked "Create Account" on
-- pulse.whytbelt.com and confirmed their email:
--
--   insert into public.coach_members (member_id, coach_id)
--   select va.id, coach.id
--   from auth.users va, auth.users coach
--   where va.email = 'VA_EMAIL_HERE' and coach.email = 'YOUR_EMAIL_HERE';
--
-- See who has access:
--
--   select u.email, m.created_at
--   from public.coach_members m join auth.users u on u.id = m.member_id
--   where m.coach_id = (select id from auth.users where email = 'YOUR_EMAIL_HERE');
--
-- Remove the VA's access (immediate: their open tab can no longer load or
-- save — saves show "Could not save" — and a reload shows an empty dashboard):
--
--   delete from public.coach_members
--   where member_id = (select id from auth.users where email = 'VA_EMAIL_HERE');
