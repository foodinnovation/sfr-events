-- Participant lists (names and contact details of attendees) are never served, even when
-- they sit in a "web" folder. The wiki classifies each deck (presentations.doc_type).

alter table events.deck add column if not exists doc_type text;
update events.deck d set doc_type = p.doc_type
  from public.presentations p where p.id = d.presentation_id and d.doc_type is distinct from p.doc_type;

-- Event URL slug: assigned once by the page build, never changed, so shared links keep working.
alter table events.event add column if not exists slug text unique;

create or replace function events.access_reason(p_email text, p_deck uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when d.id is null or d.removed_at is not null or not d.in_web_folder
         or coalesce(d.doc_type, '') = 'participant_list' then null
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
revoke all on function events.access_reason(text, uuid) from public, anon, authenticated;
