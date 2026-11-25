-- Member access never via a free email domain (25.11.2026). A member counts by the exact email
-- domain in the Mitglieder board (column "Email Domain", else the website), mirrored weekly into
-- public.crm_members. If someone ever types a gmail.com or bluewin.ch address there, everyone with
-- such an address would pass as a member. This list makes that impossible.
-- Participants are not affected: they get their event's slides through their exact registered
-- address (events.attendee), whatever the domain.

create table if not exists events.free_mail_domain (domain text primary key check (domain = lower(domain)));
alter table events.free_mail_domain enable row level security;
revoke all on events.free_mail_domain from public, anon, authenticated;

insert into events.free_mail_domain (domain) values
  -- international
  ('gmail.com'), ('googlemail.com'), ('outlook.com'), ('hotmail.com'), ('live.com'), ('msn.com'),
  ('yahoo.com'), ('ymail.com'), ('icloud.com'), ('me.com'), ('mac.com'), ('aol.com'), ('mail.com'),
  ('protonmail.com'), ('protonmail.ch'), ('proton.me'), ('pm.me'), ('tutanota.com'), ('tuta.io'),
  ('zoho.com'), ('yandex.com'), ('yandex.ru'), ('fastmail.com'), ('hey.com'), ('gmx.com'),
  -- Switzerland
  ('bluewin.ch'), ('sunrise.ch'), ('hispeed.ch'), ('swissonline.ch'), ('gmx.ch'), ('hotmail.ch'),
  ('outlook.ch'), ('yahoo.ch'), ('bluemail.ch'), ('green.ch'), ('quickline.ch'), ('vtxnet.ch'),
  ('netplus.ch'), ('swissmail.org'), ('ik.me'), ('ikmail.com'), ('kfnmail.ch'),
  -- Germany, Austria
  ('gmx.de'), ('gmx.net'), ('gmx.at'), ('web.de'), ('t-online.de'), ('freenet.de'), ('posteo.de'),
  ('posteo.net'), ('mailbox.org'), ('hotmail.de'), ('outlook.de'), ('yahoo.de'), ('live.de'), ('aon.at'),
  -- France, Italy
  ('orange.fr'), ('free.fr'), ('wanadoo.fr'), ('sfr.fr'), ('laposte.net'), ('hotmail.fr'), ('outlook.fr'),
  ('yahoo.fr'), ('live.fr'), ('gmx.fr'), ('libero.it'), ('tiscali.it'), ('hotmail.it'), ('outlook.it'),
  ('yahoo.it'), ('virgilio.it'), ('alice.it')
on conflict do nothing;

create or replace function events.is_member_email(p_email text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.crm_members m
    where m.status in ('active', 'foundations - no voting rights')
      and m.domain is not null
      and lower(m.domain) = lower(split_part(p_email, '@', 2))
      and not exists (select 1 from events.free_mail_domain f where f.domain = lower(m.domain))
  );
$$;
revoke all on function events.is_member_email(text) from public, anon, authenticated;
