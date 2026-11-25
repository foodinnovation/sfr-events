-- Pulse: a finer 0-100 score (set by foodinnovation/sfr-pulse inside the band of the 1-5 relevance:
-- 1 = 0-19, 2 = 20-39, 3 = 40-59, 4 = 60-79, 5 = 80-100) and an adjustable cut-off for the hub.
-- min_score 60 shows exactly what "relevance 4 or 5" showed; 50 adds the better half of the 3s.

alter table pulse.items add column if not exists score smallint check (score between 0 and 100);
insert into pulse.setting (key, value) values ('min_score', '60') on conflict (key) do nothing;

-- The score the hub uses: the item's own, else the bottom of its relevance band (older items without a score).
create or replace function pulse.hub_score(p_relevance int, p_score int)
returns int language sql immutable set search_path = '' as $$
  select coalesce(p_score, 20 * (greatest(coalesce(p_relevance, 0), 1) - 1))
$$;

-- A link the hub may show: no newsletter click-tracker, no mailbox address; open source or an allowed sender.
create or replace function pulse.hub_link_ok(p_url text, p_origin text, p_inbox_allowed boolean)
returns boolean language sql immutable set search_path = '' as $$
  select p_url is not null and p_url ~* '^https?://'
     and p_url !~* '(%40|@|/click/|piano\.io|ccsend\.com|list-manage\.com|mailchi\.mp|adnz\.co|sendgrid|/redirect|/track)'
     and (p_origin = 'open' or coalesce(p_inbox_allowed, false))
$$;

-- Stories for the hub, best score first, then newest. A story's public id is the first 16 hex of md5(anchor item id),
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
           i.published_at, i.relevance, pulse.hub_score(i.relevance, i.score) score, i.igs, i.scope, i.summary_en,
           coalesce(s.name, regexp_replace(coalesce(i.source_id, ''), '^www\.', '')) source_name
    from raw i left join pulse.sources s on s.id = i.source_id
    where pulse.hub_score(i.relevance, i.score) >= (select coalesce(max(value::int), 60) from pulse.setting where key = 'min_score')
      and pulse.hub_link_ok(i.eff_url, i.origin, i.inbox_allowed)
      and i.published_at <= now() + interval '1 day'
      and (p_item is not null or i.published_at >= now() - make_interval(days => greatest(1, least(p_days, 60))))
      and (p_item is null or coalesce(i.story_id, i.id) = (select coalesce(x.story_id, x.id) from pulse.items x where left(md5(x.id), 16) = p_item limit 1))
  ),
  st as (
    select sk,
      (array_agg(id order by published_at, id))[1] anchor,
      max(relevance) rel,
      max(score) score,
      min(published_at) first_at,
      (array_agg(title order by score desc, (origin = 'open') desc, published_at))[1] title,
      (array_agg(url order by score desc, (origin = 'open') desc, published_at))[1] url,
      (array_agg(lang order by score desc, (origin = 'open') desc, published_at))[1] lang,
      (array_agg(source_name order by score desc, (origin = 'open') desc, published_at))[1] source,
      (array_agg(summary_en order by score desc, length(coalesce(summary_en, '')) desc))[1] summary,
      (array_agg(scope order by score desc))[1] scope,
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
      'id', left(md5(anchor), 16), 'rel', rel, 'score', score, 'added', first_at, 'title', title, 'url', url, 'lang', lang, 'source', source,
      'summary', summary, 'scope', scope, 'igs', igs, 'sources', sources, 'votes', votes, 'mine', mine)
    order by score desc, first_at desc), '[]'::jsonb)
  from (select * from full_ order by score desc, first_at desc limit 400) f
$$;


revoke all on function pulse.hub_stories(int, text, text) from public, anon, authenticated;
