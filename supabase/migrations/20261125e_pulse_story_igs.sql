-- Pulse: a story's Innovation Groups are those of its best report, in the tagger's order (main group
-- first), not the alphabetical union of every report's groups (SFR review, 25 Nov 2026).
create or replace function pulse.hub_stories(p_days integer, p_email text default null::text, p_item text default null::text)
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  with raw as (
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
      (array_agg(to_jsonb(igs) order by score desc, (origin = 'open') desc, published_at)
        filter (where cardinality(igs) > 0))[1] igs,
      array_agg(id) ids,
      jsonb_agg(jsonb_build_object('name', source_name, 'title', title, 'url', url, 'at', published_at)
                order by published_at) sources
    from it group by sk
  ),
  full_ as (
    select st.*,
      (select count(distinct v.email) from pulse.vote v where v.item_id = any(st.ids))::int votes,
      (p_email is not null and exists (select 1 from pulse.vote v where v.item_id = any(st.ids) and v.email = lower(p_email))) mine
    from st where st.summary is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', left(md5(anchor), 16), 'rel', rel, 'score', score, 'added', first_at, 'title', title, 'url', url, 'lang', lang, 'source', source,
      'summary', summary, 'scope', scope, 'igs', coalesce(igs, '[]'::jsonb), 'sources', sources, 'votes', votes, 'mine', mine)
    order by score desc, first_at desc), '[]'::jsonb)
  from (select * from full_ order by score desc, first_at desc limit 400) f
$function$;

revoke all on function pulse.hub_stories(int, text, text) from public, anon, authenticated;
