"""Radicle – Knowledge copy step: parsing, writing, and who may read."""
import os

import pytest

from sync import knowledge as k


def test_instrument_parsing():
    item = {"id": "123", "name": " Innosuisse innovation project ", "column_values": [
        {"id": "text_mkxwas09", "text": "Innosuisse"}, {"id": "color_mky8wv9", "text": "yes"},
        {"id": "dropdown_mky8chs3", "text": "CH"}, {"id": "text_Mjj3ZlYt", "text": ""},
        {"id": "date_mm4xdqb6", "text": "2026-11-26"}, {"id": "date_mm4xyrmk", "text": "2027-04-28"},
        {"id": "color_mm4xd6af", "text": "recurring (multiple cutoffs)"}, {"id": "color_mm4x9nkz", "text": "grant"}]}
    r = k.parse_instrument(item, 2027)
    assert r["name"] == "Innosuisse innovation project" and r["funder"] == "Innosuisse"
    assert r["active"] is True and r["status"] == "yes" and r["check_year"] == 2027
    assert r["location"] == "CH" and r["project_topic"] is None
    assert r["verified_on"] == "2026-11-26" and r["deadline"] == "2027-04-28" and r["funding_type"] == "grant"
    # likely counts as active; no, unclear, empty and closed calls do not
    def with_(status, dtype=""):
        cv = [c for c in item["column_values"] if c["id"] not in ("color_mky8wv9", "color_mm4xd6af")]
        return k.parse_instrument({**item, "column_values": cv + [{"id": "color_mky8wv9", "text": status},
                                                                  {"id": "color_mm4xd6af", "text": dtype}]})
    assert with_("likely")["active"] is True and with_("likely")["status"] == "likely"
    assert with_("no")["active"] is False and with_("unclear")["active"] is False
    assert with_("yes", "closed")["active"] is False
    assert with_("")["status"] is None and with_("Ja")["status"] == "yes"
    assert k.parse_instrument({**item, "column_values": []})["active"] is False


def test_password_from_pasted_connection_string(monkeypatch):
    monkeypatch.setenv("RADICLE_DB_PASSWORD", " 'postgresql://knowledge_reader.x:[s3cret]@host:5432/postgres' ")
    assert k.radicle_password() == "s3cret"
    monkeypatch.setenv("RADICLE_DB_PASSWORD", "plain")
    assert k.radicle_password() == "plain"
    monkeypatch.delenv("RADICLE_DB_PASSWORD")
    assert k.radicle_password() is None


def test_contacts_carry_no_email_addresses():
    assert not any("@" in str(v) for c in k.CONTACTS for v in c.values())
    assert sum(1 for c in k.CONTACTS if c.get("fallback")) == 1
