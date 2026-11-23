// Starts the GitHub "Sync and publish" run (or the daily health check) on request.
//
// Callers
//   monday webhook  POST {"challenge": ...}        -> echoes the challenge (webhook set-up)
//                   POST {"event": {boardId, pulseId, type, ...}} -> sync, if the board is Events Planung
//   scheduler       POST ?source=cron&workflow=sync|health        (pg_cron via pg_net, every 30 min / daily)
//   status          GET  ?status=1  -> whether the GitHub token is set, and the last dispatches
//
// The only effect of a call is that a sync starts, at most once per MIN_GAP per workflow. That is
// harmless, so the endpoint needs no key; the GitHub token never leaves this function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, prepare: false });
const TOKEN = Deno.env.get("GITHUB_DISPATCH_TOKEN") ?? "";
const REPO = "foodinnovation/sfr-events";
const BOARDS = new Set([1689148147]);                       // Events Planung
const WORKFLOWS: Record<string, { file: string; gap: string }> = {
  sync: { file: "sync.yml", gap: "15 seconds" },   // < the ~25 s test job, so a held-back edit is still read
  health: { file: "health.yml", gap: "1 hour" },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function log(source: string, workflow: string, item: number | null, dispatched: boolean,
                   status: number | null, note: string) {
  await sql`insert into events.trigger_log (source, workflow, item_id, dispatched, status, note)
            values (${source}, ${workflow}, ${item}, ${dispatched}, ${status}, ${note})`;
  await sql`delete from events.trigger_log where at < now() - interval '60 days'`;
}

async function dispatch(source: string, workflow: string, item: number | null): Promise<Response> {
  const wf = WORKFLOWS[workflow];
  if (!wf) return json(400, { error: "unknown workflow" });
  if (!TOKEN) {
    await log(source, workflow, item, false, null, "GITHUB_DISPATCH_TOKEN not set");
    return json(503, { error: "token not set" });
  }
  const [{ ok }] = await sql`select events.claim_dispatch(${workflow}, ${wf.gap}::interval) as ok`;
  if (!ok) {
    await log(source, workflow, item, false, null, "throttled: a run was started moments ago");
    return json(200, { dispatched: false, reason: "throttled" });
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${wf.file}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "sfr-events-sync-trigger",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  const note = r.ok ? "started" : (await r.text()).slice(0, 300);
  if (!r.ok) {
    // release the claim so the next call can try again
    await sql`delete from events.trigger_log where id = (select max(id) from events.trigger_log
              where workflow = ${workflow} and source = 'claim')`;
  }
  await log(source, workflow, item, r.ok, r.status, note);
  return json(r.ok ? 200 : 502, { dispatched: r.ok, status: r.status });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.searchParams.get("status")) {
      const last = await sql`select at, source, workflow, dispatched, status, note from events.trigger_log
                             where source <> 'claim' order by at desc limit 10`;
      return json(200, { token: TOKEN ? "set" : "missing", last });
    }
    if (req.method !== "POST") return json(405, { error: "POST only" });

    const body = await req.json().catch(() => ({}));
    if (body && typeof body.challenge === "string") return json(200, { challenge: body.challenge });

    const source = url.searchParams.get("source") ?? (body?.event ? "monday" : "manual");
    const workflow = url.searchParams.get("workflow") ?? "sync";

    if (source === "monday") {
      // subitem events (programme rows) carry the subitems board; the main board is parentItemBoardId
      const ev = body?.event ?? {};
      const boards = [ev.boardId, ev.parentItemBoardId].map(Number);
      const item = Number(ev.parentItemId ?? ev.pulseId) || null;
      if (!boards.some((b) => BOARDS.has(b))) return json(200, { dispatched: false, reason: "other board" });
      return await dispatch("monday", "sync", item);
    }
    if (source === "cron") return await dispatch("cron", workflow, null);
    return await dispatch("manual", "sync", null);
  } catch (e) {
    console.error("sync-trigger", (e as Error).message);
    return json(500, { error: "internal" });
  }
});
