"""Integration test: full sync against a throwaway Postgres with stub wiki tables.

Runs only when TEST_DB_URL points at an empty database, e.g.
    TEST_DB_URL="host=/tmp/pgtest port=55432 user=postgres dbname=sfrtest" pytest tests/test_sync_db.py
"""
import os
from datetime import date, time
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")

from sync import monday as mon  # noqa: E402
from sync import run  # noqa: E402

DB = os.environ.get("TEST_DB_URL")
pytestmark = pytest.mark.skipif(not DB, reason="TEST_DB_URL not set")

STUB = """
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin; end if;
end $$;
create schema private;
create table public.ig_groups (id int primary key, name text, crm_label text);
create table public.meetings (id int primary key, ig_id int, meeting_date date, year int, slot text);
create table public.presentations (id uuid primary key default gen_random_uuid(), meeting_id int,
  onedrive_drive_id text, onedrive_item_id text, filename text, title text, file_path text,
  doc_type text, removed_at timestamptz, duplicate_of uuid);
create table public.crm_members (domain text, status text);
create table public.staff (email text, active boolean);
insert into public.ig_groups values (3,'Kaffee','Coffee'),(5,'Insekten','Insects'),(7,'Proteins4Future','Proteins4Future'),(10,'Schokolade','Chocolate');
insert into public.meetings values
  (1, 5, '2026-11-17', 2026, 'T2'),   -- 18th Insects (on monday)
  (2, 7, '2026-11-17', 2026, 'T2'),   -- 15th P4F (on monday)
  (3, 10, '2026-10-20', 2026, 'T2'),  -- joint cocoa & coffee: chocolate side
  (4, 3, '2026-10-20', 2026, 'T2'),   -- joint: coffee side
  (5, 3, '2016-05-04', 2016, null),   -- old coffee meeting, not on monday -> archive event
  (6, 3, null, null, null),           -- undated, no year: stays out
  (7, 5, null, 2026, 'T1'),           -- undated insects T1 -> 17th Meeting IG Insects
  (8, 3, null, 2015, null),           -- undated, year only -> year-only archive event
  (9, 5, null, 2026, 'T3');           -- no third insects meeting -> year-only archive
insert into public.presentations (meeting_id, onedrive_drive_id, onedrive_item_id, filename, file_path) values
  (1,'d','i1','a.pdf','05_Insekten/Treffen/2026/T2 - Präsentationen WEB/a.pdf'),
  (1,'d','i2','b.pdf','05_Insekten/Treffen/2026/T2 - intern/b.pdf'),
  (3,'d','i3','Programm.pdf','10_Schokolade/Treffen/2026/T2 - Präsentationen Web/Programm.pdf'),
  (5,'d','i4','c.pdf','03_Kaffee/Treffen/2016/Präsentationen WEB/c.pdf'),
  (7,'d','i5','e.pdf','05_Insekten/Treffen/2026/T1 - Präsentationen WEB/e.pdf'),
  (8,'d','i6','f.pdf','03_Kaffee/Treffen/2015/Präsentationen WEB/f.pdf'),
  (1,'d','i7','Teilnehmerliste.pdf','05_Insekten/Treffen/2026/T2 - Präsentationen WEB/Teilnehmerliste.pdf');
update public.presentations set doc_type = 'participant_list' where onedrive_item_id = 'i7';
insert into public.crm_members values ('member.ch','active'),('gone.ch','cancelled');
insert into public.staff values ('staff.test@swissfoodresearch.ch', true);
"""

IG, SFR, EXT, OTHER = "new_group76309", "new_group80213", "neue_gruppe8981__1", "neue_gruppe__1"


def ev(i, group, name, d, status=None, sessions=()):
    return mon.Event(i, group, group, name, d and date.fromisoformat(d), time(9), time(16),
                     "Bern", "Kurzbeschreibung " + name, "https://ti.to/x", status, list(sessions))


EVENTS = [
    ev(10, IG, "18th IG Insects", "2026-11-17", sessions=[
        mon.Session(101, "09:30", "Insekten als Futtermittel", [{"name": "A", "organisation": "X"}], True),
        mon.Session(102, "10:00", "Zweiter Vortrag", [], False)]),
    ev(11, IG, "15th Meeting of the Innovation Group Proteins4Future", "2026-11-17"),
    ev(12, IG, "59th Meeting of the IG Cocoa & Chocolate and Coffee", "2026-10-20"),
    ev(13, IG, "16th IG Coffee", "2026-10-20", status="Nicht publizieren"),
    ev(14, SFR, "Members Webinar", "2026-11-10"),
    ev(15, EXT, "Swiss Soil Day 2026", "2026-12-01", status="Bereit für Website"),
    ev(16, EXT, "FRUIT LOGISTICA", "2026-02-04"),
    ev(17, OTHER, "Newsletter Dezember", "2026-12-15"),
    ev(18, IG, "17th Meeting IG Insects", "2026-06-18"),
    ev(19, SFR, "Insect Tasting Festival", "2026-03-01"),
]
GROUPS = [
    mon.AttendeeGroup("g1", "2026-11-17 / 18th Meeting of the Innovation Group Insects"),
    mon.AttendeeGroup("g2", "2026-11-17 / 15th Meeting of Innovation Group Proteins4Future"),
    mon.AttendeeGroup("g3", "2026-07-05 / Test Event Webhooks"),
    mon.AttendeeGroup("g4", "General Assembly & Agro Food Innovation Forum 2026"),
]
ATTENDEES = [
    mon.Attendee(1, "g1", "anna@extern.ch", "Attending"),
    mon.Attendee(2, "g1", "bert@extern.ch", "no show"),
    mon.Attendee(3, "g1", "cleo@extern.ch", "Not Attending"),
    mon.Attendee(4, "g1", "dora@extern.ch", None),
    mon.Attendee(5, "g2", "emil@extern.ch", "Attending"),
]


class FakeMonday:
    def events(self):
        return [mon.Event(**{**e.__dict__, "sessions": list(e.sessions)}) for e in EVENTS]

    def groups(self, board):
        return GROUPS

    def attendees(self):
        return ATTENDEES


@pytest.fixture(scope="module")
def db(tmp_path_factory):
    admin = psycopg.connect(DB.replace("dbname=sfrtest", "dbname=postgres"), autocommit=True)
    admin.execute("drop database if exists sfrtest")
    admin.execute("create database sfrtest")
    with psycopg.connect(DB, autocommit=True) as c:
        c.execute(STUB)
        for f in sorted(Path(__file__).parents[1].joinpath("supabase/migrations").glob("*.sql")):
            c.execute(f.read_text())
    return DB


def run_sync(db, monkeypatch, tmp_path, *args):
    monkeypatch.setenv("SUPABASE_DB_URL", db)
    monkeypatch.setattr(run, "Monday", FakeMonday)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("sys.argv", ["run", "--no-translate", *args])
    assert run.main() == 0


def q(db, sql, *p):
    with psycopg.connect(db) as c:
        return c.execute(sql, p).fetchall()


def test_full_sync_twice(db, monkeypatch, tmp_path):
    run_sync(db, monkeypatch, tmp_path)
    run_sync(db, monkeypatch, tmp_path)   # idempotent

    pub = dict(q(db, "select title_src, published from events.event where source='monday'"))
    assert pub["18th IG Insects"] and pub["Members Webinar"] and pub["Swiss Soil Day 2026"]
    assert not pub["16th IG Coffee"] and not pub["FRUIT LOGISTICA"]
    assert "Newsletter Dezember" not in pub

    links = dict(q(db, """select em.meeting_id, e.title_src from events.event_meeting em
                          join events.event e on e.id = em.event_id"""))
    assert links[1] == "18th IG Insects"
    assert links[2].startswith("15th Meeting")
    assert links[3] == links[4] == "59th Meeting of the IG Cocoa & Chocolate and Coffee"
    assert links[5] == "Innovation Group Coffee"            # archive event from the wiki
    assert links[7] == "17th Meeting IG Insects"            # T1 by slot, festival skipped
    assert 6 not in links
    methods = dict(q(db, "select meeting_id, method from events.event_meeting"))
    assert methods[7] == "ig_slot" and methods[8] == "wiki_year" and methods[9] == "wiki_year"
    assert q(db, "select event_date, event_year from events.event e join events.event_meeting em "
                 "on em.event_id = e.id where em.meeting_id = 8")[0] == (None, 2015)
    assert q(db, "select count(*) from events.event where source='wiki'")[0][0] == 3

    decks = dict(q(db, "select item_id, in_web_folder from events.deck"))
    assert decks == {"i1": True, "i2": False, "i3": True, "i4": True, "i5": True, "i6": True, "i7": True}
    assert q(db, "select doc_type from events.deck where item_id='i7'")[0][0] == "participant_list"
    assert q(db, "select is_programme from events.deck where item_id='i3'")[0][0]

    groups = dict(q(db, "select monday_group_id, match_method from events.attendee_group"))
    assert groups == {"g1": "date_name", "g2": "date_name", "g3": "excluded", "g4": "none"}

    assert q(db, "select count(*) from events.session")[0][0] == 2
    assert q(db, "select count(*) from events.sync_run where ok")[0][0] == 2


@pytest.mark.parametrize("email,item,reason", [
    ("someone@member.ch", "i1", "member"),
    ("someone@MEMBER.ch", "i4", "member"),            # archive deck, member
    ("staff.test@swissfoodresearch.ch", "i1", "staff"),
    ("anna@extern.ch", "i1", "participant"),           # attended
    ("dora@extern.ch", "i1", "participant"),           # blank status keeps access
    ("bert@extern.ch", "i1", None),                    # no show
    ("cleo@extern.ch", "i1", None),                    # cancelled
    ("anna@extern.ch", "i4", None),                    # archive deck: members only
    ("emil@extern.ch", "i1", None),                    # other event's participant
    ("x@gone.ch", "i1", None),                         # cancelled member
    ("someone@member.ch", "i2", None),                 # not in a web folder
    ("someone@member.ch", "i7", None),                 # participant list: never served
    ("staff.test@swissfoodresearch.ch", "i7", None),        # not even to staff
])
def test_access_rules(db, monkeypatch, tmp_path, email, item, reason):
    if not q(db, "select 1 from events.deck limit 1"):
        run_sync(db, monkeypatch, tmp_path)
    got = q(db, "select events.access_reason(%s, d.id) from events.deck d where d.item_id = %s",
            email, item)[0][0]
    assert got == reason


def test_sign_up_gate(db):
    ok = lambda e: q(db, "select events.may_sign_up(%s)", e)[0][0]  # noqa: E731
    assert ok("a@member.ch") and ok("anna@extern.ch") and ok("staff.test@swissfoodresearch.ch")
    assert not ok("bert@extern.ch") and not ok("random@gmail.com")


def test_dry_run_changes_nothing(db, monkeypatch, tmp_path):
    before = q(db, "select count(*) from events.sync_run")[0][0]
    EVENTS.append(ev(99, IG, "Dry run event", "2027-01-01"))
    try:
        run_sync(db, monkeypatch, tmp_path, "--dry-run")
    finally:
        EVENTS.pop()
    assert q(db, "select count(*) from events.event where title_src='Dry run event'")[0][0] == 0
    assert q(db, "select count(*) from events.sync_run")[0][0] == before


def test_claim_dispatch_throttles_bursts(db):
    with psycopg.connect(db, autocommit=True) as c:
        claim = lambda: c.execute("select events.claim_dispatch('sync', '30 seconds')").fetchone()[0]
        assert claim() is True
        assert claim() is False                                  # second edit in the same burst
        c.execute("update events.trigger_log set at = now() - interval '1 minute'")
        assert claim() is True                                   # later edit starts a new run
        assert c.execute("select events.claim_dispatch('health', '1 hour')").fetchone()[0] is True


def test_page_builds_from_synced_data(db, tmp_path):
    """The builder must run end to end on real synced data (load, slugs, pages)."""
    from datetime import date as _date
    from web import build as b
    with psycopg.connect(db) as c:
        b.assign_slugs(c, False)
        events = b.load(c)
    assert events, "the earlier sync tests should have left events to build"
    b.build(tmp_path / "site", events, _date(2026, 11, 23))
    pages = list((tmp_path / "site" / "events").glob("*/index.html"))
    assert pages and (tmp_path / "site" / "index.html").is_file()
    assert any("Presentations" in p.read_text() for p in pages)


def test_knowledge_write_and_access(db):
    from sync import knowledge as k
    radicle = {
        "articles": [("soil", "Soil", "environment", "Soil health", "## Intro\nText.",
                      ["finding"], ["water"], ["snf:1"], [], "increasing", "2026-07-15")],
        "projects": [("snf:1", "snf", "Soil microbes", "A summary about soil microbes.", ["soil"], 4,
                      "SNF", "2024-01-01", "2027-12-31", "running", 450000.0, "ETH", "Jane Doe", None,
                      "https://p3.snf.ch/project-1")],
        "gaps": [("g1", "soil", "No long-term soil carbon trials in the Jura.", 4, "1-2 M", "evidence", "unexplored")],
    }
    inst = [dict(id="9", name="Innovation project", funder="Innosuisse", stage=None, link=None,
                 max_funding_chf=None, project_topic="any", impact_area=None, location="CH", active_2026=True)]
    with psycopg.connect(db) as c, c.cursor() as cur:
        report = {}
        cur.execute("set role events_job")            # the job's own rights: RLS applies, no COPY
        k.write(cur, radicle, inst, report)
        k.write(cur, radicle, inst, report)          # idempotent: replaces, never duplicates
        assert report["counts"]["knowledge_projects"] == 1
        cur.execute("select count(*) from knowledge.project where fts @@ to_tsquery('english', 'microbe')")
        assert cur.fetchone()[0] == 1
        cur.execute("select count(*) from knowledge.contact where fallback")
        assert cur.fetchone()[0] == 1
        cur.execute("reset role")
        # members and staff read; participants and strangers do not
        for email, ok in [("a@member.ch", True), ("staff.test@swissfoodresearch.ch", True),
                          ("anna@extern.ch", False), ("x@gone.ch", False), ("x@gmail.com", False)]:
            cur.execute("select knowledge.can_read(%s)", [email])
            assert cur.fetchone()[0] is ok, email
        # monday hiccup (no instruments read) keeps the previous instruments
        cur.execute("set role events_job")
        k.write(cur, None, [], report)
        cur.execute("select count(*) from knowledge.instrument")
        assert cur.fetchone()[0] == 1
        c.rollback()
