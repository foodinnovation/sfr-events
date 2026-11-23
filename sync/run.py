"""Sync monday -> Supabase (events schema) for the SFR event calendar.

Usage:
    python -m sync.run                 # sync and commit
    python -m sync.run --dry-run       # do everything, then roll back
    python -m sync.run --no-translate  # skip the Claude translation step

Environment: MONDAY_TOKEN, SUPABASE_DB_URL, optional ANTHROPIC_API_KEY.
Writes report.md and report.json (event names and match results only, no
personal data) to the working directory.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from collections import defaultdict
from datetime import date

import psycopg
from psycopg.types.json import Jsonb

from . import translate
from .monday import ATTENDEES_BOARD, Monday
from .rules import (
    Candidate, detect_igs, is_published, kind_for_group, match_group, meeting_igs,
    parse_group_title, text_hash,
)

MAX_TRANSLATIONS_PER_RUN = int(os.environ.get("MAX_TRANSLATIONS_PER_RUN", "80"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-translate", action="store_true")
    args = ap.parse_args()

    mon = Monday()
    print("reading monday ...", flush=True)
    events = mon.events()
    groups = mon.groups(ATTENDEES_BOARD)
    attendees = mon.attendees()
    print(f"  {len(events)} items on Events Planung, {len(groups)} attendee groups, "
          f"{len(attendees)} registrations", flush=True)

    report: dict = {"today": date.today().isoformat(), "dry_run": args.dry_run}
    with psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=False) as conn:
        run_id = None
        if not args.dry_run:
            with conn.cursor() as cur:
                cur.execute("insert into events.sync_run (mode) values (%s) returning id", ["sync"])
                run_id = cur.fetchone()[0]
            conn.commit()
        try:
            with conn.cursor() as cur:
                sync_events(cur, events, report)
                link_meetings(cur, events, report)
                sync_decks(cur, report)
                sync_attendees(cur, groups, attendees, report)
                if not args.no_translate and translate.available():
                    translate_texts(cur, report)
                else:
                    report["translated"] = "skipped"
                summarise(cur, report)
            if args.dry_run:
                conn.rollback()
                print("dry run: rolled back", flush=True)
            else:
                with conn.cursor() as cur:
                    cur.execute(
                        "update events.sync_run set finished_at=now(), ok=true, summary=%s where id=%s",
                        [Jsonb(report["counts"]), run_id])
                conn.commit()
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            if run_id:
                with conn.cursor() as cur:
                    cur.execute(
                        "update events.sync_run set finished_at=now(), ok=false, error=%s where id=%s",
                        [traceback.format_exc()[-4000:], run_id])
                conn.commit()
            print(f"sync failed: {exc}", file=sys.stderr)
            raise

    write_report(report)
    print(json.dumps(report["counts"], indent=1))
    return 0


# --------------------------------------------------------------------------- events

def sync_events(cur, events, report):
    seen, skipped = [], 0
    for e in events:
        kind = kind_for_group(e.group_id)
        if kind is None:
            skipped += 1
            continue
        igs = detect_igs(e.name)
        thash = text_hash(e.name, e.summary, *[s.title for s in e.sessions])
        cur.execute(
            """
            insert into events.event (source, monday_item_id, monday_group, kind, ig_id, title_src,
                summary_src, event_date, start_time, end_time, location, signup_url,
                website_status, published, text_hash, synced_at, removed_at)
            values ('monday', %(id)s, %(group)s, %(kind)s, %(ig)s, %(title)s, %(summary)s, %(date)s,
                %(start)s, %(end)s, %(loc)s, %(url)s, %(status)s, %(pub)s, %(hash)s, now(), null)
            on conflict (monday_item_id) do update set
                monday_group = excluded.monday_group, kind = excluded.kind, ig_id = excluded.ig_id,
                title_src = excluded.title_src, summary_src = excluded.summary_src,
                event_date = excluded.event_date, start_time = excluded.start_time,
                end_time = excluded.end_time, location = excluded.location,
                signup_url = excluded.signup_url, website_status = excluded.website_status,
                published = excluded.published, text_hash = excluded.text_hash,
                synced_at = now(), removed_at = null
            returning id
            """,
            dict(id=e.monday_item_id, group=e.group_title, kind=kind, ig=igs[0] if igs else None,
                 title=e.name, summary=e.summary, date=e.event_date, start=e.start_time,
                 end=e.end_time, loc=e.location, url=e.signup_url, status=e.website_status,
                 pub=is_published(kind, e.event_date, e.website_status), hash=thash),
        )
        event_id = cur.fetchone()[0]
        e.db_id = event_id
        seen.append(e.monday_item_id)

        sub_ids = []
        for s in e.sessions:
            cur.execute(
                """
                insert into events.session (monday_subitem_id, event_id, start_time, title_src,
                    speakers, consent, text_hash)
                values (%s, %s, %s, %s, %s, %s, %s)
                on conflict (monday_subitem_id) do update set event_id = excluded.event_id,
                    start_time = excluded.start_time, title_src = excluded.title_src,
                    speakers = excluded.speakers, consent = excluded.consent,
                    text_hash = excluded.text_hash
                """,
                [s.monday_subitem_id, event_id, s.start_time, s.title, Jsonb(s.speakers),
                 s.consent, text_hash(s.title)],
            )
            sub_ids.append(s.monday_subitem_id)
        cur.execute(
            "delete from events.session where event_id = %s and not (monday_subitem_id = any(%s))",
            [event_id, sub_ids])

    cur.execute(
        """update events.event set removed_at = now(), published = false
           where source = 'monday' and removed_at is null and not (monday_item_id = any(%s))""",
        [seen])
    report.setdefault("counts", {})["monday_events"] = len(seen)
    report["counts"]["monday_items_not_events"] = skipped
    report["counts"]["monday_events_removed"] = cur.rowcount


# --------------------------------------------------------------------------- wiki meetings

def link_meetings(cur, events, report):
    """Link monday events to the wiki's meetings (same IG, same date); turn every
    remaining dated wiki meeting into an archive event of its own."""
    cur.execute("select id, ig_id, meeting_date from public.meetings where meeting_date is not null")
    by_date = defaultdict(list)
    for mid, ig, d in cur.fetchall():
        by_date[d].append((mid, ig))

    wanted: dict[int, tuple] = {}   # meeting_id -> (event, priority)
    conflicts = []
    for e in events:
        if not getattr(e, "db_id", None) or not e.event_date:
            continue
        kind = kind_for_group(e.group_id)
        if kind not in ("ig", "sfr"):
            continue
        igs = meeting_igs(detect_igs(e.name))
        if not igs:
            continue
        prio = 0 if kind == "ig" else 1
        for mid, ig in by_date.get(e.event_date, []):
            if ig not in igs:
                continue
            if mid in wanted:
                other, oprio = wanted[mid]
                conflicts.append(f"{e.event_date}: '{e.name}' and '{other.name}' both fit one wiki meeting")
                if prio >= oprio:
                    continue
            wanted[mid] = (e, prio)

    for mid, (e, _) in wanted.items():
        cur.execute(
            """insert into events.event_meeting (event_id, meeting_id, method) values (%s, %s, 'ig_date')
               on conflict (meeting_id) do update set event_id = excluded.event_id, method = 'ig_date'
               where events.event_meeting.method <> 'manual'""",
            [e.db_id, mid])
    # links that no longer fit (date or name changed on monday)
    cur.execute(
        "delete from events.event_meeting where method = 'ig_date' and not (meeting_id = any(%s))",
        [list(wanted)])

    # archive events for dated meetings without a monday event, one per meeting
    cur.execute(
        """select m.id, m.ig_id, m.meeting_date, coalesce(g.crm_label, g.name)
           from public.meetings m join public.ig_groups g on g.id = m.ig_id
           where m.meeting_date is not null
             and not exists (select 1 from events.event_meeting em where em.meeting_id = m.id)""")
    for mid, ig, d, ig_name in cur.fetchall():
        title = f"Innovation Group {ig_name}"
        cur.execute(
            """insert into events.event (source, kind, ig_id, title_src, title_en, event_date,
                   published, text_hash, translated_hash)
               values ('wiki', 'ig', %s, %s, %s, %s, true, 'wiki', 'wiki') returning id""",
            [ig, title, title, d])
        cur.execute("insert into events.event_meeting (event_id, meeting_id, method) "
                    "values (%s, %s, 'wiki_only')", [cur.fetchone()[0], mid])
    # archive events whose meeting moved to a monday event
    cur.execute(
        """delete from events.event e where e.source = 'wiki'
           and not exists (select 1 from events.event_meeting em where em.event_id = e.id)""")

    cur.execute("select count(*) from public.meetings where meeting_date is null")
    report["counts"]["wiki_meetings_linked_to_monday"] = len(wanted)
    report["counts"]["wiki_meetings_without_date"] = cur.fetchone()[0]
    report["meeting_conflicts"] = conflicts


# --------------------------------------------------------------------------- decks

def sync_decks(cur, report):
    """IG decks come from the wiki's index. A deck counts as cleared when it sits
    in a folder whose name contains 'web' (e.g. 'T1 - Präsentationen WEB')."""
    cur.execute(
        """
        insert into events.deck (event_id, source, presentation_id, drive_id, item_id, filename,
                                 title, file_path, in_web_folder, is_programme, removed_at)
        select em.event_id, 'wiki', p.id, p.onedrive_drive_id, p.onedrive_item_id, p.filename,
               p.title, p.file_path,
               regexp_replace(p.file_path, '/[^/]*$', '') ~* 'web',
               coalesce(p.filename, '') ~* 'programm' or coalesce(p.doc_type, '') ~* 'program',
               p.removed_at
        from public.presentations p
        join events.event_meeting em on em.meeting_id = p.meeting_id
        where p.onedrive_drive_id is not null and p.onedrive_item_id is not null
          and p.duplicate_of is null
        on conflict (presentation_id) do update set
            event_id = excluded.event_id, drive_id = excluded.drive_id, item_id = excluded.item_id,
            filename = excluded.filename, title = excluded.title, file_path = excluded.file_path,
            in_web_folder = excluded.in_web_folder, is_programme = excluded.is_programme,
            removed_at = excluded.removed_at
        """)
    report["counts"]["decks_upserted"] = cur.rowcount
    cur.execute(
        """update events.deck d set event_id = null
           where d.source = 'wiki' and d.event_id is not null and not exists (
               select 1 from public.presentations p
               join events.event_meeting em on em.meeting_id = p.meeting_id
               where p.id = d.presentation_id)""")


# --------------------------------------------------------------------------- attendees

def sync_attendees(cur, groups, attendees, report):
    cur.execute(
        """select id, title_src, event_date, kind from events.event
           where removed_at is null and source = 'monday' and event_date is not null""")
    candidates = [Candidate(r[0], r[1], r[2], r[3]) for r in cur.fetchall()]

    cur.execute("select monday_group_id, match_method from events.attendee_group")
    locked = {gid for gid, m in cur.fetchall() if m in ("manual", "excluded")}

    rows = []
    for g in groups:
        if g.monday_group_id in locked:
            cur.execute("update events.attendee_group set title = %s, synced_at = now() "
                        "where monday_group_id = %s", [g.title, g.monday_group_id])
            continue
        m = match_group(g.title, candidates)
        gdate, _ = parse_group_title(g.title)
        cur.execute(
            """insert into events.attendee_group (monday_group_id, title, group_date, event_id,
                   match_method, match_note, synced_at)
               values (%s, %s, %s, %s, %s, %s, now())
               on conflict (monday_group_id) do update set title = excluded.title,
                   group_date = excluded.group_date, event_id = excluded.event_id,
                   match_method = excluded.match_method, match_note = excluded.match_note,
                   reviewed = case when events.attendee_group.event_id is distinct from excluded.event_id
                                   then false else events.attendee_group.reviewed end,
                   synced_at = now()""",
            [g.monday_group_id, g.title, gdate, m.event_key, m.method,
             "; ".join(filter(None, [m.note, " | ".join(m.candidates) if m.method != "date" else ""]))
             or None])
        rows.append({"group": g.title, "method": m.method, "event_id": m.event_key,
                     "note": m.note, "candidates": m.candidates})
    cur.execute("delete from events.attendee_group where not (monday_group_id = any(%s))",
                [[g.monday_group_id for g in groups]])

    cur.execute("create temp table tmp_att (monday_item_id bigint, group_id text, email text, "
                "status_raw text) on commit drop")
    with cur.copy("copy tmp_att (monday_item_id, group_id, email, status_raw) from stdin") as cp:
        for a in attendees:
            cp.write_row((a.monday_item_id, a.group_id, a.email, a.status_raw))
    cur.execute(
        """insert into events.attendee (monday_item_id, group_id, email, status_raw, synced_at)
           select t.monday_item_id, t.group_id, t.email, t.status_raw, now()
           from tmp_att t join events.attendee_group g on g.monday_group_id = t.group_id
           on conflict (monday_item_id) do update set group_id = excluded.group_id,
               email = excluded.email, status_raw = excluded.status_raw, synced_at = now()""")
    cur.execute("delete from events.attendee a where not exists "
                "(select 1 from tmp_att t where t.monday_item_id = a.monday_item_id)")
    cur.execute("drop table tmp_att")

    report["attendee_groups"] = rows
    report["counts"]["attendee_groups"] = len(groups)
    report["counts"]["registrations"] = len(attendees)


# --------------------------------------------------------------------------- translation

def translate_texts(cur, report):
    """Translate published monday events whose text changed since the last translation."""
    cur.execute(
        """select id, title_src, summary_src, text_hash from events.event
           where source = 'monday' and published and removed_at is null
             and text_hash is distinct from translated_hash
           order by event_date desc nulls last limit %s""",
        [MAX_TRANSLATIONS_PER_RUN])
    done = 0
    for eid, title, summary, thash in cur.fetchall():
        cur.execute("select monday_subitem_id, title_src from events.session where event_id = %s",
                    [eid])
        sessions = cur.fetchall()
        fields = {"title": title, "summary": summary}
        fields.update({f"s{sid}": t for sid, t in sessions})
        out = translate.translate(fields)
        cur.execute("update events.event set title_en = %s, summary_en = %s, translated_hash = %s "
                    "where id = %s", [out["title"], out["summary"], thash, eid])
        for sid, _ in sessions:
            cur.execute("update events.session set title_en = %s, translated_hash = text_hash "
                        "where monday_subitem_id = %s", [out[f"s{sid}"], sid])
        done += 1
    report["counts"]["translated"] = done


# --------------------------------------------------------------------------- report

def summarise(cur, report):
    cur.execute(
        """select kind, count(*) filter (where published), count(*) filter (where not published)
           from events.event where removed_at is null group by kind order by kind""")
    report["counts"]["by_kind"] = {k: {"published": p, "hidden": h} for k, p, h in cur.fetchall()}
    cur.execute(
        """select e.event_date, e.kind, e.title_src, e.website_status
           from events.event e where e.published and e.removed_at is null
             and e.event_date >= current_date order by e.event_date""")
    report["upcoming_published"] = [
        {"date": d.isoformat(), "kind": k, "title": t, "status": s} for d, k, t, s in cur.fetchall()]
    cur.execute(
        """select count(*), count(*) filter (where in_web_folder), count(distinct event_id)
           from events.deck where removed_at is null and event_id is not null""")
    n, web, ev = cur.fetchone()
    report["counts"]["decks_linked"] = n
    report["counts"]["decks_cleared"] = web
    report["counts"]["events_with_decks"] = ev
    cur.execute("select count(*) from events.event where source = 'wiki'")
    report["counts"]["archive_events_from_wiki"] = cur.fetchone()[0]
    cur.execute(
        """select count(*), count(*) filter (where a.has_access)
           from events.attendee a join events.attendee_group g on g.monday_group_id = a.group_id
           where g.event_id is not null""")
    n, ok = cur.fetchone()
    report["counts"]["registrations_on_matched_events"] = n
    report["counts"]["registrations_with_access"] = ok


def write_report(report):
    with open("report.json", "w") as f:
        json.dump(report, f, indent=1, default=str, ensure_ascii=False)
    lines = [f"# Sync report {report['today']}" + (" (dry run)" if report.get("dry_run") else ""), ""]
    lines += [f"- {k}: {v}" for k, v in report["counts"].items()]
    lines += ["", "## Attendee groups", "", "| Group | Match | Note |", "|---|---|---|"]
    for r in report.get("attendee_groups", []):
        lines.append(f"| {r['group']} | {r['method']} | {r['note'] or ''} |")
    if report.get("meeting_conflicts"):
        lines += ["", "## Wiki meeting conflicts", ""] + [f"- {c}" for c in report["meeting_conflicts"]]
    lines += ["", "## Upcoming published events", ""]
    lines += [f"- {u['date']} [{u['kind']}] {u['title']}" for u in report.get("upcoming_published", [])]
    with open("report.md", "w") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
