-- SFR event calendar: data model in the ig-wiki Supabase project.
-- The `events` schema is NOT exposed through the Data API. Only the sync job
-- (direct database connection) and the deck-check function read or write it.

create schema if not exists events;
revoke all on schema events from public, anon, authenticated;

-- One row per event. Source is monday (Events Planung) or, for past IG meetings
-- that were never entered on monday, the wiki's meetings table.
create table events.event (
  id               bigint generated always as identity primary key,
  source           text not null check (source in ('monday', 'wiki')),
  monday_item_id   bigint unique,
  monday_group     text,
  kind             text not null check (kind in ('ig', 'sfr', 'external')),
  ig_id            integer references public.ig_groups (id),
  title_src        text not null,
  title_en         text,
  summary_src      text,
  summary_en       text,
  event_date       date,
  start_time       time,
  end_time         time,
  location         text,
  signup_url       text,
  website_status   text,
  published        boolean not null default false,
  text_hash        text,
  translated_hash  text,
  synced_at        timestamptz not null default now(),
  removed_at       timestamptz,
  check ((source = 'monday') = (monday_item_id is not null))
);
create index event_date_idx on events.event (event_date);

-- An event can cover more than one wiki meeting (joint IG meetings).
create table events.event_meeting (
  event_id    bigint  not null references events.event (id) on delete cascade,
  meeting_id  integer not null unique references public.meetings (id),
  method      text not null check (method in ('ig_date', 'wiki_only', 'manual')),
  primary key (event_id, meeting_id)
);

-- Programme slots from the monday subitems with status "Zugesagt".
create table events.session (
  monday_subitem_id  bigint primary key,
  event_id           bigint not null references events.event (id) on delete cascade,
  start_time         text,
  title_src          text not null,
  title_en           text,
  speakers           jsonb not null default '[]'::jsonb,
  consent            boolean not null default false,
  text_hash          text,
  translated_hash    text
);
create index session_event_idx on events.session (event_id);

-- Every deck the calendar can serve. IG decks point to the wiki's index;
-- decks of other events come from the SharePoint "Events" area.
create table events.deck (
  id               uuid primary key default gen_random_uuid(),
  event_id         bigint references events.event (id) on delete set null,
  source           text not null check (source in ('wiki', 'events_folder')),
  presentation_id  uuid unique references public.presentations (id),
  drive_id         text not null,
  item_id          text not null,
  filename         text,
  title            text,
  file_path        text,
  in_web_folder    boolean not null,
  is_programme     boolean not null default false,
  removed_at       timestamptz,
  unique (drive_id, item_id)
);
create index deck_event_idx on events.deck (event_id);

-- Groups on the monday "Events attendees" board and the event each belongs to.
-- Rows with match_method = 'manual' or 'excluded' are never overwritten by the sync.
create table events.attendee_group (
  monday_group_id  text primary key,
  title            text not null,
  group_date       date,
  event_id         bigint references events.event (id) on delete set null,
  match_method     text not null default 'none'
                   check (match_method in ('date', 'date_name', 'manual', 'excluded', 'none')),
  match_note       text,
  reviewed         boolean not null default false,
  synced_at        timestamptz not null default now()
);

-- One row per registration. Cancellations and no-shows get no access.
create table events.attendee (
  monday_item_id  bigint primary key,
  group_id        text not null references events.attendee_group (monday_group_id) on delete cascade,
  email           text,
  status_raw      text,
  has_access      boolean generated always as (
                    lower(regexp_replace(coalesce(status_raw, ''), '[^A-Za-z]', '', 'g'))
                    not in ('notattending', 'excused', 'noshow')
                  ) stored,
  synced_at       timestamptz not null default now()
);
create index attendee_email_idx on events.attendee (lower(email));

create table events.download_log (
  id          bigint generated always as identity primary key,
  deck_id     uuid references events.deck (id) on delete set null,
  email       text not null,
  granted     boolean not null,
  reason      text,
  created_at  timestamptz not null default now()
);

create table events.sync_run (
  id           bigint generated always as identity primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  mode         text,
  ok           boolean,
  summary      jsonb,
  error        text
);

-- RLS on everywhere, no policies: nothing is readable through the API even if
-- the schema were exposed by mistake.
alter table events.event          enable row level security;
alter table events.event_meeting  enable row level security;
alter table events.session        enable row level security;
alter table events.deck           enable row level security;
alter table events.attendee_group enable row level security;
alter table events.attendee       enable row level security;
alter table events.download_log   enable row level security;
alter table events.sync_run       enable row level security;

-- Access rules ---------------------------------------------------------------

-- Current member: exact email domain of a member with status active or foundations.
-- No exceptions for freemail addresses.
create or replace function events.is_member_email(p_email text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.crm_members m
    where m.status in ('active', 'foundations - no voting rights')
      and m.domain is not null
      and lower(m.domain) = lower(split_part(p_email, '@', 2))
  );
$$;

create or replace function events.is_staff_email(p_email text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.staff s
    where s.active and lower(s.email) = lower(p_email)
  );
$$;

-- Why may this email open this deck? Returns null if it may not.
create or replace function events.access_reason(p_email text, p_deck uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when d.id is null or d.removed_at is not null or not d.in_web_folder then null
    when events.is_staff_email(p_email) then 'staff'
    when events.is_member_email(p_email) then 'member'
    when exists (
      select 1
      from events.attendee a
      join events.attendee_group g on g.monday_group_id = a.group_id
      where g.event_id = d.event_id
        and d.event_id is not null
        and lower(a.email) = lower(p_email)
        and a.has_access
    ) then 'participant'
    else null
  end
  from (select 1) one
  left join events.deck d on d.id = p_deck;
$$;

create or replace function events.can_open(p_email text, p_deck uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select events.access_reason(p_email, p_deck) is not null; $$;

-- May this email create an account at all? Used by the sign-up check in phase 2.
create or replace function events.may_sign_up(p_email text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select events.is_staff_email(p_email)
      or events.is_member_email(p_email)
      or exists (select 1 from events.attendee a where lower(a.email) = lower(p_email) and a.has_access);
$$;

revoke all on all functions in schema events from public, anon, authenticated;
