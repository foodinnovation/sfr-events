-- Least-privilege login role for the GitHub sync job (replaces events_sync, whose
-- password got stuck in the pooler cache; events_sync is set to nologin).
-- It can read the four wiki tables it needs and read/write the events schema. Nothing else.
-- The password is set once by an admin in the Supabase SQL editor:
--   alter role events_job with login password '<new password>';

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'events_job') then
    create role events_job nologin noinherit;
  end if;
end $$;

grant usage on schema events to events_job;
grant select, insert, update, delete on all tables in schema events to events_job;
grant usage, select on all sequences in schema events to events_job;

grant usage on schema public to events_job;
grant select on public.meetings, public.ig_groups, public.presentations to events_job;

-- RLS: explicit policies for this role only.
do $$
declare t text;
begin
  foreach t in array array['event','event_meeting','session','deck','attendee_group','attendee','download_log','sync_run'] loop
    execute format('drop policy if exists events_job_all on events.%I', t);
    execute format('create policy events_job_all on events.%I for all to events_job using (true) with check (true)', t);
  end loop;
  foreach t in array array['meetings','ig_groups','presentations'] loop
    execute format('drop policy if exists events_job_read on public.%I', t);
    execute format('create policy events_job_read on public.%I for select to events_job using (true)', t);
  end loop;
end $$;
do $$ begin if exists (select 1 from pg_roles where rolname = 'events_sync') then alter role events_sync nologin; end if; end $$;
