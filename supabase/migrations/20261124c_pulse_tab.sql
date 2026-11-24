-- Pulse tab of the SFR hub: what the hub may show from schema "pulse" (filled by foodinnovation/sfr-pulse),
-- member votes, and the switch that keeps the tab staff-only until it is opened.
-- Read and written only through the edge function "pulse" (database owner); no direct API access.

create table if not exists pulse.vote (
  item_id text not null,          -- the story's anchor item (its earliest item); item ids never change
  email   text not null,
  at      timestamptz not null default now(),
  primary key (item_id, email)
);
alter table pulse.vote enable row level security;

create table if not exists pulse.setting (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table pulse.setting enable row level security;
insert into pulse.setting (key, value) values ('public', 'false') on conflict (key) do nothing;

-- An item the hub may show: relevant, with a clean link (no newsletter click-tracker, no mailbox address)
-- and from an open source or a newsletter whose sender is allowed.
create or replace function pulse.hub_showable(p_relevance int, p_url text, p_origin text, p_inbox_allowed boolean)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_relevance, 0) >= 4
     and p_url is not null and p_url ~* '^https?://'
     and p_url !~* '(%40|@|/click/|piano\.io|ccsend\.com|list-manage\.com|mailchi\.mp|adnz\.co|sendgrid|/redirect|/track)'
     and (p_origin = 'open' or coalesce(p_inbox_allowed, false))
$$;

-- Stories for the hub, newest first within relevance. A story's public id is the first 16 hex of md5(anchor item id),
-- so mailbox message ids never appear in links. p_item: only the story holding the item with that public id.
create or replace function pulse.hub_stories(p_days int, p_email text default null, p_item text default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  with raw as (
    -- newsletter items: only those whose link was resolved and checked; then the article's own title and address
    select i.*, case when i.origin = 'inbox' then n.link_resolved else i.url end eff_url,
           case when i.origin = 'inbox' then n.link_title else i.title end eff_title
    from pulse.items i
    left join public.news_items n on i.origin = 'inbox' and n.id::text = i.news_item_id::text
    where i.origin = 'open' or n.link_status = 'verified'
  ),
  it as (
    select i.id, coalesce(i.story_id, i.id) sk, i.origin, i.source_id, i.eff_url url, i.eff_title title, i.lang,
           i.published_at, i.relevance, i.igs, i.scope, i.summary_en,
           coalesce(s.name, regexp_replace(coalesce(i.source_id, ''), '^www\.', '')) source_name
    from raw i left join pulse.sources s on s.id = i.source_id
    where pulse.hub_showable(i.relevance, i.eff_url, i.origin, i.inbox_allowed)
      and i.published_at <= now() + interval '1 day'
      and (p_item is not null or i.published_at >= now() - make_interval(days => greatest(1, least(p_days, 60))))
      and (p_item is null or coalesce(i.story_id, i.id) = (select coalesce(x.story_id, x.id) from pulse.items x where left(md5(x.id), 16) = p_item limit 1))
  ),
  st as (
    select sk,
      (array_agg(id order by published_at, id))[1] anchor,
      max(relevance) rel,
      min(published_at) first_at,
      (array_agg(title order by relevance desc, (origin = 'open') desc, published_at))[1] title,
      (array_agg(url order by relevance desc, (origin = 'open') desc, published_at))[1] url,
      (array_agg(lang order by relevance desc, (origin = 'open') desc, published_at))[1] lang,
      (array_agg(source_name order by relevance desc, (origin = 'open') desc, published_at))[1] source,
      (array_agg(summary_en order by relevance desc, length(coalesce(summary_en, '')) desc))[1] summary,
      (array_agg(scope order by relevance desc))[1] scope,
      array_agg(id) ids,
      jsonb_agg(jsonb_build_object('name', source_name, 'title', title, 'url', url, 'at', published_at)
                order by published_at) sources
    from it group by sk
  ),
  full_ as (
    select st.*,
      coalesce((select array_agg(distinct g order by g) from it, unnest(it.igs) g where it.sk = st.sk), '{}') igs,
      (select count(distinct v.email) from pulse.vote v where v.item_id = any(st.ids))::int votes,
      (p_email is not null and exists (select 1 from pulse.vote v where v.item_id = any(st.ids) and v.email = lower(p_email))) mine
    from st where st.summary is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', left(md5(anchor), 16), 'rel', rel, 'added', first_at, 'title', title, 'url', url, 'lang', lang, 'source', source,
      'summary', summary, 'scope', scope, 'igs', igs, 'sources', sources, 'votes', votes, 'mine', mine)
    order by rel desc, first_at desc), '[]'::jsonb)
  from (select * from full_ order by rel desc, first_at desc limit 250) f
$$;

-- One vote per person and story (p_item: public id as above); p_on false withdraws it. Returns the new count.
create or replace function pulse.hub_vote(p_item text, p_email text, p_on boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare v_ids text[]; v_anchor text;
begin
  select array_agg(i.id order by i.published_at, i.id) into v_ids
  from pulse.items i
  where coalesce(i.story_id, i.id) = (select coalesce(x.story_id, x.id) from pulse.items x where left(md5(x.id), 16) = p_item limit 1);
  if v_ids is null then raise exception 'unknown item'; end if;
  v_anchor := (select x.id from pulse.items x where left(md5(x.id), 16) = p_item limit 1);   -- the story's public anchor
  delete from pulse.vote where item_id = any(v_ids) and email = lower(p_email);
  if p_on then insert into pulse.vote (item_id, email) values (v_anchor, lower(p_email)); end if;
  return (select count(distinct email) from pulse.vote where item_id = any(v_ids));
end $$;

revoke all on function pulse.hub_stories(int, text, text) from public, anon, authenticated;
revoke all on function pulse.hub_vote(text, text, boolean) from public, anon, authenticated;
revoke all on table pulse.vote, pulse.setting from public, anon, authenticated;
