// SFR event calendar: deck access.
//
//   GET /deck?id=<deck uuid>   signed-in visitor -> { url, filename, kind } (opens in Microsoft's viewer;
//                              &mode=download gives the one-hour download link instead)
//   GET /deck?me=1             signed-in visitor -> { email, access: "staff"|"member"|"participant"|"none", events }
//   GET /deck?health=1         anyone -> { graph: "ok" | error } (checks the Microsoft connection, no data)
//
// Access rules live in the database (events.access_reason). Microsoft credentials
// (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET) are Edge Function secrets; the app
// has Sites.Selected with read on the team2 site only.

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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ------------------------------------------------------------------ Microsoft Graph

let token: { value: string; expires: number } | null = null;

async function graphToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const tenant = Deno.env.get("MS_TENANT_ID");
  const id = Deno.env.get("MS_CLIENT_ID");
  const secret = Deno.env.get("MS_CLIENT_SECRET");
  if (!tenant || !id || !secret) throw new Error("Microsoft secrets missing");
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`token ${r.status}: ${body.error ?? ""} ${body.error_description?.split("\r\n")[0] ?? ""}`);
  token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return token.value;
}

/** Short-lived, pre-authenticated download URL for one file. */
async function downloadUrl(drive: string, item: string): Promise<string> {
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}/content`,
    { headers: { Authorization: `Bearer ${await graphToken()}` }, redirect: "manual" },
  );
  const loc = r.headers.get("location");
  if ((r.status === 302 || r.status === 303) && loc) return loc;
  throw new Error(`graph ${r.status}`);
}

/** Short-lived link that opens the file in Microsoft's browser viewer (no download, no sign-in). */
async function viewUrl(drive: string, item: string): Promise<string> {
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}/preview`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${await graphToken()}`, "Content-Type": "application/json" },
      body: "{}",
    },
  );
  const body = await r.json().catch(() => ({}));
  if (r.ok && body.getUrl) return body.getUrl;
  throw new Error(`preview ${r.status}`);
}

// ------------------------------------------------------------------ handlers

async function signedInEmail(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await auth.auth.getUser(jwt);
  if (error || !data.user?.email || !data.user.email_confirmed_at) return null;
  return data.user.email.toLowerCase();
}

async function health(req: Request): Promise<Response> {
  try {
    const [d] = await sql`select drive_id, item_id from events.deck
                          where in_web_folder and removed_at is null limit 1`;
    await downloadUrl(d.drive_id, d.item_id);
    let preview = "ok";
    try { await viewUrl(d.drive_id, d.item_id); } catch (e) { preview = String((e as Error).message); }
    return json(req, 200, { graph: "ok", preview });
  } catch (e) {
    return json(req, 503, { graph: String((e as Error).message) });
  }
}

async function me(req: Request, email: string): Promise<Response> {
  const [r] = await sql`select events.is_staff_email(${email}) staff, events.is_member_email(${email}) member`;
  if (r.staff || r.member) return json(req, 200, { email, access: r.staff ? "staff" : "member", events: "all" });
  const rows = await sql`select distinct g.event_id from events.attendee a
                         join events.attendee_group g on g.monday_group_id = a.group_id
                         where lower(a.email) = ${email} and a.has_access and g.event_id is not null`;
  const events = rows.map((x) => Number(x.event_id));
  return json(req, 200, { email, access: events.length ? "participant" : "none", events });
}

async function deck(req: Request, email: string, id: string, mode: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json(req, 400, { error: "bad_id" });
  const [d] = await sql`select d.drive_id, d.item_id, d.filename, events.access_reason(${email}, d.id) reason
                        from events.deck d where d.id = ${id}`;
  const reason: string | null = d?.reason ?? null;
  await sql`insert into events.download_log (deck_id, email, granted, reason)
            values (${d ? id : null}, ${email}, ${reason !== null}, ${reason ?? (d ? "denied" : "unknown deck")})`;
  if (!d) return json(req, 404, { error: "not_found" });
  if (!reason) return json(req, 403, { error: "no_access" });
  try {
    if (mode !== "download") {
      try {
        return json(req, 200, { url: await viewUrl(d.drive_id, d.item_id), filename: d.filename, kind: "view" });
      } catch (e) {
        console.warn("preview failed, falling back to download", id, (e as Error).message);
      }
    }
    return json(req, 200, { url: await downloadUrl(d.drive_id, d.item_id), filename: d.filename, kind: "download" });
  } catch (e) {
    console.error("deck link failed", id, (e as Error).message);
    return json(req, 502, { error: "file_unavailable" });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "GET") return json(req, 405, { error: "method" });
  const url = new URL(req.url);
  try {
    if (url.searchParams.has("health")) return await health(req);
    const email = await signedInEmail(req);
    if (!email) return json(req, 401, { error: "sign_in" });
    if (url.searchParams.has("me")) return await me(req, email);
    const id = url.searchParams.get("id");
    if (id) return await deck(req, email, id, url.searchParams.get("mode") ?? "view");
    return json(req, 400, { error: "missing_id" });
  } catch (e) {
    console.error("deck function error", (e as Error).message);
    return json(req, 500, { error: "server" });
  }
});
