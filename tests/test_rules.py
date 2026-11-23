"""Tests for sync.rules, using real names from the monday boards (23.11.2026)."""
from datetime import date

import pytest

from sync.rules import (
    Candidate, attendee_has_access, detect_igs, is_published, kind_for_group,
    match_group, parse_group_title, tokens,
)

D = date.fromisoformat

# Events Planung items around the attendee-group dates (subset, real names).
EVENTS = [
    Candidate(3312937416, "Workshop AgrarMarktPionier", D("2026-12-10"), "ig"),
    Candidate(3266818871, "Members Webinar", D("2026-11-10"), "sfr"),
    Candidate(3087242684, "Dialog 2030 für nachhaltige", D("2026-11-10"), "external"),
    Candidate(3277549192, "19th IG G&B", D("2026-11-12"), "ig"),
    Candidate(2666616897, "7. Treffen IG ZGL LU", D("2026-11-19"), "ig"),
    Candidate(2898087817, "18th IG Insects", D("2026-11-17"), "ig"),
    Candidate(2949803966, "15th Meeting of the Innovation Group Proteins4Future", D("2026-11-17"), "ig"),
    Candidate(3303195798, "Food Ingredients Europe", D("2026-11-17"), "external"),
    Candidate(3236406885, "5ème rencontre du groupe d'innovation jurassien \"Agriculture du Futur\"", D("2026-10-22"), "ig"),
    Candidate(3220250530, "IB FFF - WS Swiss Future Farm - the last one!", D("2026-10-22"), "sfr"),
    Candidate(3292324105, "SVIAL Panel Discussion - Swiss Agriculture and Climate Change", D("2026-10-22"), "external"),
    Candidate(3039827296, "Aquaculture Day 2027 - Smart Fish, Smart Systems", D("2027-02-04"), "ig"),
    Candidate(2666620991, "1. Treffen IG ZGL Espace Mittelland", D("2026-11-05"), "ig"),
    Candidate(2790849036, "11th IG Fungi", D("2026-10-15"), "ig"),
    Candidate(2997420572, "AIMday@UniBE Rethinking Food Systems", D("2026-10-15"), "external"),
    Candidate(2982920838, "15th Meeting of the Innovation Group Bioconversion", D("2026-12-03"), "ig"),
    Candidate(3039785915, "16th Meeting of the Innovation Group Digitalization", D("2026-09-10"), "ig"),
    Candidate(3217597490, "Collége ONG AgroImpact", D("2026-09-10"), "external"),
    Candidate(2548415527, "Innovation Catalyst Day", D("2026-01-27"), "sfr"),
    Candidate(2103354360, "Aquaculture Day 2026 - How much is the Fish?", D("2026-01-19"), "ig"),
    Candidate(1928828861, "1. Aquaculture Day", D("2026-01-19"), "sfr"),
    Candidate(2006590997, "SHL Kitchen Battle", D("2026-01-19"), "sfr"),
    Candidate(2566667953, "SIPI Symposium Davos", D("2026-01-19"), "external"),
    Candidate(2544824073, "AFIF: Farming Healthy Diets", D("2026-09-07"), "sfr"),
    Candidate(5076232915, "6tes Treffen IG ZGL Luzern", D("2026-03-10"), "ig"),
    Candidate(2690695341, "Dagora Deep Tech Dive Food", D("2026-03-10"), "external"),
    Candidate(2748216528, "Arbeitsgruppentreffen #AvenirAlimentaire", D("2026-03-10"), "external"),
    Candidate(2819499861, "59th Meeting of the IG Cocoa & Chocolate and Coffee", D("2026-10-20"), "ig"),
    Candidate(2693536012, "16th IG Coffee", D("2026-10-20"), "ig"),
    Candidate(2914353040, "New Members Webinar", D("2026-06-16"), "sfr"),
    Candidate(3015663707, "Kickoff - Biosphäre", D("2026-06-16"), "sfr"),
    Candidate(2561969760, "7. Internationale Konferenz MUVA", D("2026-06-16"), "external"),
    Candidate(2875273995, "4ème rencontre du groupe d'innovation jurassien \"Agriculture du Futur\"", D("2026-06-22"), "ig"),
    Candidate(2673368854, "14th Meeting IG Bioconversion", D("2026-06-25"), "ig"),
    Candidate(2738926771, "11th Meeting IG Packaging X Cirvalis", D("2026-06-23"), "ig"),
    Candidate(2029917468, "17th Meeting IG Insects", D("2026-06-18"), "ig"),
    Candidate(2806056688, "International Food Innovation Conference (GDI)", D("2026-06-18"), "external"),
    Candidate(3007535944, "KI Prognosen in der Backbranche - Webinar GoNina", D("2026-06-18"), "external"),
    Candidate(2873135312, "15th Meeting IG Digitalization", D("2026-06-04"), "ig"),
    Candidate(2955316310, "BFH HAFL Alumni", D("2026-06-04"), "external"),
    Candidate(2673360971, "14th Meeting IG Proteins4Future", D("2026-06-02"), "ig"),
    Candidate(2680104673, "GDI x Action Jam Frühling Event", D("2026-06-02"), "external"),
    Candidate(2960257943, "#AvenirAlimentaire: Schwarmraum", D("2026-06-02"), "external"),
    Candidate(2673390623, "1st Meeting IG Sustainable Nutrition", D("2026-05-21"), "ig"),
    Candidate(2811702463, "Innovation in Food Nebenströmen - Circular Tour de Suisse", D("2026-05-21"), "external"),
    Candidate(2853941087, "Social Business Conference 2026", D("2026-05-21"), "external"),
    Candidate(2638141828, "58th Meeting IG Cocoa & Chocolate", D("2026-05-12"), "ig"),
    Candidate(2748694500, "IB FFF WS Dicifood", D("2026-05-12"), "sfr"),
    Candidate(2889209920, "GV Brennpunkt Nahrung", D("2026-05-12"), "external"),
    Candidate(1745152286, "15th Meeting IG Coffee", D("2026-05-05"), "ig"),
    Candidate(2063629748, "18. Meeting IG Grains & Baked Goods", D("2026-05-05"), "ig"),
    Candidate(2576645867, "15. Ökobilanz-Plattform Landwirtschaft", D("2026-05-05"), "external"),
    Candidate(5005746090, "10th IG Fungi", D("2026-03-24"), "ig"),
]

EXPECTED = {
    "2026-12-10 / Workshop Marktvalidierung": ("date", 3312937416),
    "2026-11-10 / Members Webinar": ("date_name", 3266818871),
    "2026-11-12 / Innovation Group Grains & Baked Goods": ("date", 3277549192),
    "2026-11-19 / Innovationsgruppe Zukunftsgerichtete Landwirtschaft Luzern": ("date", 2666616897),
    "2026-11-17 / 18th Meeting of the Innovation Group Insects": ("date_name", 2898087817),
    "2026-11-17 / 15th Meeting of Innovation Group Proteins4Future": ("date_name", 2949803966),
    "2026-10-22 / 5ème rencontre du groupe d'innovation jurassien Agriculture du Futur": ("date_name", 3236406885),
    "2027-02-04 / Aquaculture Day 2027": ("date", 3039827296),
    "2026-11-05 / Innovationsgruppe Zukunftsgerichtete Landwirtschaft Espace Mittelland": ("date", 2666620991),
    "2026-10-15 / 11th Meeting of Innovation Group Fungi & Fungal Systems": ("date_name", 2790849036),
    "2026-12-03 / 15th Meeting of Innovation Group Bioconversion": ("date", 2982920838),
    "2026-09-10 / 16th Meeting of the Innovation Group Digitalization": ("date_name", 3039785915),
    "2026-01-27 / Innovation Catalyst Day": ("date", 2548415527),
    "2026-03-10 / 6tes Treffen der Innovationsgruppe Zukunftsgerichtete Landwirtschaft Kanton Luzern": ("date_name", 5076232915),
    "2026-03-10 / 6th Meeting of the Innovation Future Proof Farming": ("date_name", 5076232915),
    "2026-10-20 / Joint Event: Innovation Groups Cocoa & Chocolate & Coffee": ("date_name", 2819499861),
    "2026-06-16 / New Members Webinar": ("date_name", 2914353040),
    "2026-06-22 / 4ème rencontre du groupe d'innovation jurassien \"Agriculture du Futur\"": ("date", 2875273995),
    "2026-06-25 / 14th Meeting of the Innovation Group Bioconversion": ("date", 2673368854),
    "2026-06-23 / 11th Meeting IG Packaging with Cirvalis": ("date", 2738926771),
    "2026-06-18 / 17th Meeting of the Innovation Group Insects": ("date_name", 2029917468),
    "2026-06-04 / 15th Meeting of the Innovation Group Digitalization": ("date_name", 2873135312),
    "2026-06-02 / 14th Meeting of the Innovation Group Proteins4Future": ("date_name", 2673360971),
    "2026-05-21 / 1st Meeting of the Innovation Group Sustainable Nutrition": ("date_name", 2673390623),
    "2026-05-12 / 58th Meeting of the IG Cocoa & Chocolate": ("date_name", 2638141828),
    "2026-05-05 / 15th Meeting of the Innovation Group Coffee": ("date_name", 1745152286),
    "2026-05-05 / 18th Meeting of the Innovation Group Grains & Baked Goods": ("date_name", 2063629748),
    "2026-03-24 / 10th meeting of the Innovation Group Fungi & Fungal Systems": ("date", 5005746090),
}


@pytest.mark.parametrize("title,expected", EXPECTED.items())
def test_real_groups_match(title, expected):
    m = match_group(title, EVENTS)
    assert (m.method, m.event_key) == expected, m


def test_two_aquaculture_days_on_one_date_go_to_review():
    m = match_group("2026-01-19 / Aquaculture Day 2026", EVENTS)
    assert m.method == "none" and "names too close" in m.note


def test_group_without_date_suggests_afif():
    m = match_group("General Assembly & Agro Food Innovation Forum 2026", EVENTS)
    assert m.method == "none" and m.event_key is None


def test_no_event_on_date():
    m = match_group("2026-03-02 / Webinar: Route2Market Call", EVENTS)
    assert m.method == "none" and "no event on" in m.note


@pytest.mark.parametrize("title", ["2026-07-05 / Test Event Webhooks", "Neue Gruppe"])
def test_excluded_groups(title):
    assert match_group(title, EVENTS).method == "excluded"


@pytest.mark.parametrize("status,ok", [
    ("Attending", True), ("online", True), ("", True), (None, True),
    ("Not Attending", False), ("not attending", False), ("not Attending", False),
    ("no show", False), ("No Show", False), ("no-show", False),
    ("excused", False), ("Excused", False),
])
def test_attendee_access(status, ok):
    assert attendee_has_access(status) is ok


def test_publish_rules():
    d = D("2026-12-01")
    assert is_published("ig", d, None)
    assert is_published("sfr", d, "")
    assert not is_published("ig", d, "Nicht publizieren")
    assert not is_published("ig", None, None)
    assert not is_published("external", d, None)
    assert is_published("external", d, "Bereit für Website")
    assert is_published("external", d, "Publiziert")
    assert not is_published("external", d, "Fehler")


def test_group_kinds():
    assert kind_for_group("new_group76309") == "ig"
    assert kind_for_group("new_group80213") == "sfr"
    assert kind_for_group("neue_gruppe8981__1") == "external"
    assert kind_for_group("neue_gruppe__1") is None


@pytest.mark.parametrize("name,igs", [
    ("59th Meeting of the IG Cocoa & Chocolate and Coffee", {3, 10}),
    ("19th IG G&B", {2}),
    ("7. Treffen IG ZGL LU", {15}),
    ("1. Treffen IG ZGL Espace Mittelland", {17}),
    ("5ème rencontre du groupe d'innovation jurassien \"Agriculture du Futur\"", {16}),
    ("6th Meeting of the Innovation Future Proof Farming", {12}),
    ("15th Meeting of the Innovation Group Proteins4Future", {7}),
    ("Members Webinar", set()),
])
def test_detect_igs(name, igs):
    assert set(detect_igs(name)) == igs


def test_ordinals_normalise():
    assert "n18" in tokens("18th IG Insects")
    assert "n18" in tokens("18. Meeting IG Grains")
    assert "n6" in tokens("6tes Treffen")
    assert "n5" in tokens("5ème rencontre")


def test_parse_group_title():
    assert parse_group_title("2026-11-17 / 18th Meeting") == (D("2026-11-17"), "18th Meeting")
    assert parse_group_title("Neue Gruppe") == (None, "Neue Gruppe")
