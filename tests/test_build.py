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
    page = b.index_page([], date(2026, 11, 24), ads={"enabled": False})
    assert '<a hidden data-staff-only class="hub-tab" href="stats/">Statistics</a>' in page
    assert '<a href="privacy/">Privacy</a>' in page
