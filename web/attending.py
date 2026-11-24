"""Member organisations attending an upcoming event: the logo block on its page.

Registrations (events.attendee, read from the monday board Events attendees) are matched to
members by exact email domain, the same rule that gives members access to presentations
(events.is_member_email). Departments of one institution share a domain and get one tile.
Cancellations and no-shows do not count. Registrations from non-member organisations are only
counted (distinct domains, freemail left out); nothing about them is shown.

Logos come from the Logo column of the monday board Mitglieder, the source the SFR Design
System 2026 takes its member logos from. Only the logos needed for upcoming events are
downloaded, at build time, and served from the hub itself. No logo is stored in the repository.

Settings: config/logo_wall.json (on/off, minimum, maximum, exclusions).
"""
from __future__ import annotations

import io
import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

MEMBERS_BOARD_LOGO_COL = "filejn1oxvcs"
CONFIG_FILE = Path(__file__).resolve().parent.parent / "config" / "logo_wall.json"

# Freemail and SFR's own domain: never counted as an organisation.
FREEMAIL = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.ch", "live.com", "msn.com",
    "yahoo.com", "yahoo.de", "yahoo.fr", "icloud.com", "me.com", "mac.com", "gmx.ch", "gmx.net",
    "gmx.de", "gmx.at", "bluewin.ch", "sunrise.ch", "hispeed.ch", "swissonline.ch", "protonmail.com",
    "proton.me", "web.de", "t-online.de", "orange.fr", "free.fr", "aol.com", "mail.com", "posteo.de",
    "netplus.ch", "quickline.ch", "vtxmail.ch", "bluemail.ch", "green.ch", "yandex.com",
}
OWN_DOMAINS = {"swissfoodresearch.ch"}

# Display names for institutions whose departments are separate members (same as the website's
# member logo wall, foodinnovation/member-logo-wall).
INSTITUTIONS = [(r"^ZHAW\b", "ZHAW"), (r"^FIBL\b", "FiBL"), (r"^BFH\b", "BFH"), (r"ETH ?Z", "ETH Zürich"),
                (r"^Agroscope\b", "Agroscope"), (r"^HES-SO\b", "HES-SO"),
                (r"^(Fresh Food|Bischofszell)", "Fresh Food & Beverage Group")]
# White or light logos named in the design system's member-logo notes: dark tile.
FORCE_DARK = [r"No Normal", r"Oniro", r"Acad[eé]mie du Caf[eé]|EC Successfood", r"Mediplant", r"Mieli",
              r"Vivent", r"Changins", r"Cluster Food"]


@dataclass
class Org:
    domain: str
    names: list[str]
    item_ids: list[int]
    logo: str | None = None          # file name under assets/members/
    dark: bool = False

    @property
    def name(self) -> str:
        for pat, inst in INSTITUTIONS:
            if any(re.search(pat, n, re.I) for n in self.names):
                return inst
        return min(self.names, key=len)


@dataclass
class Attending:
    members: list[Org] = field(default_factory=list)
    others: int = 0


def load_config(path: Path = CONFIG_FILE) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"enabled": False}


def domain_of(email: str | None) -> str:
    return (email or "").strip().lower().rpartition("@")[2]


def collect(conn, today: date, cfg: dict) -> dict[str, Attending]:
    """event id -> member organisations and the count of other organisations, for every upcoming
    event that reaches the configured minimum. Empty when the block is switched off."""
    if not cfg.get("enabled"):
        return {}
    exclude = {x.strip().lower() for x in cfg.get("exclude") or []}
    with conn.cursor() as cur:
        cur.execute(
            """select g.event_id::text, lower(a.email)
               from events.attendee a
               join events.attendee_group g on g.monday_group_id = a.group_id
               join events.event e on e.id = g.event_id
               where a.has_access and a.email like '%%@%%' and e.removed_at is null
                 and e.event_date >= %s""", [today])
        regs = cur.fetchall()
        cur.execute(
            """select lower(domain), item_id, name from public.crm_members
               where status in ('active', 'foundations - no voting rights') and domain is not null""")
        members: dict[str, list[tuple[int, str]]] = {}
        for dom, item_id, name in cur.fetchall():
            members.setdefault(dom, []).append((int(item_id), name))

    per_event: dict[str, dict[str, set]] = {}
    for event_id, email in regs:
        dom = domain_of(email)
        if not dom or dom in FREEMAIL or dom in OWN_DOMAINS:
            continue
        slot = per_event.setdefault(event_id, {"members": set(), "others": set()})
        (slot["members"] if dom in members else slot["others"]).add(dom)

    out: dict[str, Attending] = {}
    minimum = int(cfg.get("min_members") or 5)
    for event_id, slot in per_event.items():
        orgs = []
        for dom in slot["members"]:
            entries = members[dom]
            org = Org(dom, [n for _, n in entries], [i for i, _ in entries])
            if dom in exclude or any(n.strip().lower() in exclude for n in org.names) or org.name.lower() in exclude:
                continue
            orgs.append(org)
        if len(orgs) >= minimum:
            orgs.sort(key=lambda o: o.name.casefold())
            out[event_id] = Attending(orgs, len(slot["others"]))
    return out


# ------------------------------------------------------------------ logos

def slug(text: str) -> str:
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:60] or "logo"


def _light(rgb: tuple[int, int, int]) -> bool:
    r, g, b = rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 200


def svg_is_light(svg: bytes) -> bool:
    """True when every colour named in the SVG is light (a white logo)."""
    text = svg.decode("utf-8", "ignore").lower()
    colours = []
    for m in re.finditer(r"(?:fill|stroke|stop-color|color)\s*[:=]\s*[\"']?\s*(#[0-9a-f]{3,6}\b|white|black|rgb\([^)]*\))", text):
        v = m.group(1)
        if v == "white":
            colours.append((255, 255, 255))
        elif v == "black":
            colours.append((0, 0, 0))
        elif v.startswith("rgb"):
            nums = [int(float(x)) for x in re.findall(r"[\d.]+", v)[:3]]
            if len(nums) == 3:
                colours.append(tuple(nums))
        else:
            h = v[1:]
            h = "".join(c * 2 for c in h) if len(h) == 3 else h
            if len(h) == 6:
                colours.append(tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)))
    return bool(colours) and all(_light(c) for c in colours)


def web_logo(data: bytes, ext: str) -> tuple[bytes, str, bool]:
    """(bytes, extension, needs a dark tile). SVG as supplied; raster shrunk to tile size as WebP."""
    from PIL import Image
    if ext == "svg":
        if b"<svg" not in data[:4096].lower() or re.search(rb"<script|onload=|javascript:", data, re.I):
            raise ValueError("not a plain SVG")
        return data, "svg", svg_is_light(data)
    Image.MAX_IMAGE_PIXELS = None
    im = Image.open(io.BytesIO(data))
    im = im.convert("RGBA")
    im.thumbnail((320, 160), Image.LANCZOS)
    raw = im.tobytes()
    px = [tuple(raw[i:i + 4]) for i in range(0, len(raw), 4)]
    opaque = [p for p in px if p[3] > 32]
    transparent_share = 1 - len(opaque) / max(1, len(px))
    light_share = sum(1 for p in opaque if _light(p[:3])) / max(1, len(opaque))
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=86, method=6)
    return buf.getvalue(), "webp", transparent_share >= 0.05 and light_share >= 0.9


def fetch_logos(mon, attending: dict[str, Attending]) -> dict[str, bytes]:
    """Downloads the logos the pages need from the monday board Mitglieder and sets each
    organisation's logo and tile colour. Returns file name -> bytes. A logo that cannot be used
    leaves its organisation as a name tile; it never stops the build."""
    import requests
    orgs = {o.domain: o for a in attending.values() for o in a.members}
    ids = sorted({i for o in orgs.values() for i in o.item_ids})
    assets: dict[int, dict] = {}
    for k in range(0, len(ids), 50):
        data = mon.gql(
            """query($ids:[ID!]) { items(ids:$ids, limit:50) { id
                 assets(assets_source: columns, column_ids:["%s"]) { name file_extension public_url } } }"""
            % MEMBERS_BOARD_LOGO_COL, {"ids": ids[k:k + 50]})
        for it in data["items"]:
            a = [x for x in it.get("assets") or [] if x.get("public_url")]
            if a:
                assets[int(it["id"])] = a[-1]
    files: dict[str, bytes] = {}
    for org in orgs.values():
        asset = next((assets[i] for i in org.item_ids if i in assets), None)
        if asset:
            ext = (asset.get("file_extension") or ".png").lower().lstrip(".")
            try:
                r = requests.get(asset["public_url"], timeout=60)
                r.raise_for_status()
                data, out_ext, dark = web_logo(r.content, "svg" if ext == "svg" else ext)
                name = f"{slug(org.name)}.{out_ext}"
                files[name] = data
                org.logo, org.dark = name, dark
            except Exception as exc:  # noqa: BLE001
                print(f"::warning::logo for {org.name} not usable ({type(exc).__name__}); shown as a name tile")
        if any(re.search(p, n, re.I) for p in FORCE_DARK for n in org.names):
            org.dark = True
    return files
