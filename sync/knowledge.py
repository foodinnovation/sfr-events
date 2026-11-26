"""Radicle – Knowledge: copy what the hub's knowledge tab shows into ig-wiki (schema knowledge).

Sources
  radicle (Supabase project 'radicle', read-only login knowledge_reader)
      wiki_articles        -> knowledge.article
      projects (passed)    -> knowledge.project   (the ~6,600 projects the articles cite)
      white_spots          -> knowledge.gap       (used by the funding finder)
  monday board 'Funding Schemes' (1737639790) -> knowledge.instrument
  CONTACTS below          -> knowledge.contact   (routing only; no email addresses)

Each table is replaced in one transaction, so the page never sees a half-copied state.
Without RADICLE_DB_PASSWORD the radicle part is skipped and only the instruments refresh.
"""
from __future__ import annotations

import os
import re
from urllib.parse import unquote

import psycopg
from psycopg.types.json import Jsonb

FUNDING_BOARD = 1737639790
RADICLE_REF = "wrwpuwgilaeumcjudtbr"
RADICLE_USER = f"knowledge_reader.{RADICLE_REF}"
# The pooler host differs between older and newer Supabase projects; try both.
RADICLE_HOSTS = [h for h in (os.environ.get("RADICLE_DB_HOST"),
                             "aws-0-eu-west-1.pooler.supabase.com",
                             "aws-1-eu-west-1.pooler.supabase.com") if h]

# Instrument columns on Funding Schemes (radicle reads the first eight: src/connectors/funding_instruments.py)
ACTIVE_COL = "color_mky8wv9"          # "Active in check year": yes / likely / no / unclear
INST_COLS = {
    "text_mkxwas09": "funder", "drop_down_Mjj3p6VO": "stage", "dropdown_mky8chs3": "location",
    "text_mkya77zc": "link", "text_Mjj3wdkj": "max_funding_chf", "text_Mjj3ZlYt": "project_topic",
    "dropdown_mky1v9rk": "impact_area", ACTIVE_COL: "status",
    "color_mm4x9nkz": "funding_type", "color_mm4xd6af": "deadline_type",
    "date_mm4x76e9": "opens_on", "date_mm4xyrmk": "deadline", "date_mm4xdqb6": "verified_on",
}
OLD_GROUP = "topics"                  # group "Funding Schemes - old version": not shown
STATUSES = ("yes", "likely", "no", "unclear")

# Who to talk to, by topic slug and keyword (from radicle's config/contacts.yaml).
CONTACTS = [
    dict(key="leila", name="Leila Pamingle", role="Innovation Manager",
         topics=["fermentation", "food_quality", "food_authenticity", "dairy_processing", "food_additives",
                 "food_preservation", "minimal_processing", "microbiological_safety", "contaminants"],
         keywords=["chocolate", "coffee", "cacao", "cocoa", "confectionery", "roasting", "aroma",
                   "flavour", "flavor"]),
    dict(key="jan", name="Jan Biehl", role="Strategic Innovation & Scaling",
         topics=["novel_foods", "circular_bioeconomy", "nutrition", "dietary_patterns", "functional_foods",
                 "metabolic_health", "food_systems_health", "food_processing", "soil_biology", "biocontrol",
                 "sustainable_diets", "food_waste", "food_systems", "food_sovereignty"],
         keywords=["fungi", "mushroom", "mycelium", "protein", "alternative protein", "fermentation",
                   "bioconversion", "scaling", "upcycling", "nutrition", "microbiome"]),
    dict(key="helene", name="Helene Renaux", role="Innovation Manager", topics=[], keywords=[]),
    dict(key="fabian", name="Fabian Bättig", role="Innovation Manager", topics=[], keywords=[]),
    dict(key="lucas", name="Dr. Lucas Grob", role="CEO", topics=[], keywords=[], fallback=True),
]


def radicle_password() -> str | None:
    pw = (os.environ.get("RADICLE_DB_PASSWORD") or "").strip().strip("'\"").strip()
    if "://" in pw:          # a whole connection string pasted as the password
        m = re.match(r"^[a-z]+://[^:/@]+:\[?(.*?)\]?@[^@]+$", pw)
        pw = unquote(m.group(1)) if m else ""
    return pw.removeprefix("[").removesuffix("]") or None


def radicle_connect(password: str):
    last = None
    for host in RADICLE_HOSTS:
        try:
            return psycopg.connect(host=host, port=5432, dbname="postgres", user=RADICLE_USER,
                                   password=password, sslmode="require", connect_timeout=15)
        except psycopg.OperationalError as exc:   # wrong host for this project: try the next
            last = exc
    raise last


# --------------------------------------------------------------------------- readers

def read_radicle(conn) -> dict:
    with conn.cursor() as cur:
        cur.execute("""select topic_slug, topic_label, parent_topic, title, body_markdown,
                              coalesce(key_findings, '[]'), coalesce(related_topics, '[]'),
                              coalesce(active_projects, '[]'), coalesce(completed_projects, '[]'),
                              funding_trend, last_compiled
                       from public.wiki_articles
                       where coalesce(body_markdown, '') <> ''""")
        articles = cur.fetchall()
        cur.execute("""select id, source, coalesce(title_en, title_de, title_fr, title_it, project_number, id),
                              coalesce(summary_en, abstract_en), coalesce(topics, '[]'), trl, funder,
                              start_date, end_date, status, budget_chf, responsible_applicant,
                              scientific_lead, industry_partners, source_url
                       from public.projects where stage_gate = 'passed'""")
        projects = cur.fetchall()
        cur.execute("""select spot_id, topic_slug, description, nullif(severity, '')::int,
                              cost_range_chf, evidence_block, gap_reason
                       from public.white_spots
                       where not coalesce(dismissed, false) and coalesce(description, '') <> ''""")
        gaps = cur.fetchall()
    return {"articles": articles, "projects": projects, "gaps": gaps}


def parse_instrument(item: dict, check_year: int | None = None) -> dict:
    """One Funding Schemes item. Active means the board says yes or likely for the check year and the
    call is not marked closed; a 'ja' from older entries counts as yes."""
    cols = {c["id"]: (c.get("text") or "").strip() for c in item.get("column_values", [])}
    row = {field: (cols.get(cid) or None) for cid, field in INST_COLS.items()}
    status = (row["status"] or "").lower()
    status = "yes" if status in ("ja", "active", "yes") or status.startswith("yes") else status
    row["status"] = status if status in STATUSES else None
    for d in ("opens_on", "deadline", "verified_on"):
        m = re.match(r"\d{4}-\d{2}-\d{2}", row[d] or "")
        row[d] = m.group(0) if m else None
    closed = (row["deadline_type"] or "").lower() == "closed"
    row.update(id=str(item["id"]), name=item["name"].strip(), check_year=check_year,
               active=row["status"] in ("yes", "likely") and not closed)
    return row


def check_year(mon) -> int | None:
    """The year the board's activity column refers to, from its description ('Check year 2027 ...')."""
    try:
        cols = mon.gql('query($b:[ID!]){ boards(ids:$b){ columns(ids:["%s"]) { description } } }' % ACTIVE_COL,
                       {"b": [FUNDING_BOARD]})["boards"][0]["columns"]
        m = re.search(r"(20\d\d)", (cols[0].get("description") or "") if cols else "")
        return int(m.group(1)) if m else None
    except Exception:
        return None


def read_instruments(mon) -> list[dict]:
    year = check_year(mon)
    fields = 'id name group { id } column_values(ids:["%s"]) { id text }' % '","'.join(INST_COLS)
    return [parse_instrument(i, year) for i in mon._items(FUNDING_BOARD, fields)
            if (i.get("name") or "").strip() and (i.get("group") or {}).get("id") != OLD_GROUP]


# --------------------------------------------------------------------------- writer

def _insert(cur, table: str, cols: list[str], rows) -> None:
    """Plain batched inserts: COPY is refused on RLS-protected tables for a non-owner (events_job)."""
    sql = f"insert into knowledge.{table} ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))})"
    cur.executemany(sql, rows)


def write(cur, radicle: dict | None, instruments: list[dict], report: dict) -> None:
    counts = report.setdefault("counts", {})
    if radicle is not None:
        cur.execute("delete from knowledge.article")
        _insert(cur, "article", ["topic_slug", "topic_label", "parent_topic", "title", "body_markdown",
                                 "key_findings", "related_topics", "active_projects", "completed_projects",
                                 "funding_trend", "last_compiled"],
                [[*r[:5], *(Jsonb(x) for x in r[5:9]), *r[9:]] for r in radicle["articles"]])
        cur.execute("delete from knowledge.project")
        _insert(cur, "project", ["id", "source", "title", "summary", "topics", "trl", "funder", "start_date",
                                 "end_date", "status", "budget_chf", "institution", "lead", "partners",
                                 "source_url"],
                [[*r[:4], Jsonb(r[4]), *r[5:]] for r in radicle["projects"]])
        cur.execute("delete from knowledge.gap")
        _insert(cur, "gap", ["spot_id", "topic_slug", "description", "severity", "cost_range_chf",
                             "evidence_block", "gap_reason"], [list(r) for r in radicle["gaps"]])
        counts["knowledge_articles"] = len(radicle["articles"])
        counts["knowledge_projects"] = len(radicle["projects"])
        counts["knowledge_gaps"] = len(radicle["gaps"])
    else:
        counts["knowledge_radicle"] = "skipped (no RADICLE_DB_PASSWORD)"

    if instruments:   # an empty read is treated as a monday hiccup, not as 'no instruments'
        cur.execute("delete from knowledge.instrument")
        cols = ["id", "name", "funder", "stage", "link", "max_funding_chf", "project_topic", "impact_area",
                "location", "status", "check_year", "active", "funding_type", "deadline_type", "opens_on",
                "deadline", "verified_on"]
        _insert(cur, "instrument", cols, [[i.get(c) for c in cols] for i in instruments])
    counts["knowledge_instruments"] = len(instruments)

    cur.execute("delete from knowledge.contact")
    _insert(cur, "contact", ["key", "name", "role", "topics", "keywords", "fallback"],
            [[c["key"], c["name"], c["role"], c["topics"], c["keywords"], c.get("fallback", False)]
             for c in CONTACTS])


def run(cur, mon, report: dict) -> None:
    """Called from sync/run.py inside its transaction."""
    pw = radicle_password()
    radicle = None
    if pw:
        print("reading radicle ...", flush=True)
        with radicle_connect(pw) as rc:
            radicle = read_radicle(rc)
        print(f"  {len(radicle['articles'])} articles, {len(radicle['projects'])} projects, "
              f"{len(radicle['gaps'])} gaps", flush=True)
    print("reading Funding Schemes ...", flush=True)
    instruments = read_instruments(mon)
    print(f"  {len(instruments)} funding instruments", flush=True)
    write(cur, radicle, instruments, report)
