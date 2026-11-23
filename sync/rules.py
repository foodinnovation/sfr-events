"""Pure business rules for the SFR event calendar. No I/O here, so it is easy to test.

Decisions (Lucas, 23.11.2026):
- Groups on Events Planung decide the kind: "Innovationsgruppen" and
  "SFR Events / co-organizing Events" are internal, "Events" is external.
  The "Partner Event" checkbox is ignored.
- Internal events appear once they have a date, unless Website Status is
  "Nicht publizieren". External events appear only when Website Status is
  "Bereit für Website" (or the older "Publiziert").
- Attendees keep access unless their status is a cancellation or a no-show
  ("Not Attending", "excused", "no show" in any spelling). Blank keeps access.
- Attendee groups are matched to events by the date in the group title,
  with the event name as tie-breaker.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date

# --------------------------------------------------------------------------- kinds

GROUP_KIND = {
    "new_group76309": "ig",          # Innovationsgruppen
    "new_group80213": "sfr",         # SFR Events / co-organizing Events
    "neue_gruppe8981__1": "external",  # Events
}

STATUS_DO_NOT_PUBLISH = "Nicht publizieren"
STATUS_PUBLISH = {"Bereit für Website", "Publiziert"}


def kind_for_group(group_id: str) -> str | None:
    """None means the item is not an event (e.g. 'Kommunikation Generell')."""
    return GROUP_KIND.get(group_id)


def is_published(kind: str, event_date: date | None, website_status: str | None) -> bool:
    if event_date is None:
        return False
    status = (website_status or "").strip()
    if kind in ("ig", "sfr"):
        return status != STATUS_DO_NOT_PUBLISH
    return status in STATUS_PUBLISH


# --------------------------------------------------------------------------- attendees

NO_ACCESS_STATUSES = {"notattending", "excused", "noshow"}


def normalise_status(raw: str | None) -> str:
    return re.sub(r"[^a-z]", "", (raw or "").lower())


def attendee_has_access(raw_status: str | None) -> bool:
    """Mirrors the generated column events.attendee.has_access."""
    return normalise_status(raw_status) not in NO_ACCESS_STATUSES


# --------------------------------------------------------------------------- IG detection

# Wiki ig_groups ids. Order matters: specific ZGL regions before the generic ZGL.
IG_PATTERNS: list[tuple[int, str]] = [
    (1, r"aqua(culture|kultur)"),
    (2, r"getreide|g\s*&\s*b\b|grains|baked|backwaren"),
    (3, r"coffee|kaffee"),
    (4, r"packaging|verpackung"),
    (5, r"insect|insekt"),
    (6, r"digital|\bdigi\b"),
    (7, r"proteins?\s*4\s*future|\bp4f\b"),
    (8, r"non[-\s]?thermal|\bntp\b"),
    (9, r"bioconversion|\bbiocon\b"),
    (10, r"cocoa|chocolat|schoko|kakao"),
    (11, r"fungi|pilze?\b"),
    (13, r"\bcarbon\b"),
    (15, r"zgl\s*(lu\b|luzern)|luzern|agrarzukunft"),
    (16, r"jura|jurassien|agriculture du futur"),
    (17, r"espace\s*mittelland|zgl\s*(bern|em\b)"),
    (14, r"sustainable\s*nutrition|\bsunu\b"),
]
ZGL_FAMILY = {12, 15, 16, 17}
_ZGL_GENERIC = r"\bzgl\b|future\s*proof\s*farming|zukunftsgericht"


def detect_igs(name: str) -> list[int]:
    text = fold(name)
    found = [ig for ig, pat in IG_PATTERNS if re.search(pat, text)]
    if not any(ig in ZGL_FAMILY for ig in found) and re.search(_ZGL_GENERIC, text):
        found.append(12)
    return found


def meeting_igs(igs: list[int]) -> set[int]:
    """IG ids whose wiki meetings may belong to an event with these IGs.
    ZGL meetings were filed under several ids over the years."""
    out = set(igs)
    if out & ZGL_FAMILY:
        out |= ZGL_FAMILY
    return out


# --------------------------------------------------------------------------- text helpers

def fold(text: str) -> str:
    """Lower case, accents removed, '&' kept."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.lower()


_STOP = {
    "meeting", "meetings", "of", "the", "and", "innovation", "innovations", "group", "groups",
    "ig", "treffen", "der", "die", "des", "du", "de", "la", "le", "groupe", "d", "dinnovation",
    "rencontre", "innovationsgruppe", "event", "joint", "with", "x", "of", "for", "-", "",
}


def tokens(text: str) -> set[str]:
    t = fold(text)
    # ordinals in any language become n<number>: 18th, 18., 18tes, 18eme, 18ème
    t = re.sub(r"\b(\d{1,3})\s*(st|nd|rd|th|tes|te|ten|eme|er|e|\.)(?=\s|$|\W)", r" n\1 ", t)
    words = re.findall(r"[a-z0-9]+", t)
    return {w for w in words if w not in _STOP}


def text_hash(*parts: str | None) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update((p or "").encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()[:16]


# --------------------------------------------------------------------------- attendee group matching

_GROUP_TITLE = re.compile(r"^\s*(\d{4}-\d{2}-\d{2})\s*/\s*(.+)$")
_EXCLUDE_GROUP = re.compile(r"\btest\b|^neue gruppe$|^new group$", re.I)


def parse_group_title(title: str) -> tuple[date | None, str]:
    m = _GROUP_TITLE.match(title or "")
    if not m:
        return None, (title or "").strip()
    try:
        return date.fromisoformat(m.group(1)), m.group(2).strip()
    except ValueError:
        return None, (title or "").strip()


@dataclass
class Candidate:
    event_key: object          # monday item id or db id
    name: str
    event_date: date | None
    kind: str


@dataclass
class GroupMatch:
    method: str                # date | date_name | excluded | none
    event_key: object | None
    note: str = ""
    candidates: list[str] = field(default_factory=list)


def name_score(group_name: str, event_name: str) -> float:
    g_igs, e_igs = set(detect_igs(group_name)), set(detect_igs(event_name))
    score = 0.0
    if g_igs:
        shared = g_igs & e_igs
        if shared:
            score += 2.0 * len(shared)
        elif g_igs & ZGL_FAMILY and e_igs & ZGL_FAMILY:
            score += 1.5          # ZGL generic vs regional name of the same group
        elif not e_igs:
            score -= 1.0
        else:
            score -= 2.0
    gt, et = tokens(group_name), tokens(event_name)
    if gt and et:
        score += len(gt & et) / len(gt | et) * 3.0
        # same meeting number is a strong signal (18th Insects vs 17th Insects)
        g_num = {t for t in gt if re.fullmatch(r"n\d+", t)}
        e_num = {t for t in et if re.fullmatch(r"n\d+", t)}
        if g_num and e_num:
            score += 1.5 if g_num & e_num else -1.5
    return score


MARGIN = 0.75


def match_group(title: str, events: list[Candidate]) -> GroupMatch:
    if _EXCLUDE_GROUP.search((title or "").strip()):
        return GroupMatch("excluded", None, "test or empty group")
    gdate, gname = parse_group_title(title)

    if gdate is None:
        ranked = sorted(events, key=lambda e: name_score(gname, e.name), reverse=True)
        best = [e for e in ranked[:3] if name_score(gname, e.name) > 1.0]
        note = "no date in group title"
        if best:
            note += "; closest: " + "; ".join(f"{e.name} ({e.event_date})" for e in best)
        return GroupMatch("none", None, note, [e.name for e in best])

    same_day = [e for e in events if e.event_date == gdate]
    if not same_day:
        return GroupMatch("none", None, f"no event on {gdate}")
    if len(same_day) == 1:
        e = same_day[0]
        # a lone same-day event with a clearly different name is still worth a look
        warn = "" if name_score(gname, e.name) > 0 else "check: names differ"
        return GroupMatch("date", e.event_key, warn, [e.name])

    scored = sorted(((name_score(gname, e.name), e) for e in same_day), key=lambda x: x[0], reverse=True)
    (s1, e1), (s2, _) = scored[0], scored[1]
    names = [f"{e.name} [{s:.1f}]" for s, e in scored]
    if s1 > 0 and s1 - s2 >= MARGIN:
        return GroupMatch("date_name", e1.event_key, "", names)
    return GroupMatch("none", None, f"{len(same_day)} events on {gdate}, names too close", names)
