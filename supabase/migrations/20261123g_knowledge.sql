-- Radicle – Knowledge: a members-only copy of radicle's topic wiki, relevant projects and
-- research gaps, plus funding instruments from the monday board "Funding Schemes".
-- Filled by the sync job (role events_job); read only by the knowledge edge function.
-- Nothing here is exposed through the Data API: RLS is on and there are no visitor policies.

create schema if not exists knowledge;
revoke all on schema knowledge from public;
grant usage on schema knowledge to events_job;

create table if not exists knowledge.article (
  topic_slug      text primary key,
  topic_label     text,
  parent_topic    text,
  title           text not null,
  body_markdown   text not null,
  key_findings    jsonb not null default '[]',
  related_topics  jsonb not null default '[]',
  active_projects jsonb not null default '[]',
  completed_projects jsonb not null default '[]',
  funding_trend   text,
  last_compiled   text,
  synced_at       timestamptz not null default now(),
  fts tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(topic_label, '') || ' ' || coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body_markdown, '')), 'C')) stored
);
create index if not exists article_fts on knowledge.article using gin (fts);

create table if not exists knowledge.project (
  id            text primary key,           -- radicle id, e.g. 'snf:211325'
  source        text not null,              -- aramis | snf | regiosuisse
  title         text not null,
  summary       text,
  topics        jsonb not null default '[]',
  trl           int,
  funder        text,
  start_date    text,
  end_date      text,
  status        text,
  budget_chf    numeric,
  institution   text,
  lead          text,
  partners      text,
  source_url    text,
  synced_at     timestamptz not null default now(),
  fts tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(institution, '') || ' ' || coalesce(lead, '')), 'D')) stored
);
create index if not exists project_fts on knowledge.project using gin (fts);

create table if not exists knowledge.gap (
  spot_id        text primary key,
  topic_slug     text,
  description    text not null,
  severity       int,
  cost_range_chf text,
  evidence_block text,
  synced_at      timestamptz not null default now(),
  fts tsvector generated always as (
    setweight(to_tsvector('english', coalesce(description, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(evidence_block, '')), 'C')) stored
);
create index if not exists gap_fts on knowledge.gap using gin (fts);

create table if not exists knowledge.instrument (
  id              text primary key,         -- monday item id on Funding Schemes (1737639790)
  name            text not null,
  funder          text,
  stage           text,
  link            text,
  max_funding_chf text,
  project_topic   text,
  impact_area     text,
  location        text,
  active_2026     boolean not null default false,
  synced_at       timestamptz not null default now(),
  fts tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(project_topic, '')), 'B')) stored
);
create index if not exists instrument_fts on knowledge.instrument using gin (fts);

-- Who to talk to: routing by topic slug and keyword. Deliberately no email addresses;
-- the page links to the SFR coaching page to book a meeting.
create table if not exists knowledge.contact (
  key       text primary key,
  name      text not null,
  role      text,
  topics    text[] not null default '{}',
  keywords  text[] not null default '{}',
  fallback  boolean not null default false
);

alter table knowledge.article    enable row level security;
alter table knowledge.project    enable row level security;
alter table knowledge.gap        enable row level security;
alter table knowledge.instrument enable row level security;
alter table knowledge.contact    enable row level security;

grant select, insert, update, delete on all tables in schema knowledge to events_job;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'knowledge' and policyname = 'events_job_all') then
    create policy events_job_all on knowledge.article    for all to events_job using (true) with check (true);
    create policy events_job_all on knowledge.project    for all to events_job using (true) with check (true);
    create policy events_job_all on knowledge.gap        for all to events_job using (true) with check (true);
    create policy events_job_all on knowledge.instrument for all to events_job using (true) with check (true);
    create policy events_job_all on knowledge.contact    for all to events_job using (true) with check (true);
  end if;
end $$;

-- Members and staff only. Event participants (who may open their decks) do not get this tab.
create or replace function knowledge.can_read(p_email text)
returns boolean
language sql stable security definer
set search_path = events, knowledge, pg_temp
as $$ select coalesce(events.is_member_email(p_email), false) or coalesce(events.is_staff_email(p_email), false) $$;
revoke all on function knowledge.can_read(text) from public;
