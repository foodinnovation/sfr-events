// SFR hub usage counting. Browsers send small batches with navigator.sendBeacon (text/plain, so no
// preflight). Stored per action: time, kind, page path, a short reference, the visitor's role,
// the referring domain and mobile or not. No IP address, email, cookie or visitor id is stored.
// Rows older than 13 months are purged nightly (events.purge_old_usage).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, prepare: false });
const KINDS = new Set(["view", "register", "ad_view", "ad_click", "mail_click", "search", "filter",
  "kn_topic", "kn_search", "kn_finder", "home_click", "booking_open", "svc_click",
  "pl_story", "pl_source", "pl_vote", "pl_filter", "pl_search"]);
const ROLES = new Set(["visitor", "participant", "member", "staff"]);
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|monitor/i;
const HOSTS = /^(foodinnovation\.github\.io|hub\.swissfoodresearch\.ch|localhost(:\d+)?)$/;

// crude per-instance guard against floods
let windowStart = Date.now(), inWindow = 0;

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "") || null;

export function clean(e: Record<string, unknown>) {
  const kind = String(e.k ?? "");
  if (!KINDS.has(kind)) return null;
  let page = clip(e.p, 160) ?? "/";
  page = page.split(/[?#]/)[0];
  let ref = clip(e.r, 120);
  if (ref && /@/.test(ref)) ref = null;                       // never an email address
  if ((kind === "search" || kind === "pl_search") && (!ref || ref.length < 3)) return null;   // no term, no row
  const role = ROLES.has(String(e.o)) ? String(e.o) : "visitor";
  let source: string | null = null;
  try {
    const h = e.s ? new URL(String(e.s)).hostname.toLowerCase() : "";
    source = h && !HOSTS.test(h) ? h.slice(0, 100) : null;
  } catch { source = null; }
  return { kind, page, ref, role, source, mobile: e.m === true };
}

Deno.serve(async (req: Request) => {
  const ok = new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
  if (req.method === "OPTIONS") return ok;
  if (req.method !== "POST") return new Response(null, { status: 405 });
  if (BOT.test(req.headers.get("user-agent") ?? "")) return ok;
  const origin = req.headers.get("origin") ?? "";
  try {
    if (origin && !HOSTS.test(new URL(origin).host)) return ok;
  } catch { return ok; }
  const text = await req.text();
  if (text.length > 4000) return new Response(null, { status: 413 });
  let batch: unknown;
  try { batch = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
  const rows = (Array.isArray(batch) ? batch : [batch]).slice(0, 20)
    .map((e) => (e && typeof e === "object" ? clean(e as Record<string, unknown>) : null))
    .filter((r): r is NonNullable<ReturnType<typeof clean>> => r !== null);
  if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); inWindow = 0; }
  inWindow += rows.length;
  if (!rows.length || inWindow > 600) return ok;
  try {
    await sql`insert into events.metric ${sql(rows, "kind", "page", "ref", "role", "source", "mobile")}`;
  } catch (e) {
    console.error("metric insert failed", (e as Error).message);
  }
  return ok;
});
