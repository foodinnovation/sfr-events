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
