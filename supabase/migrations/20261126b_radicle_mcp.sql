-- Radicle connector (26.11.2026): members plug Radicle into Claude, ChatGPT or any MCP client.
-- The edge function radicle-mcp signs people in through the hub login and calls knowledge.mcp_take
-- before every tool call: it checks access, enforces the daily cap and logs the call.
-- The log is per person (email, organisation domain, tool, time); the privacy page says so.
-- Rows older than 13 months are deleted with the other usage data (events.purge_old_usage).

create table if not exists knowledge.mcp_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  email text not null,
  domain text not null,
  tool text not null,
  ok boolean not null default true,
  error text
);
create index if not exists mcp_log_email_at on knowledge.mcp_log (email, at desc);
create index if not exists mcp_log_at on knowledge.mcp_log (at);
alter table knowledge.mcp_log enable row level security;   -- no policies: only the service role reads it
revoke all on knowledge.mcp_log from anon, authenticated;

-- One call: returns 'ok', 'no_access' or 'limit'. Counts per Zurich calendar day.
-- Sign-in and token renewal are logged with tool '_sign_in' / '_refresh' and do not count towards the cap.
create or replace function knowledge.mcp_take(p_email text, p_tool text, p_cap int default 200)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  e text := lower(trim(p_email));
  used int;
begin
  if e = '' or not knowledge.can_read(e) then
    insert into knowledge.mcp_log (email, domain, tool, ok, error)
    values (coalesce(nullif(e, ''), '?'), split_part(e, '@', 2), p_tool, false, 'no_access');
    return 'no_access';
  end if;
  if left(p_tool, 1) <> '_' then
    select count(*) into used from knowledge.mcp_log
    where email = e and ok and left(tool, 1) <> '_'
      and at >= (date_trunc('day', now() at time zone 'Europe/Zurich') at time zone 'Europe/Zurich');
    if used >= p_cap then
      insert into knowledge.mcp_log (email, domain, tool, ok, error) values (e, split_part(e, '@', 2), p_tool, false, 'limit');
      return 'limit';
    end if;
  end if;
  insert into knowledge.mcp_log (email, domain, tool) values (e, split_part(e, '@', 2), p_tool);
  return 'ok';
end $$;
revoke all on function knowledge.mcp_take(text, text, int) from public, anon, authenticated;

-- 13-month retention, together with the hub's other usage data
create or replace function events.purge_old_usage()
returns void
language sql
security definer
set search_path to ''
as $$
  delete from events.metric where at < now() - interval '13 months';
  delete from events.download_log where created_at < now() - interval '13 months';
  delete from knowledge.mcp_log where at < now() - interval '13 months';
$$;
