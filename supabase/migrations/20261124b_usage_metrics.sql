-- Usage counting on the SFR hub: cookieless, no IP address, no email, no visitor id.
-- One row per counted action. Written only by the edge function "metric" (service connection);
-- read only by the edge function "stats" for signed-in staff. Rows older than 13 months are
-- deleted every night, and the presentation-access log gets the same limit.

create table if not exists events.metric (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  kind      text not null check (kind in ('view', 'register', 'ad_view', 'ad_click', 'mail_click',
                                           'search', 'filter', 'kn_topic', 'kn_search', 'kn_finder')),
  page      text not null check (length(page) <= 160),        -- path on the hub, e.g. /events/<slug>/
  ref       text check (length(ref) <= 120),                  -- event slug, ad key, group, search term, topic
  role      text not null check (role in ('visitor', 'participant', 'member', 'staff')),
  source    text check (length(source) <= 100),               -- referring website, domain only
  mobile    boolean not null default false
);
create index if not exists metric_at_idx on events.metric (at);
create index if not exists metric_kind_at_idx on events.metric (kind, at);
alter table events.metric enable row level security;
revoke all on events.metric from public, anon, authenticated;

create or replace function events.purge_old_usage()
returns void language sql security definer set search_path = '' as $$
  delete from events.metric where at < now() - interval '13 months';
  delete from events.download_log where created_at < now() - interval '13 months';
$$;
revoke all on function events.purge_old_usage() from public, anon, authenticated;

-- nightly purge (pg_cron exists on Supabase, not in the test database)
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule('sfr-hub-usage-purge') where exists (select 1 from cron.job where jobname = 'sfr-hub-usage-purge');
    perform cron.schedule('sfr-hub-usage-purge', '41 2 * * *', 'select events.purge_old_usage()');
  end if;
end $$;
