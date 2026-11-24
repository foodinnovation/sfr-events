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
from urllib.parse import quote, quote_plus

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
from sync.run import db_params  # noqa: E402
from web import attending as att  # noqa: E402

SUPABASE_URL = "https://iudsjtrdtncqqhswcnfu.supabase.co"
PUBLISHABLE_KEY = "sb_publishable_o-EAN8xKYr-dKhcoflQ5SQ_49go67yT"   # public by design
SITE_BASE = os.environ.get("SITE_BASE", "/sfr-events/")   # path of the site root on its host
ORG = "Swiss Food Research"
CONTACT = "contact@swissfoodresearch.ch"

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

KNOWLEDGE = "Radicle \u2013 Knowledge"


def shell(title: str, body: str, depth: int, description: str = "", tab: str = "events",
          scripts: tuple[str, ...] = (), styles: tuple[str, ...] = (), body_class: str = "") -> str:
    up = "../" * depth
    def tab_link(key, href, label):
        on = key == tab
        cls = "hub-tab is-on" if on else "hub-tab"
        cur = ' aria-current="page"' if on else ""
        return f'<a class="{cls}" href="{href}"{cur}>{label}</a>'
    tabs = tab_link("events", up or "./", "Events") + tab_link("knowledge", f"{up}knowledge/", KNOWLEDGE)
    # Statistics: in every page but hidden; app.js shows it to signed-in staff only
    tabs += tab_link("stats", f"{up}stats/", "Statistics").replace('<a class="', '<a hidden data-staff-only class="', 1)
    extra = "".join(f'<script src="{up}assets/{js}"></script>' for js in scripts)
    extra_css = "".join(f'<link rel="stylesheet" href="{up}assets/{css}">' for css in styles)
    body_attr = f' class="{body_class}"' if body_class else ""
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
{extra_css}
<link rel="icon" href="{up}assets/img/favicon.svg" type="image/svg+xml">
</head>
<body{body_attr}>
<header class="site-header">
  <div class="wrap header-row">
    <a class="logo" href="{up}" aria-label="{ORG} events, home"><img src="{up}assets/img/logo-sfr-black.svg" alt="{ORG}" height="52"></a>
    <nav class="hub-tabs" aria-label="Sections">{tabs}</nav>
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
    Questions: <a href="mailto:{CONTACT}">{CONTACT}</a></p>
    <p class="sfr-note"><a href="{up}privacy/">Privacy</a> &middot; <a href="https://www.swissfoodresearch.ch/">{ORG}</a></p>
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
{extra}
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
  <div class="datebox{' datebox-year' if not e['date'] else ''}{' datebox-sfr' if e['kind'] != 'external' else ''}"><span class="d">{day}</span><span class="m">{mon}</span><span class="y">{yr}</span></div>
  <div class="item-body">
    <div class="tags">{''.join(tags)}{extra}</div>
    {link}
    {'<p class="item-meta">' + esc(' · '.join(meta)) + '</p>' if meta else ''}
  </div>
</li>"""


ADS_FILE = ROOT.parent / "config" / "ads.json"


def load_ads(path: Path = ADS_FILE) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"enabled": False}


def ad_cards(ads: dict) -> str:
    """The events-list ads (config/ads.json), all hidden: app.js shows one. Members and staff
    see a service, matched to the Innovation Group filter or a general one; everyone else sees
    the membership ad. Nothing is shown when ads are switched off or JavaScript does not run."""
    if not ads.get("enabled"):
        return ""
    services = {k: v for k, v in (ads.get("services") or {}).items() if v.get("enabled")}
    groups: dict[str, list[str]] = defaultdict(list)
    for ig, key in (ads.get("by_group") or {}).items():
        if key in services:
            groups[key].append(str(ig))
    general = [k for k in ads.get("general") or [] if k in services]

    def card(key: str, ad: dict, audience: str, attrs: str) -> str:
        href = ad.get("href") or ""
        ext = href.startswith("http")
        target = ' target="_blank" rel="noopener"' if ext else ""
        return f"""<li class="ad" hidden data-ad="{esc(key)}" data-audience="{audience}"{attrs}>
  <p class="ad-label">{esc(ad.get("label"))}</p>
  <p class="ad-head">{esc(ad.get("headline"))}</p>
  <p class="ad-body">{esc(ad.get("body"))}</p>
  <a class="btn btn-primary btn-sm" href="{esc(href)}"{target}>{esc(ad.get("cta"))}</a>
</li>"""

    out = []
    m = ads.get("membership") or {}
    if m.get("enabled"):
        out.append(card("membership", m, "public", ""))
    for key, ad in services.items():
        attrs = f' data-groups="{" ".join(groups.get(key, []))}"' + (' data-general' if key in general else "")
        out.append(card(key, ad, "members", attrs))
    return "".join(out)


def index_page(events: list[dict], today: date, ads: dict | None = None) -> str:
    ads = load_ads() if ads is None else ads
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
    <ol class="list" id="upcoming" data-ad-slot="{int(ads.get('slot') or 3)}">{''.join(list_item(e, today) for e in upcoming)}{ad_cards(ads)}</ol>
    <p class="empty" hidden>No upcoming events match your filters.</p>
  </section>
  <section aria-labelledby="h-archive">
    <h2 id="h-archive" class="section-head">Archive</h2>
    <div id="archive">{archive}</div>
    <p class="empty" hidden>No past events match your filters.</p>
  </section>
</div>"""
    return shell(f"Events | {ORG}", body, 0)


# --------------------------------------------------------------------------- programme not yet out

def programme_pending(e: dict, igs: list[str]) -> str:
    """Upcoming IG meeting without a published programme: say it is in preparation with the
    steering board and invite topic ideas by email, with the subject naming the group."""
    group = " and ".join(igs)
    noun = "Innovation Group" if len(igs) == 1 else "Innovation Groups"
    board = "steering board" if len(igs) == 1 else "steering boards"
    subject = f"Topic idea for {noun} {group}"
    body = f"Meeting: {e['title']} ({fmt_date(e['date'], e['year'])})\n\nMy topic idea:\n"
    href = f"mailto:{CONTACT}?subject={quote(subject)}&body={quote(body)}"
    return f"""<section class="block programme-pending">
  <h2 class="h4">Programme</h2>
  <p>We are preparing the programme together with the {board} of the {noun} {esc(group)}.
  If you have a topic or a speaker in mind, tell us.</p>
  <p><a class="btn btn-secondary" href="{esc(href)}">Suggest a topic</a></p>
  <p class="muted">Or write to <a href="mailto:{CONTACT}">{CONTACT}</a>.</p>
</section>"""


# --------------------------------------------------------------------------- who is coming

def attending_block(a: "att.Attending | None", wall: dict) -> str:
    """Logos of the member organisations registered for an upcoming event (config/logo_wall.json).
    Non-members are only counted. Nothing is shown below the configured minimum."""
    if not a or not a.members:
        return ""
    cap = int(wall.get("max_logos") or 12)
    shown, rest = a.members[:cap], len(a.members) - cap
    tiles = []
    for o in shown:
        cls = "lw-tile lw-dark" if o.dark else "lw-tile"
        inner = (f'<img src="{SITE_BASE}assets/members/{esc(o.logo)}" alt="{esc(o.name)}" loading="lazy">'
                 if o.logo else f'<span class="lw-name">{esc(o.name)}</span>')
        tiles.append(f'<li class="{cls}" title="{esc(o.name)}">{inner}</li>')
    more = []
    if rest > 0:
        more.append(f"and {rest} more member organisation{'s' if rest != 1 else ''}")
    if a.others:
        more.append(f"plus {a.others} other organisation{'s' if a.others != 1 else ''}")
    lines = "".join(f'<p class="lw-more">{m}</p>' for m in more)
    return f"""<section class="logo-wall" aria-labelledby="lw-h">
      <h2 class="lw-head" id="lw-h">{esc(wall.get("heading") or "Member organisations attending")}</h2>
      <ul class="lw-grid">{"".join(tiles)}</ul>
      {lines}
    </section>"""


# --------------------------------------------------------------------------- event page

def event_page(e: dict, today: date, attending: "att.Attending | None" = None, wall: dict | None = None) -> str:
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
    elif upcoming and e["kind"] == "ig" and igs:
        prog = programme_pending(e, igs)

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
    {attending_block(attending, wall or {}) if upcoming else ""}
  </aside>
</div>"""
    desc = (e["summary"] or "").strip().split("\n")[0][:200]
    return shell(f"{e['title']} | {ORG}", body, 2, desc)


# --------------------------------------------------------------------------- knowledge tab

def knowledge_page() -> str:
    """Radicle's wiki reader (sidebar tree, tabs, Cmd+K, graph) as an empty shell: the content
    loads in the browser after a member signs in (functions/v1/knowledge), so none of it is
    ever published on this public site."""
    finder_icon = ('<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
                   'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/>'
                   '<path d="M20 20l-3.5-3.5"/><path d="M11 8v6M8 11h6"/></svg>')
    body = f"""
<div class="kn-app">
<div id="app">
  <aside id="sidebar" aria-label="Topic navigation">
    <div class="sidebar-head">
      <div class="brand" id="brand-home" title="Home" role="button" tabindex="0">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 3v18"/><path d="M12 9c0-3-2.5-5-5.5-5C6.5 7 9 9 12 9z"/><path d="M12 14c0-3 2.5-5 5.5-5C17.5 12 15 14 12 14z"/>
          </svg>
        </span>
        <span class="brand-text"><span class="brand-title">Radicle</span><span class="brand-sub">KNOWLEDGE</span></span>
      </div>
      <button id="sidebar-close" class="icon-btn only-narrow" title="Close sidebar" aria-label="Close sidebar">&times;</button>
    </div>
    <div class="sidebar-search">
      <input id="tree-filter" type="search" placeholder="Filter topics ..." autocomplete="off" spellcheck="false">
      <button id="open-switcher-hint" class="kbd-hint" title="Quick search (Cmd+K)">&#8984;K</button>
    </div>
    <nav class="side-tools" aria-label="Tools">
      <button class="side-tool" id="nav-funding-finder" type="button"><span class="side-tool-ic" aria-hidden="true">{finder_icon}</span> Funding Finder</button>
    </nav>
    <div class="side-tree-label">Topics</div>
    <nav id="topic-tree" class="topic-tree" aria-label="Topics"></nav>
  </aside>
  <div id="sidebar-scrim" class="scrim" hidden></div>

  <section id="main" aria-label="Radicle content">
    <div class="topbar">
      <button id="sidebar-toggle" class="icon-btn" title="Toggle sidebar" aria-label="Toggle sidebar">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 5h18M3 12h18M3 19h18"/></svg>
      </button>
      <div id="tabbar" class="tabbar" role="tablist"></div>
      <button id="graph-toggle" class="icon-btn" title="Toggle graph view" aria-label="Toggle graph view">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="9" r="2.6"/><circle cx="10" cy="18" r="2.6"/><path d="M8.3 7.2l7 1.3M7 8.4l2 7.2M16.3 11l-4.6 5.3"/></svg>
      </button>
    </div>
    <div id="content" class="content" tabindex="-1"></div>
    <div class="statusbar"><span id="status-text"></span></div>
  </section>

  <aside id="graphpane" aria-label="Topic graph" hidden>
    <div class="graph-head">
      <span class="graph-title">Graph view</span>
      <label class="local-toggle" title="Show only the current topic and its neighbours"><input type="checkbox" id="local-graph-toggle" checked> Local graph</label>
      <label class="local-toggle" title="Also include neighbours of neighbours (2 hops out)"><input type="checkbox" id="graph-hops-toggle"> 2 hops</label>
      <button id="graph-close" class="icon-btn" title="Close graph" aria-label="Close graph">&times;</button>
    </div>
    <div id="graph-canvas"></div>
    <div class="graph-legend">
      <span>Colour = domain</span>
      <span><i class="ring ring-critical"></i>Critical gaps</span>
      <span><i class="ring ring-mid"></i>Moderate</span>
      <span>Size = projects</span>
    </div>
  </aside>
</div>

<div id="switcher" class="modal-overlay" hidden>
  <div class="switcher-panel" role="dialog" aria-modal="true" aria-label="Quick search">
    <input id="switcher-input" type="text" placeholder="Jump to a topic ... (type to search projects too)" autocomplete="off" spellcheck="false">
    <div id="switcher-results" class="switcher-results"></div>
    <div class="switcher-foot"><span><kbd>&uarr;</kbd><kbd>&darr;</kbd> navigate</span><span><kbd>&crarr;</kbd> open</span><span><kbd>esc</kbd> close</span></div>
  </div>
</div>

<div id="auth-gate" class="modal-overlay auth-gate" hidden>
  <div class="auth-card">
    <div class="auth-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
    </div>
    <h2>Sign in to open {KNOWLEDGE}</h2>
    <p>For members of {ORG}.</p>
    <button class="auth-link" type="button">Sign in</button>
  </div>
</div>
<noscript><p class="wrap">This section needs JavaScript and a member sign-in.</p></noscript>
</div>"""
    return shell(f"{KNOWLEDGE} | {ORG}", body, 1,
                 "Radicle: Swiss agro-food research topics, funded projects and a funding finder for members "
                 f"of {ORG}.", tab="knowledge", body_class="kn-page",
                 styles=("knowledge/app.css",),
                 scripts=("knowledge/vendor/marked.min.js", "knowledge/vendor/force-graph.min.js",
                          "knowledge/app.js"))


# --------------------------------------------------------------------------- statistics (staff only)

def stats_page() -> str:
    """Empty shell: figures load in the browser for signed-in staff (functions/v1/stats)."""
    body = f"""
<section class="hero hero-compact"><div class="wrap">
  <p class="sfr-sub01 eyebrow">For Swiss Food Research staff</p>
  <h1>Statistics</h1>
</div></section>
<div class="wrap block" id="stats" data-ad-names="{esc(json.dumps({k: v.get("label") or k for k, v in [("membership", load_ads().get("membership") or {})] + list((load_ads().get("services") or {}).items())}))}">
  <form class="st-controls" onsubmit="return false">
    <label for="st-period">Period</label>
    <select id="st-period">
      <option value="7">Last 7 days</option>
      <option value="30" selected>Last 30 days</option>
      <option value="90">Last 90 days</option>
      <option value="365">Last 12 months</option>
      <option value="custom">Choose dates</option>
    </select>
    <span id="st-custom" hidden>
      <label class="visually-hidden" for="st-from">From</label><input type="date" id="st-from">
      <label class="visually-hidden" for="st-to">To</label><input type="date" id="st-to">
      <button type="button" class="btn btn-secondary btn-sm" id="st-apply">Show</button>
    </span>
  </form>
  <p class="muted" id="stats-note" role="status">Sign in with your Swiss Food Research address to see the statistics.</p>
  <div id="stats-out"></div>
</div>"""
    return shell(f"Statistics | {ORG}", body, 1, "Usage statistics of the SFR hub, for staff.", tab="stats",
                 scripts=("stats.js",)).replace("<head>", '<head>\n<meta name="robots" content="noindex">', 1)


# --------------------------------------------------------------------------- privacy

PRIVACY_UPDATED = "24 November 2026"


def privacy_page() -> str:
    body = f"""
<section class="hero hero-compact"><div class="wrap">
  <p class="sfr-sub01 eyebrow">{ORG}</p>
  <h1>Privacy on the SFR hub</h1>
</div></section>
<div class="wrap block"><div class="prose">
<p class="lead">This page explains what the SFR hub (Events, Radicle \u2013 Knowledge and the presentation
archive) does with personal data. It adds to the general
<a href="https://www.swissfoodresearch.ch/en/privacy-policy/">privacy policy of {ORG}</a>, which applies too.</p>

<h2>Who is responsible</h2>
<p>{ORG}, Technoparkstrasse 1, Postfach 140, 8005 Z\u00fcrich, Switzerland.
Questions and requests: <a href="mailto:{CONTACT}">{CONTACT}</a>.</p>

<h2>Browsing without signing in</h2>
<p>The hub sets no cookies and loads no fonts, scripts or images from other websites: they all come
from the hub itself. The pages are served by GitHub Pages (GitHub, Inc., USA), whose
servers record technical access data such as IP addresses under
<a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">GitHub's privacy statement</a>.</p>

<h2>Usage counting</h2>
<p>To learn which events and services interest visitors, the hub counts a few actions: page views,
clicks on Register, on ads and on email buttons, searches and filters on the events list, and in
Radicle \u2013 Knowledge the topics opened and how often the quick search and the Funding Finder are used.</p>
<p>Each count holds only the time, the page, the action, a short reference (for example the event, the ad
or a search term), the visitor's role (visitor, participant, member or staff), the website the visitor
came from (domain only) and whether the device is mobile. No IP address, email address, cookie or
identifier is stored, so counts cannot be linked to a person or to each other. Text typed into
Radicle \u2013 Knowledge, including project ideas, is never counted. Counts are deleted after 13 months.
Only {ORG} staff can see the totals.</p>

<h2>Signing in</h2>
<p>To open presentations or Radicle \u2013 Knowledge you sign in with Microsoft or with a link or code sent
to your email address. The hub then stores your email address and the times you signed in. Your
sign-in is kept in your browser's local storage (not a cookie) until you sign out. With Microsoft
sign-in, Microsoft confirms your address under its own privacy terms. The sign-in service also keeps
a record of sign-ins with the network (IP) address used, to protect accounts against misuse.
To delete your account, write to us.</p>

<h2>Presentations</h2>
<p>Presentations stay on the SharePoint site of {ORG}. When you open one, the hub checks whether you may:
members of {ORG} by the domain of their email address, participants by their registration. Each
request is logged with your email address, the presentation, the result and the time, so that misuse
can be traced. This log is deleted after 13 months. The presentation itself opens through a
time-limited Microsoft link.</p>

<h2>Registrations</h2>
<p>Registrations made through ti.to or Eventbrite reach {ORG}'s event planning in monday.com. The hub
copies only the email address and the registration status, to give participants access to the
presentations of their event. A registration leaves the hub when it is removed there.</p>
<p>On the page of an upcoming event, the hub shows the logos of member organisations whose people have
registered, once at least five member organisations have. Registrations from other organisations are
only counted. No person is named. A member organisation that does not want to appear can write to
<a href="mailto:{CONTACT}">{CONTACT}</a>.</p>
<p>The ti.to and Eventbrite sign-up forms load only when you open them on an event page; their own
privacy policies then apply. Links to Google Maps open Google Maps only when you click them.</p>

<h2>Radicle \u2013 Knowledge</h2>
<p>Searches and Funding Finder requests are processed to show results and are not saved in the hub's
database. The articles,
projects and funding programmes come from public sources and from {ORG}'s own records.</p>

<h2>Where data is kept</h2>
<p>The hub's database and functions run on Supabase, in its Zurich data centre. Event data comes from
monday.com. Presentations are held in Microsoft SharePoint. Like any web service, Supabase keeps
technical request logs for a few days, which can include IP addresses and the addresses of the
requests; {ORG} uses them only to fix faults.</p>

<h2>Your rights</h2>
<p>You can ask what data the hub holds about you, have it corrected or deleted, and withdraw from
signing in at any time: write to <a href="mailto:{CONTACT}">{CONTACT}</a>. You may also complain to the
Federal Data Protection and Information Commissioner (FDPIC).</p>

<p class="muted">Last updated {PRIVACY_UPDATED}.</p>
</div></div>"""
    return shell(f"Privacy | {ORG}", body, 1, f"How the SFR hub of {ORG} handles personal data.", tab="")


# --------------------------------------------------------------------------- build

def public_json(events: list[dict]) -> list[dict]:
    return [dict(id=e["id"], slug=e["slug"], kind=e["kind"], title=e["title"],
                 date=e["date"].isoformat() if e["date"] else None, year=e["year"],
                 location=e["location"], url=e["url"] if e["kind"] == "external" else None,
                 innovation_groups=ig_labels(e), sessions=len(e["sessions"]),
                 presentations=sum(1 for d in e["decks"] if not d["programme"]))
            for e in events]


def build(out: Path, events: list[dict], today: date, attending: dict | None = None,
          logos: dict[str, bytes] | None = None, wall: dict | None = None) -> str:
    attending = attending or {}
    if out.exists():
        shutil.rmtree(out)
    (out / "assets").mkdir(parents=True)
    shutil.copytree(ROOT / "static", out / "assets", dirs_exist_ok=True)
    (out / "index.html").write_text(index_page(events, today))
    for e in events:
        if e["kind"] != "external" and e["slug"]:
            p = out / "events" / e["slug"]
            p.mkdir(parents=True, exist_ok=True)
            (p / "index.html").write_text(event_page(e, today, attending.get(str(e["id"])), wall))
    if logos:
        (out / "assets" / "members").mkdir(exist_ok=True)
        for name, data in logos.items():
            (out / "assets" / "members" / name).write_bytes(data)
    (out / "knowledge").mkdir()
    (out / "knowledge" / "index.html").write_text(knowledge_page())
    (out / "stats").mkdir()
    (out / "stats" / "index.html").write_text(stats_page())
    (out / "privacy").mkdir()
    (out / "privacy" / "index.html").write_text(privacy_page())
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
        wall = att.load_config()
        try:
            with conn.transaction():
                attending = att.collect(conn, today, wall)
        except Exception as exc:  # noqa: BLE001  the logo block must never stop the site
            print(f"::warning::attending member organisations not read ({exc}); no logo blocks this run")
            attending = {}
    logos: dict[str, bytes] = {}
    if attending and os.environ.get("MONDAY_TOKEN"):
        from sync.monday import Monday
        try:
            logos = att.fetch_logos(Monday(), attending)
        except Exception as exc:  # noqa: BLE001
            print(f"::warning::member logos not fetched ({exc}); attending blocks show names only")
    print(f"logo wall: {len(attending)} upcoming events with {wall.get('min_members', 5)}+ member organisations, "
          f"{len(logos)} logos")
    digest = build(Path(args.out), events, today, attending, logos, wall)
    data = Path(args.data)
    data.parent.mkdir(parents=True, exist_ok=True)
    data.write_text(json.dumps(public_json(events), indent=1, ensure_ascii=False) + "\n")
    print(f"built {len(events)} events, {sum(1 for e in events if e['kind'] != 'external')} pages, "
          f"{sum(len(e['decks']) for e in events)} decks listed; site hash {digest[:12]}")
    Path("site-hash.txt").write_text(digest + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
