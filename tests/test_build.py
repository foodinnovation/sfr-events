"""Pure helpers of the site builder: sign-up links, map links, IG assets."""
from pathlib import Path

from web import build as b

STATIC = Path(b.ROOT) / "static" / "img" / "ig"


def test_tito_link_is_embedded():
    r = b.signup("https://ti.to/swissfoodresearch-events/aquaculture_day27")
    assert r["kind"] == "tito" and r["ref"] == "swissfoodresearch-events/aquaculture_day27"


def test_eventbrite_link_is_embedded():
    r = b.signup("https://www.eventbrite.ch/e/future-food-symposium-tickets-123456789012?aff=x")
    assert r["kind"] == "eventbrite" and r["ref"] == "123456789012"


def test_other_links_stay_links_and_old_sfr_pages_are_dropped():
    assert b.signup("https://forms.cloud.microsoft/e/3M3NVpvqzi")["kind"] == "link"
    assert b.signup("https://www.swissfoodresearch.ch/de/veranstaltungen/aquaculture-day/") is None
    assert b.signup(None) is None and b.signup("tbd") is None


def test_maps_link_only_for_physical_places():
    url = b.maps_url("Givaudan International SA, Kemptpark, Kemptthal, Schweiz")
    assert url.startswith("https://www.google.com/maps/search/?api=1&query=Givaudan+International")
    for place in (None, "", "Online", "Webinar (Zoom)", "MS Teams", "https://zoom.us/j/1"):
        assert b.maps_url(place) is None


def test_every_ig_asset_exists():
    for name in set(b.IG_ASSET.values()):
        assert (STATIC / f"{name}.svg").is_file(), name
    for name in set(b.IG_ASSET.values()) - b.IG_NO_PICTURE:
        assert (STATIC / f"{name}.webp").is_file(), name


def test_icons_carry_no_scripts():
    for f in STATIC.glob("*.svg"):
        t = f.read_text().lower()
        assert "<script" not in t and "onload" not in t and "javascript:" not in t, f.name


def test_programme_times_and_order():
    rows = [dict(time=b.clock(t), title=n, speakers=[]) for t, n in
            [("10", "2 Talk"), ("9.30", "1 Welcome"), ("14.00", "9 Algae"), (None, "7 Fungi"), ("10.20", "3 Value")]]
    out = b.tidy_programme(rows)
    assert [r["time"] for r in out] == ["09:30", "10:00", "10:20", "14:00", None]
    assert [r["title"] for r in out] == ["Welcome", "Talk", "Value", "Algae", "Fungi"]


def test_numbers_kept_when_not_every_row_is_numbered():
    rows = [dict(time="09:00", title="3 Gründe für Pilze", speakers=[]), dict(time="10:00", title="Pause", speakers=[])]
    assert b.tidy_programme(rows)[0]["title"] == "3 Gründe für Pilze"


def test_email_never_shown_as_speaker_name():
    out = b.public_speakers([{"name": "someone@example.org", "organisation": "Cosaic"},
                             {"name": "Matthias  Schultz", "organisation": "Givaudan"}])
    assert out == [{"name": "Cosaic", "organisation": ""}, {"name": "Matthias Schultz", "organisation": "Givaudan"}]


def test_knowledge_page_is_an_empty_members_shell():
    html = b.knowledge_page()
    # radicle's layout: sidebar tree, tab bar, graph pane, quick switcher, sign-in gate
    for el in ('id="topic-tree"', 'id="tabbar"', 'id="graphpane"', 'id="switcher"', 'id="auth-gate"',
               'id="nav-funding-finder"'):
        assert el in html
    # libraries are bundled: no third-party requests
    assert "knowledge/vendor/marked.min.js" in html and "knowledge/vendor/force-graph.min.js" in html
    assert "fonts.googleapis" not in html and "cdn." not in html
    assert 'class="kn-page"' in html
    assert "—" not in html


def _ev(**kw):
    from datetime import date
    e = dict(id=1, kind="ig", title="15th Meeting of the Innovation Group Bioconversion", date=date(2026, 12, 3),
             year=2026, igs={9}, location=None, url=None, summary=None, decks=[], sessions=[], start=None, end=None,
             slug="x", source="monday")
    e.update(kw)
    return e


def test_upcoming_ig_meeting_without_programme_invites_topic_ideas():
    from datetime import date
    from urllib.parse import unquote
    html = b.event_page(_ev(), date(2026, 11, 23))
    assert "We are preparing the programme together with the steering board of the Innovation Group Bioconversion" in html
    assert "Suggest a topic" in html
    assert "mailto:contact@swissfoodresearch.ch?subject=Topic%20idea%20for%20Innovation%20Group%20Bioconversion" in html
    assert "15th Meeting of the Innovation Group Bioconversion" in unquote(html)


def test_no_topic_invitation_once_programme_is_out_past_or_not_an_ig_meeting():
    from datetime import date
    today = date(2026, 11, 23)
    with_prog = _ev(sessions=[dict(time="13:00", title="Welcome", speakers=[])])
    assert "Suggest a topic" not in b.event_page(with_prog, today)
    assert "Suggest a topic" not in b.event_page(_ev(date=date(2026, 10, 1), year=2026), today)
    assert "Suggest a topic" not in b.event_page(_ev(kind="external", igs=set()), today)
    assert "Suggest a topic" not in b.event_page(_ev(igs=set()), today)   # e.g. Members Webinar


def test_joint_meeting_names_both_groups():
    from datetime import date
    html = b.event_page(_ev(igs={9, 7}), date(2026, 11, 23))
    assert "steering boards of the Innovation Groups Proteins4Future and Bioconversion" in html
    assert "Topic%20idea%20for%20Innovation%20Groups%20Proteins4Future%20and%20Bioconversion" in html


def test_ads_follow_the_settings_file():
    import json
    from pathlib import Path
    ads = json.loads(Path("config/ads.json").read_text())
    html = b.ad_cards(ads)
    assert 'data-ad="membership" data-audience="public"' in html
    assert "https://www.swissfoodresearch.ch/en/membership-benefits/" in html and "280+" in html
    assert 'data-ad="novel_food"' in html and 'data-groups="7 5 11 9"' in html
    assert 'data-ad="coaching"' in html and "data-general" in html
    assert html.count('class="ad" hidden') == 10
    assert "—" not in html
    # one service off: its card goes, its groups fall back to the general ads
    ads["services"]["maas"]["enabled"] = False
    assert 'data-ad="maas"' not in b.ad_cards(ads)
    # all off
    ads["enabled"] = False
    assert b.ad_cards(ads) == ""


def test_index_page_carries_ads_only_when_switched_on():
    from datetime import date
    on = b.index_page([], date(2026, 11, 23), ads={"enabled": True, "slot": 3, "membership": {
        "enabled": True, "label": "L", "headline": "H", "body": "B", "cta": "C", "href": "https://x"}})
    assert 'class="ad" hidden' in on and 'data-ad-slot="3"' in on
    off = b.index_page([], date(2026, 11, 23), ads={"enabled": False})
    assert 'class="ad"' not in off


def test_attending_block():
    from datetime import date
    from web import attending as att
    orgs = [att.Org(f"m{i}.ch", [f"Member {i:02d}"], [i], logo=f"member-{i:02d}.webp" if i % 2 else None, dark=i == 3)
            for i in range(14)]
    a = att.Attending(orgs, 9)
    html = b.attending_block(a, {"max_logos": 12})
    assert html.count('class="lw-tile') == 12
    assert "and 2 more member organisations" in html and "plus 9 other organisations" in html
    assert 'class="lw-tile lw-dark"' in html and "assets/members/member-01.webp" in html
    assert '<span class="lw-name">Member 00</span>' in html     # no logo: name tile
    assert "@" not in html                                         # no addresses, no people
    # upcoming pages carry it, past pages never
    e = _ev()
    assert "Member organisations attending" in b.event_page(e, date(2026, 11, 23), a, {})
    assert "Member organisations attending" not in b.event_page(e, date(2026, 12, 4), a, {})


def test_web_logo_and_light_detection():
    import io
    from PIL import Image
    from web import attending as att
    white = Image.new("RGBA", (200, 100), (0, 0, 0, 0))
    for x in range(40, 160):
        for y in range(30, 70):
            white.putpixel((x, y), (255, 255, 255, 255))
    buf = io.BytesIO(); white.save(buf, "PNG")
    data, ext, dark = att.web_logo(buf.getvalue(), "png")
    assert ext == "webp" and dark
    black = Image.new("RGB", (200, 100), (20, 20, 20)); buf = io.BytesIO(); black.save(buf, "JPEG")
    assert att.web_logo(buf.getvalue(), "jpg")[2] is False
    assert att.svg_is_light(b'<svg><path fill="#fff"/><path style="fill:white"/></svg>')
    assert not att.svg_is_light(b'<svg><path fill="#204e82"/><path fill="#fff"/></svg>')
    import pytest
    with pytest.raises(ValueError):
        att.web_logo(b'<svg onload="alert(1)"></svg>', "svg")


def test_privacy_and_statistics_pages():
    from datetime import date
    priv = b.privacy_page()
    for part in ("Usage counting", "No IP address, email address, cookie or", "13 months", "Technoparkstrasse 1",
                 "privacy-policy", "Federal Data Protection and Information Commissioner"):
        assert part in priv
    assert "—" not in priv
    st = b.stats_page()
    assert 'name="robots" content="noindex"' in st and "assets/stats.js" in st and 'id="stats-out"' in st
    # every page: the Statistics tab exists but stays hidden until app.js sees staff; footer links privacy
    page = b.home_page([], date(2026, 11, 24))
    assert '<a hidden data-staff-only class="hub-tab" href="stats/">Statistics</a>' in page
    assert '<a href="privacy/">Privacy</a>' in page


def test_pulse_page_and_tab_follow_the_settings_file(tmp_path, monkeypatch):
    from datetime import date
    cfg = tmp_path / "pulse.json"
    monkeypatch.setattr(b, "PULSE_FILE", cfg)
    # no file or public false: staff-only tab, page not indexed
    cfg.write_text('{"public": false}')
    monkeypatch.setattr(b, "load_pulse", lambda path=cfg: __import__("json").loads(cfg.read_text()))
    page = b.home_page([], date(2026, 11, 24))
    assert '<a hidden data-staff-only class="hub-tab" href="pulse/">Pulse</a>' in page
    pl = b.pulse_page()
    assert 'name="robots" content="noindex"' in pl
    assert "assets/pulse.js" in pl and 'id="pl-list"' in pl and 'id="pl-story"' in pl
    assert 'id="pl-tiles"' in pl and 'id="pl-grid"' in pl and 'id="pl-hero-art"' in pl
    # every Innovation Group art file the page script asks for ships with the site
    js = (b.ROOT / "static" / "pulse.js").read_text()
    import re
    for art in set(re.findall(r'"([a-z0-9-]+)",\n\s+"[A-Z]', js)) | {"general-dark"}:
        for size in ("card", "wide"):
            assert (b.ROOT / "static" / "img" / "ig-art" / f"{art}-{size}.jpg").exists(), art
    assert 'class="hub-tab is-on" href="../pulse/" aria-current="page"' in pl
    # what the user asked to leave out: feed counts, the relevance cut-off
    for gone in ("57 ", "4 or 5", "rated 4", "every three hours"):
        assert gone not in pl
    assert "—" not in pl and "fonts.googleapis" not in pl
    # public: an ordinary tab, indexable
    cfg.write_text('{"public": true}')
    page = b.home_page([], date(2026, 11, 24))
    assert '<a class="hub-tab" href="pulse/">Pulse</a>' in page
    assert 'name="robots"' not in b.pulse_page()


def test_privacy_page_explains_pulse_votes():
    priv = b.privacy_page()
    assert "<h2>Pulse</h2>" in priv and "marks a story as useful" in priv


def test_footer_supported_by_and_imprint():
    from datetime import date
    page = b.home_page([], date(2026, 11, 25))
    i = [page.index(x) for x in ("minerva-foundation.svg", "avina.png", "seedling-foundation.png")]
    assert i == sorted(i) and "Supported by" in page
    assert "Presentations are available to members" not in page
    assert "Technoparkstrasse 1<br>8005 Zürich" in page and "Postfach" not in page
    assert '<a href="imprint/">Imprint</a>' in page
    imp = b.imprint_page()
    for part in ("CHE-371.512.462", "CHE-371.512.462 MWST", "Dr Lucas Grob, Managing Director", "Wolfram Brück, President",
                 "+41 79 766 87 59", "mailto:contact@swissfoodresearch.ch", "Liability for links", "Copyright"):
        assert part in imp
    assert "peter.braun" not in imp and "Postfach" not in imp and "—" not in imp


def _event(i, kind, d, slug=None, url=None, igs=()):
    from datetime import time
    return dict(id=i, slug=slug or f"e{i}", kind=kind, ig=None, title=f"Event {i}", summary="", date=d, year=d.year,
                start=time(9), end=time(12), location="Technopark Zürich", url=url, source="monday",
                sessions=[], decks=[], igs=set(igs))


def test_home_page_shows_next_three_sfr_and_ig_events_only():
    from datetime import date
    today = date(2026, 11, 25)
    evs = [_event(1, "ig", date(2026, 11, 20)),                      # past
           _event(2, "external", date(2026, 11, 26), url="https://x.example"),   # partner: not on home
           _event(3, "ig", date(2026, 12, 3), url="https://ti.to/swissfoodresearch-events/x", igs=(9,)),
           _event(4, "sfr", date(2026, 12, 10)),
           _event(5, "ig", date(2027, 1, 28)),
           _event(6, "sfr", date(2027, 2, 4))]                        # fourth: not on home
    page = b.home_page(evs, today)
    assert [f'href="events/e{i}/"' in page for i in (1, 2, 3, 4, 5, 6)] == [False, False, True, True, True, False]
    assert 'href="events/e3/#register"' in page and "Register" in page        # sign-up link: Register
    assert 'href="events/e4/" data-home="event"' in page                      # none: Details
    assert "Bioconversion" in page and 'href="events/"' in page
    assert "<h1>Turning agro-food innovation into market success" in page
    assert "—" not in page and "&mdash;" not in page


def test_home_page_keeps_calendly_and_pulse_off_until_asked():
    from datetime import date
    page = b.home_page([], date(2026, 11, 25))
    cfg = b.load_home()
    # Calendly only as a link and a data attribute: no iframe, no script from Calendly before the click
    assert f'data-url="{cfg["booking"]["url"]}"' in page and "<iframe" not in page
    assert "assets.calendly.com" not in page and "calendly.com/assets" not in page
    assert "Free, for members and non-members" in page and "Show available slots" in page
    # Pulse block hidden in the HTML; home.js shows it only when the function serves the visitor
    assert 'id="home-news" aria-labelledby="h-news" data-public="0" hidden' in page
    assert "assets/home.js" in page and "No meetings are scheduled yet" in page
    # Radicle card for everyone; newsletter goes to the monday form; hero picture from the Design System
    assert 'href="knowledge/"' in page and b.MEMBERSHIP_URL in page
    assert cfg["newsletter"]["url"] in page
    assert f'--hero-img:url({b.SITE_BASE}assets/img/ig-art/{cfg["hero"]["image"]}-wide.jpg)' in page
    assert (b.ROOT / "static" / "img" / "ig-art" / f'{cfg["hero"]["image"]}-wide.jpg').exists()


def test_old_events_list_links_are_forwarded():
    from datetime import date
    page = b.home_page([], date(2026, 11, 25))
    assert 'q.has("group") || q.has("type") || q.has("q")' in page and 'location.replace("events/"' in page


def test_events_list_lives_under_events(tmp_path):
    from datetime import date
    d = date(2026, 12, 3)
    evs = [_event(3, "ig", d)]
    lst = b.index_page(evs, date(2026, 11, 25), ads={"enabled": False})
    assert 'href="e3/"' in lst and 'href="events/e3/"' not in lst            # relative to /events/
    assert 'href="../assets/site.css"' in lst and '<a class="hub-tab is-on" href="../events/"' in lst
    ev = b.event_page(evs[0], date(2026, 11, 25))
    assert '<p class="crumbs"><a href="../../events/">All events</a></p>' in ev
    b.build(tmp_path / "s", evs, date(2026, 11, 25))
    assert (tmp_path / "s" / "index.html").read_text().count('id="home-split"') == 1
    assert 'id="filters"' in (tmp_path / "s" / "events" / "index.html").read_text()
    assert (tmp_path / "s" / "events" / "e3" / "index.html").exists()
    assert 'href="/events/">All events</a>' in (tmp_path / "s" / "404.html").read_text()


def test_privacy_page_explains_calendly():
    priv = b.privacy_page()
    assert "<h2>Booking a 1:1 session</h2>" in priv and "loads only when you click" in priv


# ---------------------------------------------------------------- services page

def _svc_data():
    from web import services as sv
    return sv.load()


def test_services_copy_is_complete_and_checked():
    from web import services as sv
    d = _svc_data()
    assert sv.problems(d["text"], d["structure"], d["icons"]) == []
    assert len(d["structure"]["services"]) == 16
    broken = {"services": dict(d["text"]["services"])}
    broken["services"].pop("maas")
    assert any("maas" in p for p in sv.problems({**d["text"], **broken}, d["structure"], d["icons"]))
    assert 'fill="currentColor"' in d["icons"]["rocket"] and 'aria-hidden="true"' in d["icons"]["rocket"]


def test_services_refresh_keeps_last_copy_when_finder_is_down(tmp_path):
    from web import services as sv
    issues = sv.refresh(tmp_path / "svc", base="http://127.0.0.1:9/")   # nothing listens there
    assert issues and not (tmp_path / "svc").exists()


def test_services_page_content_and_buttons():
    d = _svc_data()
    page = b.services_page(d)
    t, st = d["text"], d["structure"]
    for k, x in t["services"].items():                        # every service: card and detail
        assert f'data-item="{k}"' in page and b.esc(x["title"]) in page
    for q in st["questions"]:                                 # every question
        assert f'data-q="{q["id"]}"' in page
    default = st["default_question"]
    assert f'class="svc-q is-on" data-q="{default}"' in page
    assert f'<div class="svc-panel" data-panel="{default}">' in page          # default panel open
    assert 'href="#book" data-book data-svc-cta="coach">Book a free 1:1' in page
    assert 'href="../knowledge/" data-svc-cta="radicle"' in page
    assert 'href="../events/?type=ig" data-svc-cta="ig"' in page
    assert 'href="../events/" data-svc-cta="events"' in page
    assert b.load_home()["newsletter"]["url"] in page
    assert 'data-svc-cta="amp">Talk to us' in page                            # no button of its own
    assert 'id="svc-mine" aria-labelledby="h-mine" hidden' in page            # members only, via JS
    assert "As a member you get better terms for these 9 services." in page
    assert "<h2 id=\"h-all\" class=\"section-head\">All 16 services at a glance</h2>" in page
    assert 'id="cal-load"' in page and "<iframe" not in page                  # Calendly on click only
    assert "assets/services.js" in page and "assets/booking.js" in page
    import re
    # no prices; the only amount allowed is the Booster grant (funding, not a price)
    assert all(page[m.end():m.end() + 3] == " 39" for m in re.finditer("CHF", page))
    assert "—" not in page
    assert '<a class="hub-tab is-on" href="../services/" aria-current="page">Services</a>' in page


def test_services_tab_and_home_link():
    from datetime import date
    home = b.home_page([], date(2026, 11, 25))
    assert '<a class="hub-tab" href="services/">Services</a>' in home
    assert 'href="services/" data-home="services">Or browse all our services' in home
    assert "assets/booking.js" in home


def test_build_writes_services_page(tmp_path):
    from datetime import date
    b.build(tmp_path / "s", [], date(2026, 11, 25))
    assert 'id="svc-detail"' in (tmp_path / "s" / "services" / "index.html").read_text()


def test_knowledge_tab_is_called_knowledge():
    from datetime import date
    page = b.home_page([], date(2026, 11, 25))
    assert '<a class="hub-tab" href="knowledge/">Knowledge</a>' in page
    assert "Radicle \u2013 Knowledge" in page          # the Radicle card keeps the full name
