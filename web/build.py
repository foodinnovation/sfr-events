"""Build the static SFR event calendar from the events schema in Supabase.

    python web/build.py --out _site

Reads published events, programmes and decks; writes:
    _site/index.html                    hub home: next events, Pulse picks, free 1:1, Radicle, newsletter
    _site/events/index.html             upcoming events and the archive, with filters
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
SITE_BASE = os.environ.get("SITE_BASE", "/")   # path of the site root on its host (hub.swissfoodresearch.ch)
ORG = "Swiss Food Research"
CONTACT = "contact@swissfoodresearch.ch"
MEMBERSHIP_URL = "https://www.swissfoodresearch.ch/en/membership-benefits/"
HUB_DESCRIPTION = ("The Swiss Food Research hub: upcoming Innovation Group meetings and SFR events, "
                   "agro-food news, Radicle \u2013 Knowledge and a free 1:1 session for your idea or project.")
EVENTS_DESCRIPTION = ("Events of Swiss Food Research: Innovation Group meetings, SFR events and partner events, "
                      "with presentations for members and participants.")

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
PULSE_FILE = ROOT.parent / "config" / "pulse.json"


def load_pulse(path: Path = PULSE_FILE) -> dict:
    """config/pulse.json: {"public": true} opens Pulse to everyone; otherwise "audience" says who reads it:
    "members" (signed-in members and staff) or "staff" (the default, used for the shadow run)."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"public": False}


def pulse_audience() -> str:
    cfg = load_pulse()
    if cfg.get("public"):
        return "public"
    return "members" if cfg.get("audience") == "members" else "staff"


def shell(title: str, body: str, depth: int, description: str = "", tab: str = "events",
          scripts: tuple[str, ...] = (), styles: tuple[str, ...] = (), body_class: str = "") -> str:
    up = "../" * depth
    def tab_link(key, href, label):
        on = key == tab
        cls = "hub-tab is-on" if on else "hub-tab"
        cur = ' aria-current="page"' if on else ""
        return f'<a class="{cls}" href="{href}"{cur}>{label}</a>'
    tabs = (tab_link("events", f"{up}events/", "Events") + tab_link("services", f"{up}services/", "Services")
            + tab_link("knowledge", f"{up}knowledge/", "Knowledge"))
    pulse_tab = tab_link("pulse", f"{up}pulse/", "Pulse")
    # Pulse: a tab for everyone once it is open to members or the public (visitors see how to get access);
    # before that only signed-in staff see it
    tabs += pulse_tab if pulse_audience() != "staff" else pulse_tab.replace('<a class="', '<a hidden data-staff-only class="', 1)
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
<meta name="description" content="{esc(description or HUB_DESCRIPTION)}">
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
    <a class="logo" href="{up}" aria-label="{ORG} hub, home"><img src="{up}assets/img/logo-sfr-black.svg" alt="{ORG}" height="52"></a>
    <nav class="hub-tabs" aria-label="Sections">{tabs}</nav>
    <div class="account" id="account">
      <button class="btn btn-secondary btn-sm" id="signin-open" type="button">Sign in</button>
    </div>
  </div>
</header>
<main>
{body}
</main>
<section class="partner-banner" aria-label="Supported by">
  <div class="wrap partner-row">
    <span class="partner-label">Supported by</span>
    <ul class="partner-logos">
      <li><img src="{up}assets/img/partners/minerva-foundation.svg" alt="Minerva Foundation"></li>
      <li><img src="{up}assets/img/partners/avina.png" alt="Avina Foundation"></li>
      <li><img src="{up}assets/img/partners/seedling-foundation.png" alt="Seedling Foundation"></li>
    </ul>
  </div>
</section>
<footer class="site-footer">
  <div class="wrap footer-row">
    <img src="{up}assets/img/logo-sfr-white.svg" alt="{ORG}" height="48">
    <address class="footer-address">{ORG}<br>Technoparkstrasse 1<br>8005 Z\u00fcrich<br>
      <a href="mailto:{CONTACT}">{CONTACT}</a></address>
    <p class="sfr-note"><a href="{up}privacy/">Privacy</a> &middot; <a href="{up}imprint/">Imprint</a> &middot; <a href="https://www.swissfoodresearch.ch/">{ORG}</a></p>
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

def list_item(e: dict, today: date, base: str = "") -> str:
    """One row of the events list. base: path from the page to /events/ ("" on /events/ itself)."""
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
        link = f'<a class="item-title" href="{base}{esc(e["slug"])}/">{esc(e["title"])}</a>'
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
    return shell(f"Events | {ORG}", body, 1, EVENTS_DESCRIPTION)


# --------------------------------------------------------------------------- services page

def service_cta(key: str, svc: dict, text: dict, links: dict, newsletter: str) -> tuple[str, str, str]:
    """Label, address and extra attributes of a service's main button on the hub. Coaching and every
    service without a button of its own lead to the hub's free 1:1 session (#book)."""
    ext = ' target="_blank" rel="noopener"'
    link = svc.get("link")
    if key == "events":
        return "See upcoming events", "../events/", ""
    if key == "news":
        return "Subscribe", newsletter, ext
    if link == "radicle":
        return f"Open {KNOWLEDGE}", "../knowledge/", ""
    if link == "ig":
        return "See upcoming IG meetings", "../events/?type=ig", ""
    if link == "booster" and links.get("booster"):
        return text.get("button") or "Visit the Booster", links["booster"], ext
    if link == "maasRequest" and links.get("maasRequest"):
        return text.get("button") or "Request MaaS", links["maasRequest"], ""
    if link == "coaching":
        return "Book a free 1:1", "#book", " data-book"
    return "Talk to us", "#book", " data-book"


def services_page(data: dict | None = None, home: dict | None = None) -> str:
    """/services/: the catalogue's public texts as the website's service finder publishes them
    (web/services.py copies them). Six questions lead to the matching services; every service has a
    detail view; all services by pillar below; the free 1:1 at the end. Signed-in members also see
    the services where they get better terms (services.js)."""
    from web.services import load as load_services
    data = load_services() if data is None else data
    home = load_home() if home is None else home
    t, st, icons = data["text"], data["structure"], data["icons"]
    ui, txt, svcs, links = t["ui"], t["services"], st["services"], t.get("links", {})
    default_q = st["default_question"]

    def icon_of(k: str) -> str:
        return f'<span class="svc-icon svc-{svcs[k]["pillar"]}">{icons[svcs[k]["icon"]]}</span>'

    def badges(k: str, best: bool = False) -> str:
        out = []
        if best:
            out.append(f'<span class="svc-badge svc-badge-best">{esc(ui["best_match"])}</span>')
        if svcs[k].get("member_advantage"):
            out.append(f'<span class="svc-badge svc-badge-member">{esc(ui["member_badge"])}</span>')
        if svcs[k].get("pilot"):
            out.append('<span class="svc-badge svc-badge-pilot">Pilot</span>')
        return f'<span class="svc-badges">{"".join(out)}</span>' if out else ""

    def card(k: str, best: bool = False, compact: bool = False, plain: bool = False) -> str:
        line = "" if compact else f'<span class="svc-line">{esc(txt[k]["line"])}</span>'
        return (f'<li><button type="button" class="svc-card{" is-compact" if compact else ""}" data-svc="{k}">'
                f'{icon_of(k)}<span class="svc-card-body"><span class="svc-title">{esc(txt[k]["title"])}</span>'
                f'{line}{"" if plain else badges(k, best)}</span></button></li>')

    qtexts = t["questions"]
    qbuttons = "".join(
        f'<button type="button" class="svc-q{" is-on" if q["id"] == default_q else ""}" data-q="{q["id"]}" '
        f'aria-pressed="{"true" if q["id"] == default_q else "false"}"><span class="svc-q-label">'
        f'{esc(qtexts[q["id"]]["label"])}</span><span class="svc-q-hint">{esc(qtexts[q["id"]]["hint"])}</span></button>'
        for q in st["questions"])
    panels = "".join(
        f'<div class="svc-panel" data-panel="{q["id"]}"{"" if q["id"] == default_q else " hidden"}>'
        f'<h3 class="svc-panel-head">{esc(qtexts[q["id"]]["heading"])}</h3>'
        f'<ol class="svc-cards">{"".join(card(k, best=(i == 0)) for i, k in enumerate(q["services"]))}</ol></div>'
        for q in st["questions"])
    first = next(q["services"][0] for q in st["questions"] if q["id"] == default_q)

    def detail(k: str) -> str:
        x, sv = txt[k], svcs[k]
        label, href, attrs = service_cta(k, sv, x, links, home["newsletter"]["url"])
        parts = [f'<p class="svc-blurb">{esc(x["blurb"])}</p>']
        if x.get("when"):
            parts.append(f'<p class="svc-when">{esc(x["when"])}</p>')
        if x.get("steps"):
            parts.append(f'<p class="svc-sub">{esc(ui["how_it_works"])}</p><ol class="svc-steps">'
                         + "".join(f"<li>{esc(step)}</li>" for step in x["steps"]) + "</ol>")
        parts.append(f'<p class="svc-sub">{esc(ui["for_whom"])}</p><p class="svc-aud">{esc(x["audience"])}</p>')
        if x.get("financing"):
            parts.append(f'<p class="svc-fin">{esc(x["financing"])}</p>')
        acts = [f'<a class="btn btn-primary btn-sm" href="{esc(href)}"{attrs} data-svc-cta="{k}">{esc(label)}</a>']
        if sv.get("next"):
            nxt = txt[sv["next"]]["title"].split(":")[0]
            acts.append(f'<button type="button" class="btn btn-secondary btn-sm" data-svc="{sv["next"]}">'
                        f'{esc(ui["next_step"])}{esc(nxt)}</button>')
        return (f'<article class="svc-item" id="s-{k}" data-item="{k}"{"" if k == first else " hidden"} '
                f'aria-labelledby="t-{k}"><div class="svc-item-head">{icon_of(k)}<div>'
                f'<p class="svc-pillar">{esc(t["pillars"][sv["pillar"]])}</p>'
                f'<h3 id="t-{k}">{esc(x["title"])}</h3>{badges(k)}</div></div>'
                + "".join(parts) + f'<div class="svc-actions">{"".join(acts)}</div></article>')

    details = "".join(detail(k) for k in svcs)
    n = len(svcs)
    cols = "".join(
        f'<div class="svc-col svc-col-{c["pillar"]}"><h3>{esc(t["pillars"][c["pillar"]])}</h3>'
        f'<ol class="svc-cards">{"".join(card(k, compact=True) for k in c["services"])}</ol></div>'
        for c in st["overview"])
    mine = [k for k in svcs if svcs[k].get("member_advantage")]
    mine_cards = "".join(card(k, compact=True, plain=True) for k in mine)
    values = "".join(f"<li>{esc(v)}</li>" for v in ui.get("values", []))
    body = f"""
<noscript><style>.svc-panel, .svc-item {{ display: block !important; }}</style></noscript>
<section class="hero svc-hero">
  <div class="wrap">
    <p class="sfr-sub01 eyebrow">Services</p>
    <h1>{esc(ui['title'])}</h1>
    <p class="lead">{esc(ui['lead'])}</p>
    <ul class="svc-values">{values}</ul>
  </div>
</section>
<div class="wrap">
  <section class="svc-mine" id="svc-mine" aria-labelledby="h-mine" hidden>
    <h2 id="h-mine" class="section-head">Your member advantages</h2>
    <p>As a member you get better terms for these {len(mine)} services.</p>
    <ol class="svc-cards svc-cards-grid">{mine_cards}</ol>
  </section>

  <section class="svc-finder" aria-labelledby="h-need">
    <h2 id="h-need" class="section-head">What do you need?</h2>
    <div class="svc-questions" role="group" aria-label="Choose what you need">{qbuttons}</div>
    <div class="svc-layout">
      <div class="svc-matches"><p class="svc-sub">{esc(ui['matches'])}</p>{panels}</div>
      <div class="svc-detail" id="svc-detail" aria-live="polite">{details}</div>
    </div>
  </section>

  <section class="svc-all" aria-labelledby="h-all">
    <h2 id="h-all" class="section-head">{esc(ui['overview_heading'].replace('{n}', str(n)))}</h2>
    <p class="svc-note">{esc(ui['overview_note'])} {esc(ui.get('financing_note', ''))}</p>
    <div class="svc-cols">{cols}</div>
  </section>

  {booking_block(home['booking'], '../')}
</div>"""
    return shell(f"Services | {ORG}", body, 1, t.get("about", {}).get("summary", ""), tab="services",
                 scripts=("services.js", "booking.js"))


# --------------------------------------------------------------------------- home page

HOME_FILE = ROOT.parent / "config" / "home.json"


def load_home(path: Path = HOME_FILE) -> dict:
    """config/home.json: hero text, the 1:1 booking link and topics, the newsletter link."""
    return json.loads(path.read_text(encoding="utf-8"))


def home_event(e: dict) -> str:
    """One upcoming SFR or Innovation Group event on the home page."""
    day, mon, yr = fmt_short(e["date"], e["year"])
    igs = [i for i in sorted(e["igs"]) if i in IG_NAMES]
    tags = [f'<span class="tag tag-{e["kind"]}">{KIND_LABEL[e["kind"]]}</span>']
    tags += [f'<span class="tag">{icon(IG_ASSET[i]) if i in IG_ASSET else ""}{esc(IG_NAMES[i])}</span>' for i in igs]
    meta = [x for x in (time_range(e), e["location"]) if x]
    href = f'events/{esc(e["slug"])}/'
    action = (f'<a class="btn btn-primary btn-sm" href="{href}#register" data-home="register" data-ref="{esc(e["slug"])}">Register</a>'
              if signup(e["url"]) else
              f'<a class="btn btn-secondary btn-sm" href="{href}" data-home="event" data-ref="{esc(e["slug"])}">Details</a>')
    return f"""<li class="item home-item">
  <div class="datebox datebox-sfr"><span class="d">{day}</span><span class="m">{mon}</span><span class="y">{yr}</span></div>
  <div class="item-body">
    <div class="tags">{''.join(tags)}</div>
    <a class="item-title" href="{href}">{esc(e['title'])}</a>
    {'<p class="item-meta">' + esc(' · '.join(meta)) + '</p>' if meta else ''}
    <div class="home-item-cta">{action}</div>
  </div>
</li>"""


def booking_block(book: dict, up: str, more: bool = False) -> str:
    """The free 1:1 session with its click-to-load Calendly calendar (home page and /services/).
    Calendly is contacted only after the click (web/static/booking.js)."""
    topics = "".join(f"<li>{esc(t)}</li>" for t in book["topics"])
    link = (f'<p class="home-browse"><a href="{up}services/" data-home="services">Or browse all our services &rarr;</a></p>'
            if more else "")
    return f"""<section class="home-book" id="book" aria-labelledby="h-book">
    <div class="home-book-text">
      <p class="sfr-sub01 home-kicker">Free 1:1 session</p>
      <h2 id="h-book">{esc(book['title'])}</h2>
      <p>{esc(book['lead'])}</p>
      <ul class="home-topics">{topics}</ul>
      <p class="home-facts">{esc(book['facts'])}</p>
      {link}
    </div>
    <div class="home-book-cal" id="book-cal">
      <div class="home-cal-gate" id="cal-gate">
        <p class="home-cal-head">Pick a time that suits you</p>
        <button class="btn btn-primary" type="button" id="cal-load" data-url="{esc(book['url'])}">Show available slots</button>
        <p class="home-cal-note">The calendar is provided by Calendly, a third-party booking service. It loads only after
        you click, and Calendly may then set cookies. <a href="{up}privacy/">Privacy</a></p>
        <p class="home-cal-alt"><a href="{esc(book['url'])}" target="_blank" rel="noopener" data-home="calendly-tab">Open in Calendly
        <span aria-hidden="true">&#8599;</span></a></p>
      </div>
    </div>
  </section>"""


def home_page(events: list[dict], today: date, cfg: dict | None = None) -> str:
    """The hub's front door: next three SFR and Innovation Group events, Pulse's top three of the
    week (shown only while Pulse serves the visitor: staff until it opens), the free 1:1 session
    with a click-to-load Calendly calendar, Radicle and the newsletter. Old events-list links
    (/?group=..&type=..&q=..) are forwarded to /events/."""
    cfg = load_home() if cfg is None else cfg
    nxt = [e for e in events if e["kind"] in ("ig", "sfr") and e["date"] and e["date"] >= today and e["slug"]][:3]
    items = "".join(home_event(e) for e in nxt) or \
        '<li class="empty">No meetings are scheduled yet. The full list includes partner events.</li>'
    pulse_for = pulse_audience()
    hero, book, news = cfg["hero"], cfg["booking"], cfg["newsletter"]
    body = f"""
<script>(function () {{ var q = new URLSearchParams(location.search);
  if (q.has("group") || q.has("type") || q.has("q")) location.replace("events/" + location.search + location.hash); }})();</script>
<section class="hero hero-photo home-hero" style="--hero-img:url({SITE_BASE}assets/img/ig-art/{esc(hero.get('image') or 'general-dark')}-wide.jpg)">
  <div class="wrap">
    <p class="sfr-sub01 eyebrow">{ORG}</p>
    <h1>{esc(hero['title'])}</h1>
    <p class="lead">{esc(hero['lead'])}</p>
    <div class="home-hero-actions">
      <a class="btn pl-cyan" href="#book" data-home="hero-book">Book a free 1:1</a>
      <a class="btn btn-inverse" href="events/" data-home="hero-events">See upcoming events</a>
    </div>
  </div>
</section>
<div class="wrap">
  <div class="home-split is-solo" id="home-split">
    <section class="home-events" aria-labelledby="h-next">
      <div class="home-head"><h2 id="h-next" class="section-head">Next events</h2>
        <a class="home-more" href="events/" data-home="all-events">All events &rarr;</a></div>
      <ol class="list">{items}</ol>
    </section>
    <section class="home-news" id="home-news" aria-labelledby="h-news" data-audience="{pulse_for}" hidden>
      <div class="home-head"><h2 id="h-news" class="section-head">Pulse: top 3 this week</h2>
        <a class="home-more" href="pulse/" data-home="pulse">More in Pulse &rarr;</a></div>
      <ol class="home-stories" id="home-stories"></ol>
      <p class="pl-ai home-ai"><span class="pl-badge">AI curated</span> Selected and summarised by AI. Each story links to its original.</p>
    </section>
  </div>

  {booking_block(book, "", more=True)}

  <div class="home-pair">
    <section class="pl-card pl-dark home-radicle" aria-labelledby="h-radicle">
      <span class="pl-badge pl-badge-inv">Members only</span>
      <h2 id="h-radicle">{KNOWLEDGE}</h2>
      <p>Topic articles on Swiss agro-food research, about 6,600 funded projects with their research gaps, and a
      funding finder that matches your idea to the right programme.</p>
      <div data-for="members" hidden><a class="btn btn-sm pl-cyan" href="knowledge/" data-home="radicle-open">Open Radicle</a></div>
      <div data-for="public"><a class="btn btn-sm pl-cyan" href="{esc(MEMBERSHIP_URL)}" data-home="radicle-member">Become a member</a>
        <button class="pl-member home-signin" type="button" data-home-signin>Members: sign in</button></div>
    </section>
    <section class="pl-card home-newsletter" aria-labelledby="h-newsletter">
      <h2 id="h-newsletter">{esc(news['title'])}</h2>
      <p>{esc(news['lead'])}</p>
      <a class="btn btn-secondary btn-sm" href="{esc(news['url'])}" target="_blank" rel="noopener" data-home="newsletter">Subscribe
      <span aria-hidden="true">&#8599;</span></a>
    </section>
  </div>
</div>"""
    return shell(f"{ORG} hub", body, 0, tab="home", scripts=("home.js", "booking.js"))


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
    <p class="crumbs"><a href="{up}events/">All events</a></p>
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


# --------------------------------------------------------------------------- pulse tab

def pulse_page() -> str:
    """Pulse: AI-curated agro-food news. An empty shell; stories load in the browser from
    functions/v1/pulse, which serves staff, members or everyone as pulse.setting 'public' says
    ('false', 'members', 'true')."""
    public = pulse_audience() == "public"
    body = f"""
<section class="hero pl-hero" id="pl-hero">
  <img class="pl-hero-art" id="pl-hero-art" alt="" hidden>
  <div class="wrap pl-hero-in">
    <div class="pl-hero-head" id="pl-hero-head">
      <div class="pl-hero-text">
        <p class="sfr-sub01 eyebrow">Pulse \u00b7 the week at a glance</p>
        <h1>What moved in agro-food this week.</h1>
      </div>
      <p class="pl-ai"><span class="pl-badge">AI curated</span> Selected and summarised by AI, with no editor. Each summary
      links to its original: read it before you quote.</p>
    </div>
    <div class="pl-tiles" id="pl-tiles"></div>
  </div>
</section>
<div class="wrap pl-wrap" id="pulse" data-membership="{MEMBERSHIP_URL}">
  <div id="pl-feed">
    <form class="filters pl-filters" id="pl-filters" role="search" onsubmit="return false" hidden>
      <div class="chips" role="group" aria-label="Region">
        <button type="button" class="chip is-on" data-scope="all" aria-pressed="true">All regions</button>
        <button type="button" class="chip" data-scope="swiss" aria-pressed="false">Switzerland</button>
        <button type="button" class="chip" data-scope="europe" aria-pressed="false">Europe</button>
        <button type="button" class="chip" data-scope="global" aria-pressed="false">Global</button>
      </div>
      <label class="visually-hidden" for="pl-q">Search Pulse</label>
      <input id="pl-q" type="search" placeholder="Search stories, companies, topics">
      <label class="visually-hidden" for="pl-sort">Sort</label>
      <select id="pl-sort">
        <option value="new">Newest</option>
        <option value="rel">Most relevant</option>
        <option value="votes">Most useful</option>
      </select>
    </form>
    <div class="chips pl-igs" id="pl-igs" role="group" aria-label="Innovation Group" hidden></div>
    <div id="pl-lead"></div>
    <h2 class="section-head pl-list-head" id="pl-grid-head" hidden>More this week</h2>
    <div class="pl-grid" id="pl-grid"></div>
    <div id="pl-list"></div>
    <p class="empty" id="pl-empty" hidden>No story matches these filters. Try another Innovation Group or region.</p>
  </div>
  <article id="pl-story" hidden></article>
  <p class="muted" id="pl-note" role="status">Loading Pulse\u2026</p>
  <div class="pl-bottom">
    <section class="pl-card pl-dark">
      <span class="pl-badge pl-badge-inv">Members only</span>
      <h2>Funding calls and tenders</h2>
      <p>Open calls and public tenders matched to your Innovation Groups are coming to Pulse for members.</p>
      <button class="btn btn-sm pl-cyan" type="button" data-pl-signin>Sign in</button>
      <a class="pl-member" href="https://www.swissfoodresearch.ch/en/membership-benefits/">Become a member</a>
    </section>
    <section class="pl-card">
      <h2>How Pulse works</h2>
      <ol class="pl-how">
        <li>We read open news feeds and the free newsletters sent to {ORG}.</li>
        <li>AI selects what matters for SFR members, writes a short English summary and groups reports of the same event.</li>
        <li>Every summary links to the original article. Pictures are SFR's own Innovation Group art.</li>
      </ol>
      <p class="pl-small"><a href="mailto:{CONTACT}?subject=Pulse%3A%20wrong%20summary">Report a wrong summary</a></p>
    </section>
  </div>
</div>
<noscript><p class="wrap">Pulse needs JavaScript.</p></noscript>"""
    page = shell(f"Pulse | {ORG}", body, 1,
                 "Pulse: what moved in Swiss and European agro-food, summarised in English with links to the originals.",
                 tab="pulse", scripts=("pulse.js",))
    if not public:
        page = page.replace("<head>", '<head>\n<meta name="robots" content="noindex">', 1)
    return page


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

PRIVACY_UPDATED = "25 November 2026"


def privacy_page() -> str:
    body = f"""
<section class="hero hero-compact"><div class="wrap">
  <p class="sfr-sub01 eyebrow">{ORG}</p>
  <h1>Privacy on the SFR hub</h1>
</div></section>
<div class="wrap block"><div class="prose">
<p class="lead">This page explains what the SFR hub (Events, Radicle \u2013 Knowledge, Pulse and the presentation
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
clicks on Register, on ads, on email buttons and on the home page's buttons, whether the 1:1 booking calendar was opened, searches and filters on the events list, and in
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

<h2>Booking a 1:1 session</h2>
<p>The home page offers a free 1:1 session booked through Calendly (Calendly LLC, USA). The booking calendar
loads only when you click "Show available slots"; until then the page contacts no Calendly server. Once it
loads, Calendly's own <a href="https://calendly.com/legal/privacy-notice">privacy notice</a> applies and Calendly
may set cookies. The details you enter in the booking form go to Calendly and to {ORG} staff, who use them
only to prepare and hold the session. The newsletter link opens a monday.com form, whose privacy terms apply.</p>

<h2>Radicle \u2013 Knowledge</h2>
<p>Searches and Funding Finder requests are processed to show results and are not saved in the hub's
database. The articles,
projects and funding programmes come from public sources and from {ORG}'s own records.</p>

<h2>Pulse</h2>
<p>Pulse shows short summaries of public news articles, written by AI, with a link to each original. When a
member marks a story as useful, the hub stores the member's email address with the story, so that each
member counts once and can withdraw the vote. Others see only the number of votes. Votes are deleted on request.</p>

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


# --------------------------------------------------------------------------- imprint

def imprint_page() -> str:
    """English translation of the German Impressum of Swiss Food Research, as supplied (25.11.2026)."""
    body = f"""
<section class="hero hero-compact"><div class="wrap">
  <p class="sfr-sub01 eyebrow">{ORG}</p>
  <h1>Imprint</h1>
</div></section>
<div class="wrap block"><div class="prose">
<h2>Contact information</h2>
<p>{ORG}<br>Technoparkstrasse 1<br>CH-8005 Z\u00fcrich<br>Mobile: +41 79 766 87 59<br>
<a href="mailto:{CONTACT}">{CONTACT}</a></p>

<h2>Commercial register entry</h2>
<p>Registered name: {ORG}<br>Number: CHE-371.512.462<br>Commercial register office: Z\u00fcrich</p>

<h2>VAT number</h2>
<p>CHE-371.512.462 MWST</p>

<h2>Management</h2>
<p>Dr Lucas Grob, Managing Director<br>Wolfram Br\u00fcck, President</p>

<h2>Disclaimer</h2>
<p>The author accepts no liability for the correctness, accuracy, timeliness, reliability or
completeness of the information.</p>
<p>Liability claims against the author for material or immaterial damage arising from access to, use
or non-use of the published information, from misuse of the connection or from technical faults
are excluded.</p>
<p>The author expressly reserves the right to change, supplement or delete parts of the pages or the
entire offering without separate notice, or to suspend publication temporarily or permanently.</p>

<h2>Liability for links</h2>
<p>References and links to third-party websites lie outside our area of responsibility. Any
responsibility for such websites is declined. Access to and use of such websites is at the user's
own risk.</p>

<h2>Copyright</h2>
<p>The copyright and all other rights to content, images, photos or other files on the website belong
exclusively to the association {ORG} or to the specifically named rights holders. The written
consent of the copyright holders must be obtained in advance for the reproduction of any element.</p>
</div></div>"""
    return shell(f"Imprint | {ORG}", body, 1, f"Imprint of {ORG}.", tab="")


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
    (out / "index.html").write_text(home_page(events, today))
    (out / "events").mkdir()
    (out / "events" / "index.html").write_text(index_page(events, today))
    (out / "services").mkdir()
    (out / "services" / "index.html").write_text(services_page())
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
    (out / "pulse").mkdir()
    (out / "pulse" / "index.html").write_text(pulse_page())
    (out / "stats").mkdir()
    (out / "stats" / "index.html").write_text(stats_page())
    (out / "imprint").mkdir()
    (out / "imprint" / "index.html").write_text(imprint_page())
    (out / "privacy").mkdir()
    (out / "privacy" / "index.html").write_text(privacy_page())
    (out / "404.html").write_text(shell(f"Not found | {ORG}", '<div class="wrap block"><h1>Page not found</h1>'
                                        f'<p><a href="{SITE_BASE}events/">All events</a> &middot; <a href="{SITE_BASE}">Hub home</a></p></div>', 0))
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
