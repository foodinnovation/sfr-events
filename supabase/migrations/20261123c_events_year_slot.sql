-- Undated wiki meetings: link by year and slot (T1 = first IG meeting of the year on
-- monday, T2 = second), or show them as year-only archive events.

alter table events.event add column if not exists event_year integer;
update events.event set event_year = extract(year from event_date)::int
 where event_date is not null and event_year is null;
create index if not exists event_year_idx on events.event (event_year);

alter table events.event_meeting drop constraint if exists event_meeting_method_check;
alter table events.event_meeting add constraint event_meeting_method_check
  check (method in ('ig_date', 'ig_slot', 'wiki_only', 'wiki_year', 'manual'));
