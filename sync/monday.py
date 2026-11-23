"""Read the two monday boards the calendar needs. Read-only: this job never writes to monday."""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from datetime import date, time as dtime

import requests

API = "https://api.monday.com/v2"
EVENTS_BOARD = 1689148147      # Events Planung
ATTENDEES_BOARD = 5091086886   # Events attendees

EVENT_COLS = [
    "date4", "hour_mm6kjj7w", "hour_mm6kwxn2", "standort__1", "long_text",
    "link_mm1k2xn3", "color_mm6k7es5",
]
SUB_COLS = ["prio_mkkcr5f0", "boards_verbinden__1", "spiegel8__1", "status", "checkbox__1"]
ATT_COLS = ["email_mm06mp9t", "text_mm06eddp"]


@dataclass
class Session:
    monday_subitem_id: int
    start_time: str | None
    title: str
    speakers: list[dict]
    consent: bool


@dataclass
class Event:
    monday_item_id: int
    group_id: str
    group_title: str
    name: str
    event_date: date | None
    start_time: dtime | None
    end_time: dtime | None
    location: str | None
    summary: str | None
    signup_url: str | None
    website_status: str | None
    sessions: list[Session] = field(default_factory=list)


@dataclass
class AttendeeGroup:
    monday_group_id: str
    title: str


@dataclass
class Attendee:
    monday_item_id: int
    group_id: str
    email: str | None
    status_raw: str | None


class Monday:
    def __init__(self, token: str | None = None):
        self.token = token or os.environ["MONDAY_TOKEN"]

    def gql(self, query: str, variables: dict | None = None) -> dict:
        for attempt in range(5):
            r = requests.post(
                API,
                json={"query": query, "variables": variables or {}},
                headers={"Authorization": self.token, "API-Version": "2025-04",
                         "Content-Type": "application/json"},
                timeout=60,
            )
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2 ** attempt * 3)
                continue
            r.raise_for_status()
            body = r.json()
            errors = body.get("errors") or body.get("error_message")
            if errors:
                if "complexity" in json.dumps(errors).lower() and attempt < 4:
                    time.sleep(20)
                    continue
                raise RuntimeError(f"monday API error: {errors}")
            return body["data"]
        raise RuntimeError("monday API: too many retries")

    def _items(self, board: int, item_fields: str):
        first = f"""query($board:[ID!]) {{ boards(ids:$board) {{ items_page(limit:200) {{
            cursor items {{ {item_fields} }} }} }} }}"""
        nxt = f"""query($cursor:String!) {{ next_items_page(limit:200, cursor:$cursor) {{
            cursor items {{ {item_fields} }} }} }}"""
        page = self.gql(first, {"board": [board]})["boards"][0]["items_page"]
        while True:
            yield from page["items"]
            if not page["cursor"]:
                break
            page = self.gql(nxt, {"cursor": page["cursor"]})["next_items_page"]

    def groups(self, board: int) -> list[AttendeeGroup]:
        data = self.gql("query($b:[ID!]){ boards(ids:$b){ groups { id title } } }", {"b": [board]})
        return [AttendeeGroup(g["id"], g["title"]) for g in data["boards"][0]["groups"]]

    # ------------------------------------------------------------------ events

    def events(self) -> list[Event]:
        cols = json.dumps(EVENT_COLS)
        subcols = json.dumps(SUB_COLS)
        fields = f"""id name group {{ id title }}
            column_values(ids:{cols}) {{ id text value }}
            subitems {{ id name column_values(ids:{subcols}) {{
                id text value
                ... on BoardRelationValue {{ display_value }}
                ... on MirrorValue {{ display_value }} }} }}"""
        return [self._event(i) for i in self._items(EVENTS_BOARD, fields)]

    @staticmethod
    def _event(item: dict) -> Event:
        cv = {c["id"]: c for c in item["column_values"]}
        sessions = []
        for s in item.get("subitems") or []:
            sc = {c["id"]: c for c in s["column_values"]}
            if (sc.get("status", {}).get("text") or "") != "Zugesagt":
                continue
            names = _split(sc.get("boards_verbinden__1", {}).get("display_value"))
            orgs = _split(sc.get("spiegel8__1", {}).get("display_value"))
            speakers = [{"name": n, "organisation": orgs[i] if i < len(orgs) else None}
                        for i, n in enumerate(names)]
            sessions.append(Session(
                monday_subitem_id=int(s["id"]),
                start_time=(sc.get("prio_mkkcr5f0", {}).get("text") or None),
                title=s["name"].strip(),
                speakers=speakers,
                consent=(sc.get("checkbox__1", {}).get("text") or "") == "v",
            ))
        return Event(
            monday_item_id=int(item["id"]),
            group_id=item["group"]["id"],
            group_title=item["group"]["title"],
            name=item["name"].strip(),
            event_date=_date(cv.get("date4")),
            start_time=_hour(cv.get("hour_mm6kjj7w")),
            end_time=_hour(cv.get("hour_mm6kwxn2")),
            location=(cv.get("standort__1", {}).get("text") or None),
            summary=(cv.get("long_text", {}).get("text") or None),
            signup_url=_link(cv.get("link_mm1k2xn3")),
            website_status=(cv.get("color_mm6k7es5", {}).get("text") or None),
            sessions=sessions,
        )

    # ------------------------------------------------------------------ attendees

    def attendees(self) -> list[Attendee]:
        cols = json.dumps(ATT_COLS)
        fields = f"id group {{ id }} column_values(ids:{cols}) {{ id text }}"
        out = []
        for i in self._items(ATTENDEES_BOARD, fields):
            cv = {c["id"]: c["text"] for c in i["column_values"]}
            email = (cv.get("email_mm06mp9t") or "").strip().lower() or None
            out.append(Attendee(int(i["id"]), i["group"]["id"], email, cv.get("text_mm06eddp") or None))
        return out


# ---------------------------------------------------------------------- parsing helpers

def _split(display: str | None) -> list[str]:
    return [p.strip() for p in (display or "").split(",") if p.strip()]


def _date(col: dict | None) -> date | None:
    if not col:
        return None
    try:
        v = json.loads(col["value"]) if col.get("value") else {}
        if v.get("date"):
            return date.fromisoformat(v["date"])
    except (ValueError, TypeError):
        pass
    text = (col.get("text") or "")[:10]
    try:
        return date.fromisoformat(text) if text else None
    except ValueError:
        return None


def _hour(col: dict | None) -> dtime | None:
    if not col or not col.get("value"):
        return None
    try:
        v = json.loads(col["value"])
        return dtime(int(v["hour"]), int(v.get("minute") or 0))
    except (ValueError, TypeError, KeyError):
        return None


def _link(col: dict | None) -> str | None:
    if not col:
        return None
    try:
        v = json.loads(col["value"]) if col.get("value") else {}
        if v.get("url"):
            return v["url"].strip()
    except (ValueError, TypeError):
        pass
    text = col.get("text") or ""
    # text form is "label - https://..."
    for part in text.split(" "):
        if part.startswith("http"):
            return part.strip()
    return None
