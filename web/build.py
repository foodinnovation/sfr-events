"""Build the static SFR event calendar from the events schema in Supabase.

    python web/build.py --out _site

Reads published events, programmes and decks; writes:
    _site/index.html                    upcoming events and the archive, with filters
    _site/events/<slug>/index.html      one page per SFR or Innovation Group event
    _site/assets/...                    styles, script, logo, fonts, supabase-js
    data/events.json                    public event list (committed; keeps the repo active)

Partner events have no page of their own: the list links straight to the partner.
Slugs are assigned once and stored in events.event.slug, so shared links keep working.
Participant lists are never listed.
"""
from __future__ import annotations

import argparse
import os
import hashlib
import html
import json
import re
import shutil
import sys
import unicodedata
from collections import defaultdict
from datetime import date, datetime, time
from pathlib import Path

import psycopg
from urllib.parse import quote_plus

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
from sync.run import db_params  # noqa: E402

SUPABASE_URL = "https://iudsjtrdtncqqhswcnfu.supabase.co"
PUBLISHABLE_KEY = "sb_publishable_o-EAN8xKYr-dKhcoflQ5SQ_49go67yT"   # public by design
SITE_BASE = os.environ.get("SITE_BASE", "/sfr-events/")   # path of the site root on its host
ORG = "Swiss Food Research"

IG_NAMES = {   # English display names; wiki names are German
    1: "Aquaculture", 2: "Grains & Baked Goods", 3: "Coffee", 4: "Packaging", 5: "Insects",
    6: "Digitalization", 7: "Proteins4Future", 8: "Non-Thermal Preservation", 9: "Bioconversion",
    10: "Cocoa & Chocolate", 11: "Fungi & Fungal Systems", 12: "Future Proof Farming",
    13: "Carbon", 14: "Sustainable Nutrition", 15: "Future Proof Farming Lucerne",
    16: "Future Proof Farming Jura", 17: "Future Proof Farming Bern / Espace Mittelland",
}
# Design System 2026 assets per IG: icon (assets/img/ig/<name>.svg) and picture (<name>.webp).
# Future Proof Farming and its regional groups share one set. Carbon (13) has none.
IG_ASSET = {
    1: "aquaculture", 2: "bread-baked-goods", 3: "coffee", 4: "packaging", 5: "insects",
    6: "digitalization", 7: "protein4future", 8: "non-thermal-preservation", 9: "bioconversion",
    10: "cocoa-chocolate", 11: "fungi", 12: "future-oriented-farming", 14: "sustainable-nutrition",
    15: "future-oriented-farming", 16: "future-oriented-farming", 17: "future-oriented-farming",
}
IG_NO_PICTURE = {"non-thermal-preservation"}
ONLINE = re.compile(r"\b(online|webinar|zoom|teams|virtual|virtuell|hybrid only|livestream)\b", re.I)
KIND_LABEL = {"ig": "Innovation Group", "sfr": "SFR event", "external": "Partner event"}

esc = lambda s: html.escape(s or "", quote=True)  # noqa: E731


# --------------------------------------------------------------------------- data

def slugify(text: str) -> str:
    t = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-zA-Z0-9]+", "-", t.lower()).strip("-")
    return re.sub(r"-{2,}", "-", t)[:60].rstrip("-") or "event"


def assign_slugs(conn, dry_run: bool) -> None:
    with conn.cursor() as cur:
        cur.execute("""select id, event_date, event_year, coalesce(title_en, title_src)
                       from events.event
                       where slug is null and published and removed_at is null and kind <> 'external'
                       order by id""")
        rows = cur.fetchall()
        cur.execute("select slug from events.event where slug is not null")
        taken = {r[0] for r in cur.fetchall()}
        for eid, d, y, title in rows:
            base = f"{d.isoformat() if d else y}-{slugify(title)}"
            slug = base if base not in taken else f"{base}-{eid}"
            taken.add(slug)
            cur.execute("update events.event set slug = %s where id = %s", [slug, eid])
    if dry_run:
        conn.rollback()
    else:
        conn.commit()


def load(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute("""
            select e.id, e.slug, e.kind, e.ig_id, coalesce(e.title_en, e.title_src),
                   coalesce(e.summary_en, e.summary_src), e.event_date, e.event_year,
                   e.start_time, e.end_time, e.location, e.signup_url, e.source
            from events.event e
            where e.published and e.removed_at is null
              and (e.event_date is not null or e.event_year is not null)""")
        events = [dict(id=r[0], slug=r[1], kind=r[2], ig=r[3], title=r[4], summary=r[5], date=r[6],
                       year=r[7] or (r[6].year if r[6] else None), start=r[8], end=r[9],
                       location=r[10], url=r[11], source=r[12], sessions=[], decks=[], igs=set())
                  for r in cur.fetchall()]
        by_id = {e["id"]: e for e in events}

        cur.execute("""select event_id, start_time, coalesce(title_en, title_src), speakers
                       from events.session order by event_id, start_time nulls last, title_src""")
        for eid, st, title, speakers in cur.fetchall():
            if eid in by_id:
                by_id[eid]["sessions"].append(dict(time=clock(st), title=title, speakers=public_speakers(speakers)))
    for e in events:
        e["sessions"] = tidy_programme(e["sessions"])

        cur.execute("""select d.id, d.event_id, coalesce(nullif(d.title, ''), d.filename), d.is_programme,
                              d.filename
                       from events.deck d
                       where d.removed_at is null and d.in_web_folder and d.event_id is not null
                         and coalesce(d.doc_type, '') <> 'participant_list'
                       order by d.is_programme desc, d.filename""")
        for did, eid, title, prog, fn in cur.fetchall():
            if eid in by_id:
                by_id[eid]["decks"].append(dict(id=str(did), title=title, programme=prog, filename=fn))

        cur.execute("""select em.event_id, m.ig_id from events.event_meeting em
                       join public.meetings m on m.id = em.meeting_id""")
        for eid, ig in cur.fetchall():
            if eid in by_id and ig:
                by_id[eid]["igs"].add(ig)
    for e in events:
        if e["ig"]:
            e["igs"].add(e["ig"])
    # year-only archive entries sort to the end of their year in the (reversed) archive
    events.sort(key=lambda e: (e["date"] or date(e["year"], 1, 1), e["date"] is not None, e["id"]))
    return events


# --------------------------------------------------------------------------- programme rows

def clock(raw: str | None) -> str | None:
    """monday programme times arrive as typed: '9.30', '10', '14:00', '9h30'. Normalise to HH:MM."""
    m = re.match(r"^\s*(\d{1,2})(?:\s*[.:h]\s*(\d{2}))?\s*$", raw or "")
    if not m or int(m.group(1)) > 23 or int(m.group(2) or 0) > 59:
        return (raw or "").strip() or None
    return f"{int(m.group(1)):02d}:{m.group(2) or '00'}"


def public_speakers(speakers: list | None) -> list[dict]:
    """Never print an email address on the public page: if a speaker's name is an address
    (the People record has no proper name), show the organisation only."""
    out = []
    for p in speakers or []:
        name = re.sub(r"\s+", " ", (p.get("name") or "")).strip()
        org = (p.get("organisation") or "").strip()
        if "@" in name:
            name = ""
        if name or org:
            out.append({"name": name or org, "organisation": org if name else ""})
    return out


def tidy_programme(rows: list[dict]) -> list[dict]:
    """Sort by time, untimed rows last. Staff number rows on monday to order them ('2 Welcome',
    '92 Break'); when every row carries such a number, strip it."""
    numbered = re.compile(r"^\d{1,3}\s+(?=\S)")
    if rows and all(numbered.match(r["title"] or "") for r in rows):
        rows = [dict(r, title=numbered.sub("", r["title"])) for r in rows]
    key = lambda r: (r["time"] is None or not re.match(r"^\d{2}:\d{2}$", r["time"]), r["time"] or "")
    return sorted(rows, key=key)


# --------------------------------------------------------------------------- formatting

def fmt_date(d: date | None, year: int | None) -> str:
    return f"{d.strftime('%A')}, {d.day} {d.strftime('%B %Y')}" if d else str(year)


def fmt_short(d: date | None, year: int | None) -> tuple[str, str, str]:
    if not d:
        return ("", "", str(year))
    return (str(d.day), d.strftime("%b"), str(d.year))


def fmt_time(t: time | None) -> str:
    return t.strftime("%H:%M") if t else ""


def time_range(e: dict) -> str:
    a, b = fmt_time(e["start"]), fmt_time(e["end"])
    return f"{a} to {b}" if a and b else a


def paragraphs(text: str | None) -> str:
    if not text:
        return ""
    out = []
    for para in re.split(r"\n\s*\n", text.strip()):
        safe = esc(para.strip()).replace("\n", "<br>")
        safe = re.sub(r"(https?://[^\s<]+)", r'<a href="\1" rel="noopener">\1</a>', safe)
        out.append(f"<p>{safe}</p>")
    return "\n".join(out)


def ig_labels(e: dict) -> list[str]:
    return [IG_NAMES.get(i, "") for i in sorted(e["igs"]) if IG_NAMES.get(i)]


def primary_asset(e: dict) -> str | None:
    for i in sorted(e["igs"]):
        if i in IG_ASSET:
            return IG_ASSET[i]
    return None


def icon(name: str, cls: str = "ig-icon") -> str:
    """Design-system IG icon, drawn as a mask so it takes the text colour. The path is absolute
    because browsers resolve relative url() in custom properties inconsistently."""
    return f'<span class="{cls}" style="--icon:url({SITE_BASE}assets/img/ig/{name}.svg)" aria-hidden="true"></span>'


def maps_url(location: str | None) -> str | None:
    """Google Maps search link for a physical place; None for online or missing places."""
    loc = (location or "").strip()
    if not loc or ONLINE.search(loc) or loc.lower().startswith("http"):
        return None
    return "https://www.google.com/maps/search/?api=1&query=" + quote_plus(loc)


def signup(url: str | None) -> dict | None:
    """Classify the monday sign-up link. ti.to and Eventbrite can be embedded; links to the old
    swissfoodresearch.ch event pages are dropped, since this calendar replaces them."""
    u = (url or "").strip()
    if not u.lower().startswith(("http://", "https://")):
        return None
    m = re.match(r"https?://(?:www\.)?ti\.to/([\w-]+)/([\w-]+)", u, re.I)
    if m:
        return {"kind": "tito", "url": u, "ref": f"{m.group(1)}/{m.group(2)}", "host": "ti.to"}
    m = re.match(r"https?://(?:www\.)?eventbrite\.[a-z.]+/e/(?:[\w-]*-)?(\d{6,})", u, re.I)
    if m:
        return {"kind": "eventbrite", "url": u, "ref": m.group(1), "host": "Eventbrite"}
    if re.match(r"https?://(?:www\.)?swissfoodresearch\.ch/", u, re.I):
        return None
    return {"kind": "link", "url": u, "ref": None, "host": None}


# --------------------------------------------------------------------------- page shell

def shell(title: str, body: str, depth: int, description: str = "") -> str:
    up = "../" * depth
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description or 'Events of Swiss Food Research: Innovation Group meetings, SFR events and partner events, with presentations for members and participants.')}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:site_name" content="{ORG}">
<link rel="stylesheet" href="{up}assets/fonts.css">
<link rel="stylesheet" href="{up}assets/tokens.css">
<link rel="stylesheet" href="{up}assets/site.css">
<link rel="icon" href="{up}assets/img/favicon.svg" type="image/svg+xml">
</head>
<body>
<header class="site-header">
  <div class="wrap header-row">
    <a class="logo" href="{up}" aria-label="{ORG} events, home"><img src="{up}assets/img/logo-sfr-black.svg" alt="{ORG}" height="52"></a>
    <span class="header-title sfr-note">Events</span>
    <div class="account" id="account">
      <button class="btn btn-secondary btn-sm" id="signin-open" type="button">Sign in</button>
    </div>
  </div>
</header>
<main>
{body}
</main>
<footer class="site-footer">
  <div class="wrap footer-row">
    <img src="{up}assets/img/logo-sfr-white.svg" alt="{ORG}" height="48">
    <p>Presentations are available to members of {ORG} and to registered participants of each event.
    Questions: <a href="mailto:contact@swissfoodresearch.ch">contact@swissfoodresearch.ch</a></p>
    <p class="sfr-note"><a href="https://www.swissfoodresearch.ch/">{ORG}</a></p>
  </div>
</footer>
<dialog id="signin" class="dialog" aria-labelledby="signin-title">
  <form method="dialog" class="dialog-close"><button aria-label="Close">&times;</button></form>
  <h2 id="signin-title" class="h4">Sign in to open presentations</h2>
  <p class="muted">Members sign in with their work address. Participants use the address they registered with.</p>
  <button class="btn btn-primary btn-block" id="signin-ms" type="button">Sign in with Microsoft</button>
  <div class="divider"><span>or</span></div>
  <form id="signin-email" class="stack">
    <label for="signin-address">Work email address</label>
    <input id="signin-address" type="email" autocomplete="email" required>
    <button class="btn btn-secondary btn-block" type="submit">Email me a sign-in link</button>
  </form>
  <form id="signin-code" class="stack" hidden>
    <p>We have sent a sign-in link to <strong id="signin-sent-to"></strong>. Open it on this device, or enter the code from the email. Always use the most recent email.</p>
    <label for="signin-otp">Code</label>
    <input id="signin-otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{{6,12}}" maxlength="12" required>
    <button class="btn btn-primary btn-block" type="submit">Sign in</button>
  </form>
  <p class="form-message" id="signin-message" role="status"></p>
</dialog>
<script>window.SFR_EVENTS = {{ supabaseUrl: "{SUPABASE_URL}", key: "{PUBLISHABLE_KEY}" }};</script>
<script src="{up}assets/supabase.js"></script>
<script src="{up}assets/app.js"></script>
</body>
</html>
"""


# --------------------------------------------------------------------------- listing

def list_item(e: dict, today: date) -> str:
    day, mon, yr = fmt_short(e["date"], e["year"])
    igs = ig_labels(e)
    tags = [f'<span class="tag tag-{e["kind"]}">{KIND_LABEL[e["kind"]]}</span>']
    tags += [f'<span class="tag">{icon(IG_ASSET[i]) if i in IG_ASSET else ""}{esc(IG_NAMES[i])}</span>'
             for i in sorted(e["igs"]) if i in IG_NAMES]
    meta = [x for x in (time_range(e), e["location"]) if x]
    has_decks = any(not d["programme"] for d in e["decks"])
    if e["kind"] == "external":
        href = e["url"] or ""
        link = (f'<a class="item-title" href="{esc(href)}" rel="noopener" target="_blank">{esc(e["title"])}'
                f'<span class="ext" aria-label="opens the partner\'s website"> &#8599;</span></a>'
                if href else f'<span class="item-title">{esc(e["title"])}</span>')
    else:
        link = f'<a class="item-title" href="events/{esc(e["slug"])}/">{esc(e["title"])}</a>'
    extra = '<span class="item-flag">Presentations</span>' if has_decks else ""
    search = " ".join([e["title"] or "", e["location"] or "", " ".join(igs), KIND_LABEL[e["kind"]]]).lower()
    return f"""<li class="item" data-kind="{e['kind']}" data-igs="{' '.join(str(i) for i in sorted(e['igs']))}" data-search="{esc(search)}">
  <div class="datebox{' datebox-year' if not e['date'] else ''}"><span class="d">{day}</span><span class="m">{mon}</span><span class="y">{yr}</span></div>
  <div class="item-body">
    <div class="tags">{''.join(tags)}{extra}</div>
    {link}
    {'<p class="item-meta">' + esc(' · '.join(meta)) + '</p>' if meta else ''}
  </div>
</li>"""


def index_page(events: list[dict], today: date) -> str:
    upcoming = [e for e in events if e["date"] and e["date"] >= today]
    past = [e for e in events if not (e["date"] and e["date"] >= today)]
    past.reverse()
    by_year = defaultdict(list)
    for e in past:
        by_year[e["year"]].append(e)
    used_igs = sorted({i for e in events for i in e["igs"] if i in IG_NAMES}, key=lambda i: IG_NAMES[i])
    ig_opts = "".join(f'<option value="{i}">{esc(IG_NAMES[i])}</option>' for i in used_igs)
    archive = "".join(
        f'<section class="year" data-year="{y}"><h3 class="year-head">{y}</h3><ol class="list">'
        + "".join(list_item(e, today) for e in by_year[y]) + "</ol></section>"
        for y in sorted(by_year, reverse=True))
    body = f"""
<section class="hero">
  <div class="wrap">
    <p class="sfr-sub01 eyebrow">{ORG}</p>
    <h1>Events</h1>
    <p class="lead">Innovation Group meetings, SFR events and selected partner events. After each meeting,
    members and registered participants can open the presentations.</p>
  </div>
</section>
<div class="wrap">
  <form class="filters" id="filters" role="search" onsubmit="return false">
    <div class="chips" role="group" aria-label="Event type">
      <button type="button" class="chip is-on" data-kind="all" aria-pressed="true">All</button>
      <button type="button" class="chip" data-kind="ig" aria-pressed="false">Innovation Groups</button>
      <button type="button" class="chip" data-kind="sfr" aria-pressed="false">SFR events</button>
      <button type="button" class="chip" data-kind="external" aria-pressed="false">Partner events</button>
    </div>
    <label class="visually-hidden" for="f-ig">Innovation Group</label>
    <select id="f-ig"><option value="">All Innovation Groups</option>{ig_opts}</select>
    <label class="visually-hidden" for="f-q">Search</label>
    <input id="f-q" type="search" placeholder="Search events">
  </form>
  <section aria-labelledby="h-upcoming">
    <h2 id="h-upcoming" class="section-head">Upcoming</h2>
    <ol class="list" id="upcoming">{''.join(list_item(e, today) for e in upcoming)}</ol>
    <p class="empty" hidden>No upcoming events match your filters.</p>
  </section>
  <section aria-labelledby="h-archive">
    <h2 id="h-archive" class="section-head">Archive</h2>
    <div id="archive">{archive}</div>
    <p class="empty" hidden>No past events match your filters.</p>
  </section>
</div>"""
    return shell(f"Events | {ORG}", body, 0)


# --------------------------------------------------------------------------- event page

def event_page(e: dict, today: date) -> str:
    up = "../../"
    igs = ig_labels(e)
    upcoming = bool(e["date"] and e["date"] >= today)
    asset = primary_asset(e)
    facts = [("Date", esc(fmt_date(e["date"], e["year"])))]
    if time_range(e):
        facts.append(("Time", esc(time_range(e))))
    if e["location"]:
        m = maps_url(e["location"])
        place = (f'<a href="{esc(m)}" rel="noopener" target="_blank">{esc(e["location"])}'
                 f'<span class="visually-hidden"> (opens Google Maps)</span></a>' if m else esc(e["location"]))
        facts.append(("Place", place))
    if igs:
        facts.append(("Innovation Group" if len(igs) == 1 else "Innovation Groups", esc(", ".join(igs))))
    facts_html = "".join(f"<div><dt>{k}</dt><dd>{v}</dd></div>" for k, v in facts)

    reg = signup(e["url"]) if upcoming else None
    register, reg_block = "", ""
    if reg and reg["kind"] in ("tito", "eventbrite"):
        register = '<a class="btn btn-primary" href="#registration" data-register>Register</a>'
        reg_block = f"""<section class="block registration" id="registration"
    data-provider="{reg['kind']}" data-ref="{esc(reg['ref'])}">
  <h2 class="h4">Registration</h2>
  <p class="muted reg-note">Registration runs on {reg['host']}. The form loads from {reg['host']} once you open it.</p>
  <div class="reg-actions">
    <button type="button" class="btn btn-primary" data-register>Open the registration form</button>
    <a class="btn btn-ghost btn-sm" href="{esc(reg['url'])}" rel="noopener" target="_blank">Register on {reg['host']} instead</a>
  </div>
  <div class="reg-widget" hidden></div>
</section>"""
    elif reg:
        register = f'<a class="btn btn-primary" href="{esc(reg["url"])}" rel="noopener" target="_blank">Register</a>'

    prog = ""
    if e["sessions"]:
        rows = []
        for s in e["sessions"]:
            who = "; ".join(f'{esc(p.get("name"))}' + (f', {esc(p.get("organisation"))}' if p.get("organisation") else "")
                            for p in s["speakers"] if p.get("name"))
            rows.append(f'<li><span class="p-time">{esc(s["time"] or "")}</span>'
                        f'<span class="p-body"><span class="p-title">{esc(s["title"])}</span>'
                        f'{f"<span class=p-who>{who}</span>" if who else ""}</span></li>')
        prog = f'<section class="block"><h2 class="h4">Programme</h2><ol class="programme">{"".join(rows)}</ol></section>'

    decks = ""
    if e["decks"] and not upcoming:
        items = "".join(
            f'<li class="deck"><span class="deck-title">{esc(d["title"])}'
            f'{" <span class=tag>Programme</span>" if d["programme"] else ""}</span>'
            f'<span class="deck-actions">'
            f'<button type="button" class="btn btn-secondary btn-sm deck-open" data-deck="{d["id"]}" disabled>'
            f'<span class="lock" aria-hidden="true"></span><span class="label">Sign in to open</span></button>'
            f'<button type="button" class="btn btn-ghost btn-sm deck-download" data-deck="{d["id"]}" data-mode="download" hidden>'
            f'<span class="label">Download</span></button></span></li>'
            for d in e["decks"])
        decks = f"""<section class="block" id="presentations" data-event="{e['id']}">
  <h2 class="h4">Presentations</h2>
  <p class="muted access-note">Available to members of {ORG} and to registered participants of this meeting.</p>
  <ul class="decks">{items}</ul>
</section>"""

    has_picture = bool(asset and asset not in IG_NO_PICTURE)
    hero_style = f' style="--hero-img:url({SITE_BASE}assets/img/ig/{asset}.webp)"' if has_picture else ""
    hero_icon = icon(asset, "hero-icon") if asset else ""
    body = f"""
<section class="hero hero-event{' hero-photo' if has_picture else ''}"{hero_style}>
  <div class="wrap">
    <p class="crumbs"><a href="{up}">All events</a></p>
    {hero_icon}
    <p class="sfr-sub01 eyebrow">{KIND_LABEL[e['kind']]}{(' &middot; ' + esc(igs[0])) if len(igs) == 1 else ''}</p>
    <h1>{esc(e['title'])}</h1>
    <p class="hero-date">{esc(fmt_date(e['date'], e['year']))}</p>
  </div>
</section>
<div class="wrap event-grid">
  <article class="event-main">
    {paragraphs(e['summary']) and '<section class="block summary">' + paragraphs(e['summary']) + '</section>'}
    {reg_block}
    {prog}
    {decks}
  </article>
  <aside class="event-side">
    <dl class="facts">{facts_html}</dl>
    {register}
    <button type="button" class="btn btn-ghost btn-sm share" data-share>Copy link to this event</button>
  </aside>
</div>"""
    desc = (e["summary"] or "").strip().split("\n")[0][:200]
    return shell(f"{e['title']} | {ORG}", body, 2, desc)


# --------------------------------------------------------------------------- build

def public_json(events: list[dict]) -> list[dict]:
    return [dict(id=e["id"], slug=e["slug"], kind=e["kind"], title=e["title"],
                 date=e["date"].isoformat() if e["date"] else None, year=e["year"],
                 location=e["location"], url=e["url"] if e["kind"] == "external" else None,
                 innovation_groups=ig_labels(e), sessions=len(e["sessions"]),
                 presentations=sum(1 for d in e["decks"] if not d["programme"]))
            for e in events]


def build(out: Path, events: list[dict], today: date) -> str:
    if out.exists():
        shutil.rmtree(out)
    (out / "assets").mkdir(parents=True)
    shutil.copytree(ROOT / "static", out / "assets", dirs_exist_ok=True)
    (out / "index.html").write_text(index_page(events, today))
    for e in events:
        if e["kind"] != "external" and e["slug"]:
            p = out / "events" / e["slug"]
            p.mkdir(parents=True, exist_ok=True)
            (p / "index.html").write_text(event_page(e, today))
    (out / "404.html").write_text(shell(f"Not found | {ORG}", '<div class="wrap block"><h1>Page not found</h1>'
                                        f'<p><a href="{SITE_BASE}">Back to all events</a></p></div>', 0))
    (out / ".nojekyll").write_text("")
    h = hashlib.sha256()
    for f in sorted(out.rglob("*")):
        if f.is_file():
            h.update(str(f.relative_to(out)).encode())
            h.update(f.read_bytes())
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="_site")
    ap.add_argument("--data", default="data/events.json")
    ap.add_argument("--dry-run", action="store_true", help="do not store new slugs")
    ap.add_argument("--today", help="YYYY-MM-DD, for tests")
    args = ap.parse_args()
    today = date.fromisoformat(args.today) if args.today else datetime.now().date()
    with psycopg.connect(**db_params()) as conn:
        assign_slugs(conn, args.dry_run)
        events = load(conn)
    digest = build(Path(args.out), events, today)
    data = Path(args.data)
    data.parent.mkdir(parents=True, exist_ok=True)
    data.write_text(json.dumps(public_json(events), indent=1, ensure_ascii=False) + "\n")
    print(f"built {len(events)} events, {sum(1 for e in events if e['kind'] != 'external')} pages, "
          f"{sum(len(e['decks']) for e in events)} decks listed; site hash {digest[:12]}")
    Path("site-hash.txt").write_text(digest + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
