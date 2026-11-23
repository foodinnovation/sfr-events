-- Log and throttle for the sync trigger (supabase/functions/sync-trigger).
-- monday calls the trigger on every change to Events Planung; Supabase's scheduler calls it every
-- 30 minutes. claim_dispatch lets at most one dispatch per workflow through within min_gap, so a
-- burst of monday edits starts one sync, not twenty.

create table if not exists events.trigger_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  source    text not null,              -- monday | cron | manual
  workflow  text not null,              -- sync | health
  item_id   bigint,                     -- monday item, when known
  dispatched boolean not null,
  status    int,                        -- GitHub's HTTP status
  note      text
);
create index if not exists trigger_log_at on events.trigger_log (workflow, at desc);
alter table events.trigger_log enable row level security;

create or replace function events.claim_dispatch(p_workflow text, p_min_gap interval)
returns boolean
language plpgsql
security definer
set search_path = events, pg_temp
as $$
declare last timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('events.claim_dispatch:' || p_workflow));
  select max(at) into last from events.trigger_log where workflow = p_workflow and dispatched;
  if last is not null and last > now() - p_min_gap then
    return false;
  end if;
  insert into events.trigger_log (source, workflow, dispatched, note) values ('claim', p_workflow, true, 'claimed');
  return true;
end $$;
revoke all on function events.claim_dispatch(text, interval) from public, anon, authenticated;

-- The trigger function deletes entries older than 60 days, so the log stays small.
