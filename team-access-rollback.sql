-- Undo team-access-migration.sql: restores the clients policies exactly as they
-- were before it ran (snapshot taken 2026-10-16 from pg_policies), and removes
-- team access. Run in the Supabase SQL editor only if you want to go back.

begin;

drop policy if exists "clients: coach or team can read" on public.clients;
drop policy if exists "clients: coach or team can add"  on public.clients;
drop policy if exists "clients: coach or team can edit" on public.clients;
drop policy if exists "clients: only coach can delete"  on public.clients;

create policy clients_select_own on public.clients for select to public using (coach_id = auth.uid());
create policy clients_insert_own on public.clients for insert to public with check (coach_id = auth.uid());
create policy clients_update_own on public.clients for update to public using (coach_id = auth.uid()) with check (coach_id = auth.uid());
create policy clients_delete_own on public.clients for delete to public using (coach_id = auth.uid());

drop function if exists public.can_access_coach(uuid);
drop table if exists public.coach_members;

commit;
