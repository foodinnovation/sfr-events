// Radicle – Knowledge: members-only API behind the hub's knowledge tab.
//
// Speaks radicle's wiki API (agro-food-intelligence, src/api/wiki_routes.py), so radicle's
// own reader runs unchanged in the hub. The route is passed as ?path=:
//
//   GET  /topics                 sidebar tree and quick switcher
//   GET  /topics/<slug>          article with gaps, related topics, backlinks and projects
//   GET  /graph                  topic graph (related_topics pairs)
//   GET  /stats                  corpus counts for the home view
//   GET  /search?q=&limit=       topics and projects
//   GET  /instruments            funding programmes (finder browse view)
//   POST /funding-finder         {idea, active_only, min_severity} -> gaps, instruments, contacts
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

type Row = Record<string, unknown>;

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

// ------------------------------------------------------------------ text helpers

const STOP = new Set(("the and for are with was were this that from into over under our your their als and auf aus " +
  "bei das dem den der des die ein eine einem einen einer und its has have had can could will would not all any per " +
  "via use les des une dans pour sur avec est sont par wir ich uns new neue").split(" "));

/** Free text -> 'term:* | term:*' for to_tsquery. Only letters and digits survive, so no tsquery
 *  syntax can be injected; at most 40 terms. */
export function orQuery(text: string, prefix = true): string {
  const seen = new Set<string>();
  for (const t of (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])) {
    if (t.length < 3 || STOP.has(t) || seen.has(t)) continue;
    seen.add(t);
    if (seen.size >= 40) break;
  }
  return [...seen].map((t) => (prefix ? `${t}:*` : t)).join(" | ");
}

function snippet(text: string | null, q: string): string {
  const t = text ?? "";
  const terms = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((x) => x.length >= 3);
  const low = t.toLowerCase();
  let idx = -1;
  for (const term of terms) { idx = low.indexOf(term); if (idx >= 0) break; }
  let s: string;
  if (idx < 0) s = t.slice(0, 200).trim() + (t.length > 200 ? "…" : "");
  else {
    const a = Math.max(0, idx - 80), b = Math.min(t.length, idx + 160);
    s = (a ? "…" : "") + t.slice(a, b).trim() + (b < t.length ? "…" : "");
  }
  return s.replace(/[#*_`\[\]]+/g, "").trim();
}

const APPLICABLE = new Set("ch swiss schweiz switzerland liechtenstein europe european eu global".split(" "));
function applicable(loc: unknown): boolean {
  if (!loc) return true;
  return (String(loc).toLowerCase().match(/[a-z]+/g) ?? []).some((t) => APPLICABLE.has(t));
}
const FAMILIES = ["innosuisse", "snf", "horizon", "innovation booster", "eic"];
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ------------------------------------------------------------------ routes

const TOPIC_STATS = () => sql`
  select a.topic_slug slug, a.topic_label label, a.parent_topic, a.funding_trend, a.related_topics,
         jsonb_array_length(a.active_projects) + jsonb_array_length(a.completed_projects) project_count,
         coalesce(g.gap_count, 0)::int gap_count, g.max_severity
  from knowledge.article a
  left join (select topic_slug, count(*) gap_count, max(severity) max_severity
             from knowledge.gap group by topic_slug) g on g.topic_slug = a.topic_slug
  order by a.topic_label`;

async function topics(req: Request) {
  const rows = await TOPIC_STATS();
  return json(req, 200, rows.map((r: Row) => ({
    slug: r.slug, label: r.label, parent_topic: r.parent_topic, project_count: Number(r.project_count),
    gap_count: Number(r.gap_count), max_severity: num(r.max_severity), funding_trend: r.funding_trend,
  })));
}

async function topic(req: Request, slug: string) {
  const [a] = await sql`select * from knowledge.article where topic_slug = ${slug}`;
  if (!a) return json(req, 404, { detail: `Topic '${slug}' not found.` });

  const gaps = await sql`select spot_id, description, severity, gap_reason, cost_range_chf
                         from knowledge.gap where topic_slug = ${slug}
                         order by severity desc nulls last, spot_id`;
  const backlinks = await sql`select topic_slug slug, topic_label label from knowledge.article
                              where topic_slug <> ${slug} and related_topics ? ${slug} order by topic_label`;
  const related = a.related_topics as string[];
  const relRows = related.length
    ? await sql`select topic_slug, topic_label from knowledge.article where topic_slug = any(${related})`
    : [];
  const relLabel = new Map(relRows.map((r: Row) => [r.topic_slug as string, r.topic_label as string]));

  // project references: the article's lists plus every inline '#source:id' in the body
  const body = (a.body_markdown as string) ?? "";
  const inline = [...body.matchAll(/#(aramis|snf|regiosuisse):([A-Za-z0-9._-]+)/g)].map((m) => `${m[1]}:${m[2]}`);
  const ids = [...new Set([...(a.active_projects as string[]), ...(a.completed_projects as string[]), ...inline])];
  const projRows = ids.length
    ? await sql`select id, title, source, source_url from knowledge.project where id = any(${ids})`
    : [];
  const proj = new Map<string, Row>(projRows.map((p: Row) => [p.id as string, p]));
  const refs = (list: string[]) => list.filter((id) => proj.has(id)).map((id) => {
    const p = proj.get(id)!;
    return { id, title: p.title, source: p.source, url: p.source_url };
  });
  const linked = body.replace(/#(aramis|snf|regiosuisse):([A-Za-z0-9._-]+)/g, (m, src, id) => {
    const url = proj.get(`${src}:${id}`)?.source_url as string | undefined;
    return url && /^https?:\/\//.test(url) ? `[${m}](${url})` : m;
  });

  return json(req, 200, {
    slug: a.topic_slug, title: a.title, label: a.topic_label, parent_topic: a.parent_topic,
    body_markdown: linked, key_findings: a.key_findings,
    white_spots: gaps.map((g: Row) => ({ ...g, severity: Number(g.severity ?? 0) })),
    related_topics: related.filter((s) => relLabel.has(s)).map((s) => ({ slug: s, label: relLabel.get(s) })),
    backlinks,
    active_projects: refs(a.active_projects as string[]),
    completed_projects: refs(a.completed_projects as string[]),
    funding_trend: a.funding_trend, last_compiled: a.last_compiled ?? "",
  });
}

async function graph(req: Request) {
  const rows = await TOPIC_STATS();
  const known = new Set(rows.map((r: Row) => r.slug as string));
  const seen = new Set<string>();
  const links: { source: string; target: string }[] = [];
  for (const r of rows) {
    for (const other of (r.related_topics as string[]) ?? []) {
      if (typeof other !== "string" || !known.has(other) || other === r.slug) continue;
      const pair = [r.slug as string, other].sort();
      const key = pair.join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: pair[0], target: pair[1] });
    }
  }
  return json(req, 200, {
    nodes: rows.map((r: Row) => ({
      id: r.slug, label: r.label, parent_topic: r.parent_topic, project_count: Number(r.project_count),
      gap_count: Number(r.gap_count), max_severity: num(r.max_severity),
    })),
    links,
  });
}

async function stats(req: Request) {
  const [s] = await sql`select (select count(*) from knowledge.article)::int topics,
                               (select count(*) from knowledge.project)::int projects,
                               (select count(*) from knowledge.gap)::int gaps,
                               (select count(*) from knowledge.gap where severity = 5)::int critical_gaps`;
  return json(req, 200, s);
}

async function search(req: Request, q: string, limit: number) {
  q = q.slice(0, 200).trim();
  const prefix = orQuery(q);
  if (q.length < 2 || !prefix) return json(req, 200, { topics: [], projects: [] });
  const topicRows = await sql`
    select topic_slug, title, topic_label, body_markdown,
           ts_rank_cd(fts, websearch_to_tsquery('english', ${q})) + ts_rank_cd(fts, to_tsquery('simple', ${prefix})) rank
    from knowledge.article
    where fts @@ websearch_to_tsquery('english', ${q}) or fts @@ to_tsquery('simple', ${prefix})
    order by rank desc limit ${limit}`;
  const projectRows = await sql`
    select id, title, institution, lead, source, budget_chf, source_url, summary, topics,
           ts_rank_cd(fts, websearch_to_tsquery('english', ${q})) * 2 + ts_rank_cd(fts, to_tsquery('simple', ${prefix})) rank
    from knowledge.project
    where fts @@ websearch_to_tsquery('english', ${q}) or fts @@ to_tsquery('simple', ${prefix})
    order by rank desc, start_date desc nulls last limit ${limit}`;
  return json(req, 200, {
    topics: topicRows.map((r: Row) => ({
      slug: r.topic_slug, title: r.title, label: r.topic_label,
      snippet: snippet(r.body_markdown as string, q), score: Math.round(Number(r.rank) * 100),
    })),
    projects: projectRows.map((r: Row) => ({
      id: r.id, title: r.title, institution: (r.institution || r.lead || null), source: r.source,
      budget_chf: num(r.budget_chf), url: r.source_url, snippet: snippet((r.summary as string) || (r.title as string), q),
      topics: ((r.topics as unknown[]) ?? []).filter((t) => typeof t === "string"),
    })),
  });
}

const INSTRUMENT = () => sql`select id, name, funder, stage, link, max_funding_chf, project_topic, location, active_2026
                             from knowledge.instrument`;

async function instruments(req: Request) {
  const rows = await sql`select id, name, funder, stage, link, max_funding_chf, project_topic, active_2026
                         from knowledge.instrument order by active_2026 desc, name`;
  return json(req, 200, rows);
}

async function finder(req: Request) {
  const body = await req.json().catch(() => ({}));
  const idea = String(body?.idea ?? "").trim();
  if (idea.length < 10 || idea.length > 4000) return json(req, 422, { detail: "idea must be 10 to 4000 characters" });
  const activeOnly = body?.active_only !== false;
  const minSev = Math.min(5, Math.max(1, Number(body?.min_severity ?? 2) || 2));
  const q = orQuery(idea);
  const qe = orQuery(idea, false);

  const gaps = q ? await sql`
    select g.spot_id, g.topic_slug, coalesce(a.topic_label, g.topic_slug) topic_label, g.description, g.severity,
           g.cost_range_chf, g.evidence_block
    from knowledge.gap g left join knowledge.article a on a.topic_slug = g.topic_slug
    where g.fts @@ to_tsquery('english', ${qe}) and coalesce(g.severity, 0) >= ${minSev}
    order by ts_rank_cd(g.fts, to_tsquery('english', ${qe})) desc, g.severity desc limit 10` : [];

  const all = await INSTRUMENT();
  const ok = (i: Row) => (!activeOnly || i.active_2026 === true) && applicable(i.location);
  const picked: Row[] = [];
  const pickedIds = new Set<string>();
  if (q) {
    const hits = await sql`select id from knowledge.instrument where fts @@ to_tsquery('simple', ${q})
                           order by ts_rank_cd(fts, to_tsquery('simple', ${q})) desc limit 40`;
    const byId = new Map<string, Row>(all.map((i: Row) => [i.id as string, i]));
    for (const h of hits) {
      const i = byId.get(h.id as string);
      if (i && ok(i) && !pickedIds.has(i.id as string)) { picked.push({ ...i, tailored: true }); pickedIds.add(i.id as string); }
      if (picked.length >= 6) break;
    }
  }
  // general fallback: the broadly applicable programmes, one per funder family in turn
  const fam: Record<string, Row[]> = Object.fromEntries(FAMILIES.map((f) => [f, []]));
  for (const i of all as Row[]) {
    if (!ok(i) || pickedIds.has(i.id as string)) continue;
    const t = `${i.funder ?? ""} ${i.name ?? ""}`.toLowerCase();
    const f = FAMILIES.find((x) => t.includes(x));
    if (f) fam[f].push(i);
  }
  for (const f of FAMILIES) {
    fam[f].sort((a, b) =>
      ((String(a.funder ?? "").trim().toLowerCase() === f ? 0 : 1) - (String(b.funder ?? "").trim().toLowerCase() === f ? 0 : 1)) ||
      String(a.name ?? "").localeCompare(String(b.name ?? "")));
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
  let matched = contacts.filter((c: Row) => !c.fallback && (c.keywords as string[]).some((k) => low.includes(k)));
  if (!matched.length) matched = contacts.filter((c: Row) => c.fallback);
  return json(req, 200, {
    gaps: gaps.map((g: Row) => ({ ...g, severity: Number(g.severity ?? 0) })),
    instruments: picked.map(({ location: _l, ...i }) => i),
    contacts: matched.slice(0, 3).map((c: Row) => ({ key: c.key, name: c.name, role: c.role, email: null })),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  const url = new URL(req.url);
  try {
    const email = await signedInEmail(req);
    if (!email) return json(req, 401, { detail: "sign_in" });
    const [r] = await sql`select knowledge.can_read(${email}) ok`;
    if (!r.ok) return json(req, 403, { detail: "members_only" });

    const p = new URL(url.searchParams.get("path") ?? "/", "https://x");
    const path = p.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "POST") {
      if (path === "/funding-finder") return await finder(req);
      return json(req, 405, { detail: "method" });
    }
    if (req.method !== "GET") return json(req, 405, { detail: "method" });
    if (path === "/topics") return await topics(req);
    if (path.startsWith("/topics/")) return await topic(req, decodeURIComponent(path.slice(8)).slice(0, 80));
    if (path === "/graph") return await graph(req);
    if (path === "/stats") return await stats(req);
    if (path === "/instruments") return await instruments(req);
    if (path === "/search") {
      const limit = Math.min(50, Math.max(1, Number(p.searchParams.get("limit") ?? 20) || 20));
      return await search(req, p.searchParams.get("q") ?? "", limit);
    }
    return json(req, 404, { detail: "not_found" });
  } catch (e) {
    console.error("knowledge function error", (e as Error).message);
    return json(req, 500, { detail: "server" });
  }
});
