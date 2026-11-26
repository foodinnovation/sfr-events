-- Funding Finder: the Funding Schemes board now records, per programme, whether it runs in the check
-- year (yes / likely / no / unclear, verified 26 Nov 2026), the call dates, the deadline and funding
-- type, and the day it was last verified. The finder and the Radicle connector show these.
-- 'active' replaces 'active_2026'; active_2026 stays as a read-only copy for older readers.
alter table knowledge.instrument
  add column if not exists status        text,      -- yes | likely | no | unclear (column 'Active in check year')
  add column if not exists check_year    int,       -- from that column's description ('Check year 2027 ...')
  add column if not exists active        boolean not null default false,   -- status yes or likely, call not closed
  add column if not exists funding_type  text,
  add column if not exists deadline_type text,
  add column if not exists opens_on      date,
  add column if not exists deadline      date,
  add column if not exists verified_on   date;

do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'knowledge' and table_name = 'instrument'
             and column_name = 'active_2026' and is_generated = 'NEVER') then
    update knowledge.instrument set active = active_2026, status = case when active_2026 then 'yes' end;
    alter table knowledge.instrument drop column active_2026;
    alter table knowledge.instrument add column active_2026 boolean generated always as (active) stored;
  end if;
end $$;
