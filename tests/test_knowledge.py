"""Radicle – Knowledge copy step: parsing, writing, and who may read."""
import os

import pytest

from sync import knowledge as k


def test_instrument_parsing():
    item = {"id": "123", "name": " Innosuisse innovation project ", "column_values": [
        {"id": "text_mkxwas09", "text": "Innosuisse"}, {"id": "color_mky8wv9", "text": "Yes"},
        {"id": "dropdown_mky8chs3", "text": "CH"}, {"id": "text_Mjj3ZlYt", "text": ""}]}
    r = k.parse_instrument(item)
    assert r["name"] == "Innosuisse innovation project" and r["funder"] == "Innosuisse"
    assert r["active_2026"] is True and r["location"] == "CH" and r["project_topic"] is None
    assert k.parse_instrument({**item, "column_values": []})["active_2026"] is False


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
