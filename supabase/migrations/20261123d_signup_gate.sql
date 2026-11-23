-- Account gate for the ig-wiki project's sign-in (Supabase Auth "Before User Created" hook).
-- Only staff, current members (exact email domain) and registered participants may create
-- an account. Applies to email links and to "Sign in with Microsoft" alike.

create or replace function public.events_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(coalesce(event->'user'->>'email', ''));
begin
  if v_email <> '' and events.may_sign_up(v_email) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This address has no access to Swiss Food Research presentations. '
            || 'Members sign in with their work address; participants with the address they registered with.'));
end;
$$;

revoke execute on function public.events_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.events_before_user_created(jsonb) to supabase_auth_admin;
