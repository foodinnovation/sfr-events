// Pulse tab of the SFR hub.
//   GET  /pulse?days=14            stories of the last days (max 60), newest first within relevance
//   GET  /pulse?item=<id>          the story holding that item, with all its reports
//   POST /pulse {item, on}         a signed-in member or staff marks a story useful (on=false withdraws)
// pulse.setting 'public' says who reads Pulse: 'true' everyone, 'members' signed-in members and staff,
// anything else signed-in staff only (the shadow run).
// Stories come from schema "pulse", filled by foodinnovation/sfr-pulse; only what pulse.hub_stories
// allows leaves the database (relevant items with a clean link from open or allowed sources).

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin",
    "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

type Who = { email: string | null; role: "staff" | "member" | "other" | "visitor" };

async function who(req: Request): Promise<Who> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.startsWith("sb_")) return { email: null, role: "visitor" };
  const { data } = await auth.auth.getUser(jwt);
  const email = data.user?.email_confirmed_at ? data.user.email!.toLowerCase() : null;
  if (!email) return { email: null, role: "visitor" };
  const [r] = await sql`select events.is_staff_email(${email}) staff, events.is_member_email(${email}) member`;
  return { email, role: r.staff ? "staff" : r.member ? "member" : "other" };
}

const ITEM = /^[0-9a-f]{16}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json(req, 204, null);
  try {
    const me = await who(req);
    const [s] = await sql`select value from pulse.setting where key = 'public'`;
    const audience = s?.value === "true" ? "public" : s?.value === "members" ? "members" : "staff";
    const isPublic = audience === "public";
    const insider = me.role === "member" || me.role === "staff";
    const canRead = isPublic || me.role === "staff" || (audience === "members" && insider);
    const closed = () => audience === "members"
      ? json(req, me.email ? 403 : 401, { detail: "members_only", role: me.role })
      : json(req, me.email ? 403 : 401, { detail: "not_open_yet", role: me.role });

    if (req.method === "POST") {
      if (!insider) return json(req, me.email ? 403 : 401, { detail: "members_only" });
      if (!canRead) return closed();
      const body = await req.json().catch(() => ({}));
      const item = String(body.item ?? "");
      if (!ITEM.test(item)) return json(req, 400, { detail: "item" });
      const [v] = await sql`select pulse.hub_vote(${item}, ${me.email}, ${body.on !== false}) n`;
      return json(req, 200, { item, votes: v.n, mine: body.on !== false });
    }

    if (req.method !== "GET") return json(req, 405, { detail: "method" });
    if (!canRead) return closed();
    const url = new URL(req.url);
    const item = url.searchParams.get("item");
    if (item !== null && !ITEM.test(item)) return json(req, 400, { detail: "item" });
    const days = Math.max(1, Math.min(60, parseInt(url.searchParams.get("days") ?? "14", 10) || 14));
    const [r] = await sql`select pulse.hub_stories(${days}, ${me.email}, ${item}) j`;
    const stories = r.j ?? [];
    if (item !== null && !stories.length) return json(req, 404, { detail: "not_found" });
    return json(req, 200, { public: isPublic, audience, role: me.role, can_vote: insider, days, stories });
  } catch (e) {
    console.error("pulse failed", (e as Error).message);
    return json(req, 500, { detail: "server" });
  }
});
