// Radicle connector: an MCP server (Streamable HTTP, stateless JSON) that lets SFR members use Radicle
// from Claude, ChatGPT, Le Chat, Cursor or any MCP client that supports OAuth sign-in.
//
// Sign-in reuses the hub login: /authorize sends the person to hub.swissfoodresearch.ch/connect/,
// where they sign in as on the Knowledge tab (email link or Microsoft) and allow the connection;
// the page posts the hub session to /approve, which applies the Knowledge tab's rule (member by exact
// email domain, or staff; participants and free-mail addresses are refused) and returns a one-time code.
// This function then issues its own tokens (access 8 h, refresh 30 days, access re-checked on renewal).
//
// Every tool call goes through knowledge.mcp_take: access check, 200 calls per person per day, log.
// The read queries mirror supabase/functions/knowledge (same tables, same results as the Knowledge tab).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { jwtVerify, SignJWT } from "npm:jose@5";
import postgres from "npm:postgres@3.4.5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const HUB = (Deno.env.get("HUB_URL") ?? "https://hub.swissfoodresearch.ch").replace(/\/$/, "");
const HUB_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://hub.swissfoodresearch.ch,https://foodinnovation.github.io,http://localhost:8000").split(",").map((s) => s.trim());
const CAP = Number(Deno.env.get("RADICLE_DAILY_CAP") ?? 200) || 200;
const BASE = `${SUPABASE_URL}/functions/v1/radicle-mcp`;
const ACCESS_TTL = 8 * 3600, REFRESH_TTL = 30 * 86400, REQUEST_TTL = 20 * 60, CODE_TTL = 300;
// Token signing key: RADICLE_MCP_SECRET if set, otherwise derived from the service-role key (never leaves the function).
const SIGNING = new Uint8Array(await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(Deno.env.get("RADICLE_MCP_SECRET") || `radicle-mcp:${SERVICE_KEY}`)));

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 3, prepare: false });
const auth = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { auth: { persistSession: false } });

// Return addresses an MCP client may register: any https page, a local port (desktop clients) or an app scheme.
const REDIRECT_OK = [
  /^https:\/\/[a-z0-9.-]+(:\d+)?\/[^\s#]*$/i,
  /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/[^\s#]*$/i,
  /^(cursor|vscode|vscode-insiders|windsurf|zed|claude|raycast):\/\/[^\s#]+$/i,
];
const redirectOk = (u: string) => u.length < 600 && REDIRECT_OK.some((r) => r.test(u));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};
const hubCors = (req: Request) => {
  const o = req.headers.get("origin") ?? "";
  return { "Access-Control-Allow-Origin": HUB_ORIGINS.includes(o) ? o : HUB_ORIGINS[0], "Vary": "Origin",
    "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
};
const json = (body: unknown, status = 200, extra: Record<string, string> = CORS) =>
  new Response(JSON.stringify(body), { status, headers: { ...extra, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });
const page = (title: string, text: string, status = 400) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:36rem;margin:4rem auto;line-height:1.5"><h2>${title}</h2><p>${text}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
const withParams = (u: string, q: Record<string, string>) => u + (u.includes("?") ? "&" : "?") + new URLSearchParams(q);

// ------------------------------------------------------------------ tokens
const sign = (claims: Record<string, unknown>, ttl: number) =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuer(BASE).setIssuedAt().setExpirationTime(`${ttl}s`).sign(SIGNING);
async function verifyOwn(token: string, typ: string) {
  const { payload } = await jwtVerify(token, SIGNING, { issuer: BASE });
  if (payload.typ !== typ) throw new Error("wrong token type");
  return payload as Record<string, any>;
}
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const s256 = async (v: string) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
const take = async (email: string, tool: string): Promise<string> =>
  (await sql`select knowledge.mcp_take(${email}, ${tool}, ${CAP}) r`)[0].r;

// ------------------------------------------------------------------ OAuth metadata
const asMetadata = () => ({
  issuer: BASE,
  authorization_endpoint: `${BASE}/authorize`,
  token_endpoint: `${BASE}/token`,
  registration_endpoint: `${BASE}/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  scopes_supported: ["radicle"],
  service_documentation: `${HUB}/connect/`,
});
const prMetadata = () => ({ resource: BASE, authorization_servers: [BASE], scopes_supported: ["radicle"],
  bearer_methods_supported: ["header"], resource_name: "Radicle (Swiss Food Research)" });

// ------------------------------------------------------------------ OAuth endpoints
async function register(req: Request) {
  const body = await req.json().catch(() => ({}));
  const uris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || !uris.every(redirectOk)) return json({ error: "invalid_redirect_uri" }, 400);
  const name = String(body.client_name ?? "AI assistant").replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 60) || "AI assistant";
  // stateless: the client's name travels inside its id, so the consent page can show it
  const clientId = `radicle.${b64url(new TextEncoder().encode(name))}.${crypto.randomUUID()}`;
  return json({
    client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name,
    redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  }, 201);
}

function clientName(cid: string): string {
  const m = /^radicle\.([A-Za-z0-9_-]+)\./.exec(cid);
  if (!m) return "AI assistant";
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))); }
  catch { return "AI assistant"; }
}

async function authorize(url: URL) {
  const p = url.searchParams;
  const ru = p.get("redirect_uri") ?? "";
  if (!redirectOk(ru)) return page("Connection refused", "The AI client gave an unknown return address.");
  if (p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge"))
    return redirect(withParams(ru, { error: "invalid_request", state: p.get("state") ?? "" }));
  const cid = p.get("client_id") ?? "";
  const reqToken = await sign({ typ: "request", ru, cs: p.get("state") ?? "", cc: p.get("code_challenge"), cid,
    cn: clientName(cid), host: hostOf(ru) }, REQUEST_TTL);
  return redirect(`${HUB}/connect/?req=${encodeURIComponent(reqToken)}`);
}

function hostOf(u: string): string {
  try { const x = new URL(u); return x.protocol.startsWith("http") ? x.host : `${x.protocol.replace(/:$/, "")} app`; }
  catch { return "unknown"; }
}

// The hub's /connect/ page calls this with the signed request and the member's hub session.
async function approve(req: Request) {
  const h = hubCors(req);
  const body = await req.json().catch(() => ({}));
  let r: Record<string, any>;
  try { r = await verifyOwn(String(body.req ?? ""), "request"); }
  catch { return json({ detail: "expired" }, 400, h); }
  if (body.deny === true) return json({ redirect: withParams(r.ru, { error: "access_denied", state: r.cs }) }, 200, h);
  const { data, error } = await auth.auth.getUser(String(body.token ?? ""));
  const email = !error && data.user?.email_confirmed_at ? String(data.user.email ?? "").toLowerCase() : "";
  if (!email) return json({ detail: "sign_in" }, 401, h);
  if ((await take(email, "_sign_in")) !== "ok") return json({ detail: "members_only", email }, 403, h);
  const code = await sign({ typ: "code", sub: email, cc: r.cc, ru: r.ru, cid: r.cid }, CODE_TTL);
  return json({ redirect: withParams(r.ru, { code, state: r.cs }), email }, 200, h);
}

async function token(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  const form = ct.includes("json") ? new URLSearchParams(await req.json()) : new URLSearchParams(await req.text());
  const err = (e: string, d = "") => json({ error: e, error_description: d }, 400);
  let email: string;
  try {
    if (form.get("grant_type") === "authorization_code") {
      const c = await verifyOwn(form.get("code") ?? "", "code");
      if (c.ru !== form.get("redirect_uri")) return err("invalid_grant", "redirect_uri mismatch");
      if (form.get("client_id") && c.cid && form.get("client_id") !== c.cid) return err("invalid_grant", "client mismatch");
      if ((await s256(form.get("code_verifier") ?? "")) !== c.cc) return err("invalid_grant", "PKCE check failed");
      email = c.sub;
    } else if (form.get("grant_type") === "refresh_token") {
      email = (await verifyOwn(form.get("refresh_token") ?? "", "refresh")).sub;
      if ((await take(email, "_refresh")) !== "ok") return err("invalid_grant", "no longer a member address");
    } else return err("unsupported_grant_type");
  } catch (e) { return err("invalid_grant", (e as Error).message); }
  return json({
    access_token: await sign({ typ: "access", sub: email, aud: BASE }, ACCESS_TTL), token_type: "Bearer", expires_in: ACCESS_TTL,
    refresh_token: await sign({ typ: "refresh", sub: email }, REFRESH_TTL), scope: "radicle",
  });
}

// ------------------------------------------------------------------ Radicle reads (as in the knowledge function)
type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const STOP = new Set(("the and for are with was were this that from into over under our your their als and auf aus " +
  "bei das dem den der des die ein eine einem einen einer und its has have had can could will would not all any per " +
  "via use les des une dans pour sur avec est sont par wir ich uns new neue").split(" "));
function orQuery(text: string): string {
  const seen = new Set<string>();
  for (const t of (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])) {
    if (t.length < 3 || STOP.has(t) || seen.has(t)) continue;
    seen.add(t);
    if (seen.size >= 40) break;
  }
  return [...seen].map((t) => `${t}:*`).join(" | ");
}
function snippet(text: string | null, q: string): string {
  const t = text ?? "";
  const terms = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((x) => x.length >= 3);
  const low = t.toLowerCase();
  let idx = -1;
  for (const term of terms) { idx = low.indexOf(term); if (idx >= 0) break; }
  let s: string;
  if (idx < 0) s = t.slice(0, 240).trim() + (t.length > 240 ? "…" : "");
  else {
    const a = Math.max(0, idx - 80), b = Math.min(t.length, idx + 200);
    s = (a ? "…" : "") + t.slice(a, b).trim() + (b < t.length ? "…" : "");
  }
  return s.replace(/[#*_`\[\]]+/g, "").trim();
}
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const intArg = (v: unknown, d: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v ?? d)) || d));

async function toolTopics() {
  const rows = await sql`
    select a.topic_slug slug, a.topic_label label, a.parent_topic, a.funding_trend,
           jsonb_array_length(a.active_projects) + jsonb_array_length(a.completed_projects) project_count,
           coalesce(g.gap_count, 0)::int gap_count, g.max_severity
    from knowledge.article a
    left join (select topic_slug, count(*) gap_count, max(severity) max_severity from knowledge.gap group by topic_slug) g
      on g.topic_slug = a.topic_slug
    order by a.topic_label`;
  const [s] = await sql`select (select count(*) from knowledge.article)::int topics, (select count(*) from knowledge.project)::int projects,
                               (select count(*) from knowledge.gap)::int gaps, (select count(*) from knowledge.instrument)::int funding_programmes`;
  return {
    totals: s,
    topics: rows.map((r: Row) => ({ slug: r.slug, label: r.label, parent_topic: r.parent_topic, project_count: Number(r.project_count),
      gap_count: Number(r.gap_count), max_gap_severity: num(r.max_severity), funding_trend: r.funding_trend })),
  };
}

async function toolTopic(slug: string) {
  const [a] = await sql`select * from knowledge.article where topic_slug = ${slug}`;
  if (!a) return { error: `No topic '${slug}'. Call radicle_topics for the list of slugs, or radicle_search.` };
  const gaps = await sql`select spot_id, description, severity, gap_reason, cost_range_chf from knowledge.gap
                         where topic_slug = ${slug} order by severity desc nulls last, spot_id`;
  const backlinks = await sql`select topic_slug slug, topic_label label from knowledge.article
                              where topic_slug <> ${slug} and related_topics ? ${slug} order by topic_label`;
  const related = (a.related_topics as string[]) ?? [];
  const relRows = related.length ? await sql`select topic_slug, topic_label from knowledge.article where topic_slug = any(${related})` : [];
  const relLabel = new Map(relRows.map((r: Row) => [r.topic_slug as string, r.topic_label as string]));
  const body = (a.body_markdown as string) ?? "";
  const inline = [...body.matchAll(/#(aramis|snf|regiosuisse):([A-Za-z0-9._-]+)/g)].map((m) => `${m[1]}:${m[2]}`);
  const ids = [...new Set([...(a.active_projects as string[]), ...(a.completed_projects as string[]), ...inline])];
  const projRows = ids.length ? await sql`select id, title, source, source_url from knowledge.project where id = any(${ids})` : [];
  const proj = new Map<string, Row>(projRows.map((p: Row) => [p.id as string, p]));
  const refs = (list: string[]) => list.filter((id) => proj.has(id)).map((id) => {
    const p = proj.get(id)!;
    return { id, title: p.title, source: p.source, url: p.source_url };
  });
  return {
    slug: a.topic_slug, title: a.title, label: a.topic_label, parent_topic: a.parent_topic,
    body_markdown: body, key_findings: a.key_findings,
    gaps: gaps.map((g: Row) => ({ ...g, severity: Number(g.severity ?? 0) })),
    related_topics: related.filter((s) => relLabel.has(s)).map((s) => ({ slug: s, label: relLabel.get(s) })),
    backlinks,
    active_projects: refs(a.active_projects as string[]),
    completed_projects: refs(a.completed_projects as string[]),
    funding_trend: a.funding_trend, last_compiled: a.last_compiled ?? null,
    hub_url: `${HUB}/knowledge/#/topic/${encodeURIComponent(String(a.topic_slug))}`,
  };
}

async function toolSearch(qIn: string, limit: number) {
  const q = qIn.slice(0, 200).trim();
  const prefix = orQuery(q);
  if (q.length < 2 || !prefix) return { topics: [], projects: [], note: "Give at least one word of three letters or more." };
  const topicRows = await sql`
    select topic_slug, title, topic_label, body_markdown,
           ts_rank_cd(fts, websearch_to_tsquery('english', ${q})) + ts_rank_cd(fts, to_tsquery('simple', ${prefix})) rank
    from knowledge.article
    where fts @@ websearch_to_tsquery('english', ${q}) or fts @@ to_tsquery('simple', ${prefix})
    order by rank desc limit ${limit}`;
  const projectRows = await sql`
    select id, title, institution, lead, source, budget_chf, source_url, summary, topics, start_date, end_date, status,
           ts_rank_cd(fts, websearch_to_tsquery('english', ${q})) * 2 + ts_rank_cd(fts, to_tsquery('simple', ${prefix})) rank
    from knowledge.project
    where fts @@ websearch_to_tsquery('english', ${q}) or fts @@ to_tsquery('simple', ${prefix})
    order by rank desc, start_date desc nulls last limit ${limit}`;
  return {
    topics: topicRows.map((r: Row) => ({ slug: r.topic_slug, title: r.title, label: r.topic_label, snippet: snippet(r.body_markdown as string, q) })),
    projects: projectRows.map((r: Row) => ({
      id: r.id, title: r.title, institution: r.institution || r.lead || null, source: r.source, status: r.status,
      start_date: r.start_date, end_date: r.end_date, budget_chf: num(r.budget_chf), url: r.source_url,
      snippet: snippet((r.summary as string) || (r.title as string), q),
      topics: ((r.topics as unknown[]) ?? []).filter((t) => typeof t === "string"),
    })),
  };
}

async function toolProject(id: string) {
  const [p] = await sql`select id, source, title, summary, topics, trl, funder, start_date, end_date, status, budget_chf,
                               institution, lead, partners, source_url, synced_at
                        from knowledge.project where id = ${id}`;
  if (!p) return { error: `No project '${id}'. Project ids look like aramis:12345 or snf:198765; find them with radicle_search.` };
  const articles = await sql`select topic_slug slug, topic_label label from knowledge.article
                             where active_projects ? ${id} or completed_projects ? ${id} or body_markdown like ${"%#" + id + "%"}
                             order by topic_label`;
  return { ...p, budget_chf: num(p.budget_chf), topics: ((p.topics as unknown[]) ?? []).filter((t) => typeof t === "string"),
    url: p.source_url, source_url: undefined, cited_in_topics: articles };
}

async function toolProgrammes(query: string, activeOnly: boolean, limit: number) {
  const q = orQuery(query.slice(0, 200));
  const rows = q
    ? await sql`select id, name, funder, stage, link, max_funding_chf, project_topic, impact_area, location, active_2026
                from knowledge.instrument
                where fts @@ to_tsquery('simple', ${q}) and (${!activeOnly} or active_2026 is true)
                order by ts_rank_cd(fts, to_tsquery('simple', ${q})) desc, name limit ${limit}`
    : await sql`select id, name, funder, stage, link, max_funding_chf, project_topic, impact_area, location, active_2026
                from knowledge.instrument where (${!activeOnly} or active_2026 is true)
                order by active_2026 desc nulls last, name limit ${limit}`;
  const [t] = await sql`select count(*)::int n from knowledge.instrument where (${!activeOnly} or active_2026 is true)`;
  return { total_matching_filter: t.n, shown: rows.length, programmes: rows };
}

// ------------------------------------------------------------------ MCP
const INSTRUCTIONS = [
  "Radicle is Swiss Food Research's knowledge base on Swiss agro-food and nutrition research: compiled topic articles with research gaps, about Swiss research projects from ARAMIS (federal research database), SNF (Swiss National Science Foundation) and Regiosuisse, and the funding programmes Swiss Food Research tracks. It is for SFR members.",
  "How to answer: start with radicle_topics or radicle_search, read the relevant topic with radicle_topic, open single projects with radicle_project, and use radicle_funding_programmes for funding questions.",
  "Gaps are research or innovation gaps with severity 1 (minor) to 5 (critical). Projects are cited by id (for example aramis:12345); give the project title and its url when you cite one.",
  "Answer only from what the tools return and say plainly when Radicle has nothing on a question. Funding programme details change: point people to the programme link before they apply.",
  `Each person has ${CAP} tool calls per day. Prefer one well-aimed search over many small ones.`,
].join("\n");

const str = (d: string) => ({ type: "string", description: d });
const int = (d: string) => ({ type: "integer", description: d });
const RO = { readOnlyHint: true, openWorldHint: false };
const TOOLS = [
  { name: "radicle_topics", title: "List Radicle topics", annotations: RO,
    description: "Start here. All topic articles in Radicle (slug, label, parent topic, number of projects, number of research gaps and the highest gap severity, funding trend) plus corpus totals.",
    inputSchema: { type: "object", properties: {} } },
  { name: "radicle_topic", title: "Read a topic article", annotations: RO,
    description: "One topic article: text with key findings, research gaps (severity 1-5, reason, cost range in CHF), related topics, topics linking here, and the active and completed Swiss research projects it cites.",
    inputSchema: { type: "object", required: ["slug"], properties: { slug: str("Topic slug from radicle_topics or radicle_search, e.g. fermentation or agri_economics") } } },
  { name: "radicle_search", title: "Search topics and projects", annotations: RO,
    description: "Full-text search (English, German, French) over topic articles and Swiss research projects. Returns topics with snippets and projects with institution, status, dates, budget, source and link.",
    inputSchema: { type: "object", required: ["query"], properties: { query: str("Search words"), limit: int("Results per list, 1-25, default 10") } } },
  { name: "radicle_project", title: "Open a research project", annotations: RO,
    description: "One Swiss research project: summary, funder, institution, lead and partners, dates, status, budget in CHF, technology readiness level, link to the source record, and the Radicle topics that cite it.",
    inputSchema: { type: "object", required: ["id"], properties: { id: str("Project id, e.g. aramis:12345 or snf:198765") } } },
  { name: "radicle_funding_programmes", title: "List funding programmes", annotations: RO,
    description: "Funding programmes tracked by Swiss Food Research (funder, stage, maximum funding, topic, impact area, location, link). Optional search words; by default only programmes active in 2026.",
    inputSchema: { type: "object", properties: { query: str("Optional search words, e.g. innosuisse startup packaging"),
      active_only: { type: "boolean", description: "Only programmes active in 2026 (default true)" }, limit: int("1-100, default 30") } } },
];

async function runTool(name: string, a: Record<string, unknown>) {
  switch (name) {
    case "radicle_topics": return await toolTopics();
    case "radicle_topic": return await toolTopic(clip(a.slug, 80));
    case "radicle_search": return await toolSearch(clip(a.query, 200), intArg(a.limit, 10, 1, 25));
    case "radicle_project": return await toolProject(clip(a.id, 80));
    case "radicle_funding_programmes":
      return await toolProgrammes(clip(a.query, 200), a.active_only !== false, intArg(a.limit, 30, 1, 100));
  }
  throw new Error(`Unknown tool ${name}`);
}

async function handleRpc(msg: any, email: string) {
  const id = msg.id;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const text = (t: string, isError = false) => ok({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "radicle", title: "Radicle (Swiss Food Research)", version: "1.0.0" }, instructions: INSTRUCTIONS });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? ""), args = msg.params?.arguments ?? {};
      if (!TOOLS.find((t) => t.name === name)) return fail(-32602, `Unknown tool ${name}`);
      const t = await take(email, name);
      if (t === "no_access") return text(`No access: ${email} is not (or no longer) a Swiss Food Research member address. Reconnect with your work address.`, true);
      if (t === "limit") return text(`Daily limit reached: ${CAP} Radicle calls per person per day. It resets at midnight, Zurich time.`, true);
      try {
        return text(JSON.stringify(await runTool(name, typeof args === "object" && args ? args : {})));
      } catch (e) {
        console.error("radicle tool failed", name, (e as Error).message);
        await sql`update knowledge.mcp_log set ok = false, error = ${clip((e as Error).message, 200)}
                  where id = (select max(id) from knowledge.mcp_log where email = ${email} and tool = ${name})`;
        return text("Radicle could not answer this call. Try again in a moment.", true);
      }
    }
    default:
      if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

async function mcp(req: Request) {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  let email = "";
  try { if (!m) throw new Error("missing token"); email = (await verifyOwn(m[1], "access")).sub; }
  catch (e) {
    return json({ error: "unauthorized", reason: (e as Error).message }, 401,
      { ...CORS, "WWW-Authenticate": `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource", scope="radicle"` });
  }
  let body: any;
  try { body = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const msgs = Array.isArray(body) ? body.slice(0, 20) : [body];
  const out = [];
  for (const msg of msgs) { const r = await handleRpc(msg, email); if (r) out.push(r); }
  if (!out.length) return new Response(null, { status: 202, headers: CORS });
  return json(Array.isArray(body) ? out : out[0]);
}

// ------------------------------------------------------------------ router
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/radicle-mcp/, "").replace(/\/$/, "") || "/";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: path === "/approve" ? hubCors(req) : CORS });
  try {
    if (path.startsWith("/.well-known/oauth-protected-resource")) return json(prMetadata());
    if (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration")) return json(asMetadata());
    if (path === "/register" && req.method === "POST") return await register(req);
    if (path === "/authorize" && req.method === "GET") return await authorize(url);
    if (path === "/approve" && req.method === "POST") return await approve(req);
    if (path === "/token" && req.method === "POST") return await token(req);
    if (path === "/" || path === "/mcp") {
      if (req.method === "POST") return await mcp(req);
      if (req.method === "DELETE") return new Response(null, { status: 204, headers: CORS });
      if (req.method === "GET" && !(req.headers.get("accept") ?? "").includes("text/event-stream"))
        return redirect(`${HUB}/connect/`);
      return json({ error: "use POST" }, 405, { ...CORS, Allow: "POST" });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error("radicle-mcp error", (e as Error).message);
    return json({ error: "server_error" }, 500);
  }
});
