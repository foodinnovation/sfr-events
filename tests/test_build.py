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
