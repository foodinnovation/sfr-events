-- The page build (role events_job) matches registrations to members for the logo block on
-- upcoming event pages. It needs the member names and domains, nothing else.
grant select (item_id, name, domain, status) on public.crm_members to events_job;
drop policy if exists events_job_read_members on public.crm_members;
create policy events_job_read_members on public.crm_members for select to events_job using (true);
