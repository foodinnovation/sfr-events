// Radicle – Knowledge: members-only API behind the hub's knowledge tab.
//
//   GET  ?topics=1           topic list (for the knowledge home)
//   GET  ?topic=<slug>       one article with its projects
//   GET  ?project=<id>       one project
//   GET  ?q=<text>           search: topics and projects
//   POST ?finder=1 {idea}    funding finder: matching gaps, instruments, contact
//
// Every call needs a signed-in Supabase session whose email belongs to a member (exact domain)
// or to staff; event participants are refused. Data: schema knowledge in ig-wiki, copied from
// radicle and the monday board Funding Schemes by the sync job (sync/knowledge.py).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 3, prepare: false });
const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);

const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://foodinnovation.github.io,https://hub.swissfoodresearch.ch,https://www.swissfoodresearch.ch,http://localhost:8000")
  .split(",").map((s) => s.trim());

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function signedInEmail(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await auth.auth.getUser(jwt);
  if (error || !data.user?.email || !data.user.email_confirmed_at) return null;
  return data.user.email.toLowerCase();
}

// ------------------------------------------------------------------ text to query

const STOP = new Set(("the and for are with was were this that from into over under our your their als and auf aus " +
  "bei das dem den der des die ein eine einem einen einer und its has have had can could will would not all any per " +
  "via use les des une dans pour sur avec est sont par wir ich uns new neue").split(" "));

/** Free text -> 'term:* | term:*' for to_tsquery. Only letters and digits survive, so no tsquery syntax
 *  can be injected; at most 40 terms. */
export function orQuery(text: string): string {
  const seen = new Set<string>();
  for (const t of (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])) {
    if (t.length < 3 || STOP.has(t) || seen.has(t)) continue;
    seen.add(t);
    if (seen.size >= 40) break;
  }
  return [...seen].map((t) => `${t}:*`).join(" | ");
}

const APPLICABLE = new Set("ch swiss schweiz switzerland liechtenstein europe european eu global".split(" "));
function applicable(loc: string | null): boolean {
  if (!loc) return true;
  return (loc.toLowerCase().match(/[a-z]+/g) ?? []).some((t) => APPLICABLE.has(t));
}
const FAMILIES = ["innosuisse", "snf", "horizon", "innovation booster", "eic"];

// ------------------------------------------------------------------ endpoints

async function topics(req: Request) {
  const rows = await sql`select topic_slug slug, topic_label label, parent_topic parent, title, funding_trend trend,
                                jsonb_array_length(active_projects) active, jsonb_array_length(completed_projects) completed
                         from knowledge.article order by parent_topic, topic_label`;
  const [s] = await sql`select (select count(*) from knowledge.project) projects,
                               (select max(last_compiled) from knowledge.article) compiled`;
  return json(req, 200, { topics: rows, projects: Number(s.projects), compiled: s.compiled });
}

const brief = () => sql`id, source, title, funder, start_date, end_date, status, institution, budget_chf`;

async function topic(req: Request, slug: string) {
  const [a] = await sql`select topic_slug slug, topic_label label, parent_topic parent, title, body_markdown body,
                               key_findings, related_topics, active_projects, completed_projects, funding_trend trend,
                               last_compiled compiled
                        from knowledge.article where topic_slug = ${slug}`;
  if (!a) return json(req, 404, { error: "not_found" });
  const ids = [...a.active_projects, ...a.completed_projects] as string[];
  const projects = ids.length
    ? await sql`select ${brief()} from knowledge.project where id = any(${ids})
                order by start_date desc nulls last`
    : [];
  const active = new Set(a.active_projects as string[]);
  const related = (a.related_topics as string[]).length
    ? await sql`select topic_slug slug, topic_label label from knowledge.article
                where topic_slug = any(${a.related_topics as string[]})`
    : [];
  const [contact] = await sql`select name, role from knowledge.contact
                              where ${slug} = any(topics) or fallback order by fallback limit 1`;
  return json(req, 200, {
    ...a, active_projects: undefined, completed_projects: undefined, related_topics: undefined,
    related, contact,
    projects: projects.map((p) => ({ ...p, active: active.has(p.id) })),
  });
}

async function project(req: Request, id: string) {
  const [p] = await sql`select id, source, title, summary, topics, trl, funder, start_date, end_date, status,
                               budget_chf, institution, lead, partners, source_url
                        from knowledge.project where id = ${id}`;
  if (!p) return json(req, 404, { error: "not_found" });
  const slugs = (p.topics ?? []) as string[];
  const topicsOut = slugs.length
    ? await sql`select topic_slug slug, topic_label label from knowledge.article where topic_slug = any(${slugs})`
    : [];
  return json(req, 200, { ...p, topics: topicsOut });
}

async function search(req: Request, q: string) {
  q = q.slice(0, 200);
  const prefix = orQuery(q);
  if (!prefix) return json(req, 200, { topics: [], projects: [] });
  // websearch syntax first (phrases, -exclusions); prefix OR-match as the fallback for partial words
  const topicRows = await sql`
    select topic_slug slug, topic_label label, parent_topic parent, title,
           ts_rank_cd(fts, websearch_to_tsquery('english', ${q})) + ts_rank_cd(fts, to_tsquery('simple', ${prefix})) rank
    from knowledge.article
    where fts @@ websearch_to_tsquery('english', ${q}) or fts @@ to_tsquery('simple', ${prefix})
    order by rank desc limit 8`;
  const projectRows = await sql`
    select ${brief()}, left(summary, 260) snippet,
           ts_rank_cd(fts, websearch_to_tsquery('english', ${q})) * 2 + ts_rank_cd(fts, to_tsquery('simple', ${prefix})) rank
    from knowledge.project
    where fts @@ websearch_to_tsquery('english', ${q}) or fts @@ to_tsquery('simple', ${prefix})
    order by rank desc, start_date desc nulls last limit 40`;
  return json(req, 200, { topics: topicRows, projects: projectRows });
}

async function finder(req: Request) {
  const body = await req.json().catch(() => ({}));
  const idea = String(body?.idea ?? "").trim();
  if (idea.length < 10 || idea.length > 4000) return json(req, 400, { error: "idea_length" });
  const activeOnly = body?.active_only !== false;
  const q = orQuery(idea);

  const gaps = q ? await sql`
    select g.spot_id, g.topic_slug, coalesce(a.topic_label, g.topic_slug) topic_label, g.description, g.severity,
           g.cost_range_chf, ts_rank_cd(g.fts, to_tsquery('english', ${q.replaceAll(":*", "")})) rank
    from knowledge.gap g left join knowledge.article a on a.topic_slug = g.topic_slug
    where g.fts @@ to_tsquery('english', ${q.replaceAll(":*", "")}) and coalesce(g.severity, 0) >= 2
    order by rank desc, g.severity desc limit 10` : [];

  const all = await sql`select id, name, funder, stage, link, max_funding_chf, project_topic, location, active_2026
                        from knowledge.instrument order by name`;
  const ok = (i: Record<string, unknown>) =>
    (!activeOnly || i.active_2026 === true) && applicable(i.location as string | null);
  const picked: Record<string, unknown>[] = [];
  const pickedIds = new Set<string>();
  if (q) {
    const hits = await sql`select id from knowledge.instrument where fts @@ to_tsquery('simple', ${q})
                           order by ts_rank_cd(fts, to_tsquery('simple', ${q})) desc limit 40`;
    const byId = new Map<string, Record<string, unknown>>(all.map((i: Record<string, unknown>) => [i.id as string, i]));
    for (const h of hits) {
      const i = byId.get(h.id);
      if (i && ok(i) && !pickedIds.has(i.id as string)) { picked.push({ ...i, tailored: true }); pickedIds.add(i.id as string); }
      if (picked.length >= 6) break;
    }
  }
  // general fallback: the broadly applicable programmes, one per funder family in turn
  const fam: Record<string, Record<string, unknown>[]> = Object.fromEntries(FAMILIES.map((f) => [f, []]));
  for (const i of all) {
    if (!ok(i) || pickedIds.has(i.id)) continue;
    const t = `${i.funder ?? ""} ${i.name ?? ""}`.toLowerCase();
    const f = FAMILIES.find((x) => t.includes(x));
    if (f) fam[f].push(i);
  }
  for (const f of FAMILIES) {
    fam[f].sort((a, b) =>
      (((a.funder as string) ?? "").trim().toLowerCase() === f ? 0 : 1) -
      (((b.funder as string) ?? "").trim().toLowerCase() === f ? 0 : 1));
  }
  for (let round = 0; picked.length < 8; round++) {
    let progressed = false;
    for (const f of FAMILIES) {
      const i = fam[f][round];
      if (i && !pickedIds.has(i.id as string)) {
        picked.push({ ...i, tailored: false }); pickedIds.add(i.id as string); progressed = true;
        if (picked.length >= 8) break;
      }
    }
    if (!progressed) break;
  }

  const contacts = await sql`select key, name, role, keywords, fallback from knowledge.contact`;
  const low = idea.toLowerCase();
  let matched = contacts.filter((c) => !c.fallback && (c.keywords as string[]).some((k) => low.includes(k)));
  if (!matched.length) matched = contacts.filter((c) => c.fallback);
  return json(req, 200, {
    gaps,
    instruments: picked,
    contacts: matched.slice(0, 3).map((c) => ({ name: c.name, role: c.role })),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  const url = new URL(req.url);
  try {
    const email = await signedInEmail(req);
    if (!email) return json(req, 401, { error: "sign_in" });
    const [r] = await sql`select knowledge.can_read(${email}) ok`;
    if (!r.ok) return json(req, 403, { error: "members_only" });

    if (req.method === "POST" && url.searchParams.has("finder")) return await finder(req);
    if (req.method !== "GET") return json(req, 405, { error: "method" });
    if (url.searchParams.has("topics")) return await topics(req);
    const slug = url.searchParams.get("topic");
    if (slug) return await topic(req, slug.slice(0, 80));
    const id = url.searchParams.get("project");
    if (id) return await project(req, id.slice(0, 80));
    const q = url.searchParams.get("q");
    if (q !== null) return await search(req, q);
    return json(req, 400, { error: "missing_parameter" });
  } catch (e) {
    console.error("knowledge function error", (e as Error).message);
    return json(req, 500, { error: "server" });
  }
});
