-- Least-privilege login role for the GitHub sync job.
-- It can read the four wiki tables it needs and read/write the events schema. Nothing else.
-- The password is set once by an admin in the Supabase SQL editor:
--   alter role events_sync with login password '<new password>';

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'events_sync') then
    create role events_sync nologin noinherit;
  end if;
end $$;

grant usage on schema events to events_sync;
grant select, insert, update, delete on all tables in schema events to events_sync;
grant usage, select on all sequences in schema events to events_sync;

grant usage on schema public to events_sync;
grant select on public.meetings, public.ig_groups, public.presentations to events_sync;

-- RLS: explicit policies for this role only.
do $$
declare t text;
begin
  foreach t in array array['event','event_meeting','session','deck','attendee_group','attendee','download_log','sync_run'] loop
    execute format('drop policy if exists events_sync_all on events.%I', t);
    execute format('create policy events_sync_all on events.%I for all to events_sync using (true) with check (true)', t);
  end loop;
  foreach t in array array['meetings','ig_groups','presentations'] loop
    execute format('drop policy if exists events_sync_read on public.%I', t);
    execute format('create policy events_sync_read on public.%I for select to events_sync using (true)', t);
  end loop;
end $$;
