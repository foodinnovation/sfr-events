// SFR hub statistics for the staff-only Statistics tab.
//   GET /stats?from=YYYY-MM-DD&to=YYYY-MM-DD   signed-in staff -> aggregated counts
// Only aggregates leave the database; there is nothing per visitor to return.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, prepare: false });
const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://foodinnovation.github.io,https://hub.swissfoodresearch.ch,http://localhost:8000").split(",").map((s: string) => s.trim());

function json(req: Request, status: number, body: unknown) {
  const origin = req.headers.get("origin") ?? "";
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, OPTIONS", "Vary": "Origin",
    "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

const day = (s: string | null, fallback: Date) =>
  s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback.toISOString().slice(0, 10);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json(req, 204, null);
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = jwt ? await auth.auth.getUser(jwt) : { data: { user: null } };
  const email = data.user?.email_confirmed_at ? data.user.email!.toLowerCase() : null;
  if (!email) return json(req, 401, { detail: "sign_in" });
  const [s] = await sql`select events.is_staff_email(${email}) ok`;
  if (!s.ok) return json(req, 403, { detail: "staff_only" });

  const url = new URL(req.url);
  const to = day(url.searchParams.get("to"), new Date());
  const from = day(url.searchParams.get("from"), new Date(Date.now() - 29 * 86400_000));
  const W = sql`at >= ${from}::date and at < ${to}::date + 1`;
  try {
    const [totals] = await sql`select count(*) filter (where kind='view')::int views,
        count(*) filter (where kind='register')::int registers,
        count(*) filter (where kind='ad_click')::int ad_clicks,
        count(*) filter (where kind='mail_click')::int mail_clicks,
        count(*) filter (where kind like 'kn_%')::int knowledge
      from events.metric where ${W}`;
    const daily = await sql`select to_char(d, 'YYYY-MM-DD') as day, coalesce(v, 0)::int views
      from generate_series(${from}::date, ${to}::date, '1 day') d
      left join (select at::date dd, count(*) v from events.metric where kind='view' and ${W} group by 1) x on x.dd = d
      order by d`;
    const roles = await sql`select role, count(*)::int views from events.metric where kind='view' and ${W}
      group by 1 order by 2 desc`;
    const events = await sql`select m.ref slug, coalesce(max(e.title_en), max(e.title_src), m.ref) title,
        max(e.event_date)::text date,
        count(*) filter (where m.kind='view')::int views,
        count(*) filter (where m.kind='register')::int registers
      from events.metric m left join events.event e on e.slug = m.ref
      where m.kind in ('view','register') and m.ref is not null and ${W}
      group by m.ref order by 4 desc limit 60`;
    const ads = await sql`select ref ad, count(*) filter (where kind='ad_view')::int shown,
        count(*) filter (where kind='ad_click')::int clicks
      from events.metric where kind in ('ad_view','ad_click') and ${W} group by 1 order by 2 desc`;
    const mail = await sql`select ref button, count(*)::int clicks from events.metric
      where kind='mail_click' and ${W} group by 1 order by 2 desc limit 20`;
    const home = await sql`select case when kind = 'booking_open' then 'calendar-shown' else split_part(ref, ': ', 1) end button,
        count(*)::int clicks from events.metric
      where (kind = 'home_click' or (kind = 'booking_open' and coalesce(ref, 'home') in ('home', 'calendly'))) and ${W}
      group by 1 order by 2 desc limit 20`;
    const services = await sql`select case when kind = 'booking_open' then 'calendar-shown' else ref end action,
        count(*)::int clicks from events.metric
      where (kind = 'svc_click' or (kind = 'booking_open' and ref = 'services')) and ${W}
      group by 1 order by 2 desc limit 40`;
    const searches = await sql`select lower(ref) term, count(*)::int n from events.metric
      where kind='search' and ${W} group by 1 order by 2 desc limit 20`;
    const filters = await sql`select ref as filter, count(*)::int n from events.metric
      where kind='filter' and ${W} group by 1 order by 2 desc limit 20`;
    const topics = await sql`select m.ref slug, coalesce(max(a.topic_label), m.ref) label, count(*)::int n
      from events.metric m left join knowledge.article a on a.topic_slug = m.ref
      where m.kind='kn_topic' and ${W} group by m.ref order by 3 desc limit 15`;
    const [kn] = await sql`select count(*) filter (where kind='kn_search')::int searches,
        count(*) filter (where kind='kn_finder')::int finder_runs,
        count(*) filter (where kind='kn_topic')::int topics_opened
      from events.metric where ${W}`;
    const sources = await sql`select source, count(*)::int views from events.metric
      where kind='view' and source is not null and ${W} group by 1 order by 2 desc limit 10`;
    const [dev] = await sql`select count(*) filter (where mobile)::int mobile, count(*) filter (where not mobile)::int desktop
      from events.metric where kind='view' and ${W}`;
    // Pulse: refs are "<story id>|<title>", for clicks to an original "<domain>|<story id>|<title>"
    const [plTotals] = await sql`select count(*) filter (where kind = 'view' and page like '%/pulse/%')::int views,
        count(*) filter (where kind = 'pl_story')::int stories,
        count(*) filter (where kind = 'pl_source')::int originals,
        count(*) filter (where kind = 'pl_vote')::int votes,
        count(*) filter (where kind = 'home_click' and ref like 'pulse%')::int from_home
      from events.metric where ${W}`;
    const plStories = await sql`select x.id, max(x.title) title,
        count(*) filter (where x.kind = 'pl_story')::int opened,
        count(*) filter (where x.kind = 'pl_source')::int originals,
        count(*) filter (where x.kind = 'pl_vote')::int votes
      from (select kind,
              case when kind = 'pl_source' then split_part(ref, '|', 2) else split_part(ref, '|', 1) end as id,
              nullif(case when kind = 'pl_source' then substring(ref from '^[^|]*\\|[^|]*\\|(.*)$')
                   else substring(ref from '^[^|]*\\|(.*)$') end, '') as title
            from events.metric where kind in ('pl_story', 'pl_source', 'pl_vote') and ref is not null and ${W}) x
      where x.id <> '' group by x.id order by 3 desc, 4 desc, 5 desc limit 30`;
    const plOutlets = await sql`select split_part(ref, '|', 1) as outlet, count(*)::int clicks from events.metric
      where kind = 'pl_source' and ref is not null and ${W} group by 1 order by 2 desc limit 15`;
    const plFilters = await sql`select ref as filter, count(*)::int n from events.metric
      where kind = 'pl_filter' and ${W} group by 1 order by 2 desc limit 20`;
    const plSearches = await sql`select lower(ref) term, count(*)::int n from events.metric
      where kind = 'pl_search' and ${W} group by 1 order by 2 desc limit 20`;
    // Radicle connector (MCP): per-person log in knowledge.mcp_log; only totals and organisations leave the database
    const [cx] = await sql`select count(*) filter (where ok and left(tool, 1) <> '_')::int calls,
        count(distinct email) filter (where ok and left(tool, 1) <> '_')::int people,
        count(distinct domain) filter (where ok and left(tool, 1) <> '_')::int organisations,
        count(*) filter (where tool = '_sign_in' and ok)::int connections,
        count(*) filter (where error = 'limit')::int limit_hits,
        count(*) filter (where error = 'no_access')::int refused
      from knowledge.mcp_log where ${W}`;
    const cxTools = await sql`select tool, count(*)::int calls from knowledge.mcp_log
      where ok and left(tool, 1) <> '_' and ${W} group by 1 order by 2 desc`;
    const cxOrgs = await sql`select coalesce(max(m.name), l.domain) organisation, count(*)::int calls, count(distinct l.email)::int people
      from knowledge.mcp_log l left join public.crm_members m on lower(m.domain) = l.domain
      where l.ok and left(l.tool, 1) <> '_' and ${W} group by l.domain order by 2 desc limit 20`;
    return json(req, 200, { from, to, totals, daily, roles, events, ads, mail, home, services, searches, filters,
      knowledge: { ...kn, topics }, sources, devices: dev,
      pulse: { ...plTotals, stories_top: plStories, outlets: plOutlets, filters: plFilters, searches: plSearches },
      connector: { ...cx, tools: cxTools, organisations_top: cxOrgs } });
  } catch (e) {
    console.error("stats failed", (e as Error).message);
    return json(req, 500, { detail: "server" });
  }
});
