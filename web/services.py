"""SFR services for the hub's /services/ page.

The texts are not written here. The website's service finder (repo foodinnovation/sfr-service-finder,
kept in step with the SFR Service Catalogue 2027 by the service-finder-sync skill) publishes them in
English with its structure and icons. The sync job copies them into data/services/ before each build:

    python -m web.services --refresh data/services

A copy is kept only when it is complete (every service has a text and an icon, every question names
known services). Otherwise the last good copy stays, so the hub never shows half a catalogue.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

FINDER = "https://foodinnovation.github.io/sfr-service-finder/"
CACHE = Path(__file__).resolve().parent.parent / "data" / "services"
UA = {"User-Agent": "sfr-hub-sync (+https://hub.swissfoodresearch.ch)"}


def _get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read()


def problems(text: dict, structure: dict, icons: dict[str, str]) -> list[str]:
    """What is missing or inconsistent in a finder copy; empty when it can be used."""
    out = []
    svc, txt = structure.get("services") or {}, text.get("services") or {}
    if not svc:
        out.append("no services")
    for k, s in svc.items():
        t = txt.get(k) or {}
        for f in ("title", "line", "blurb", "audience"):
            if not t.get(f):
                out.append(f"{k}: no {f}")
        if s.get("icon") not in icons:
            out.append(f"{k}: icon {s.get('icon')} missing")
        if s.get("next") and s["next"] not in svc:
            out.append(f"{k}: next step {s['next']} unknown")
    for q in structure.get("questions") or []:
        if q.get("id") not in (text.get("questions") or {}):
            out.append(f"question {q.get('id')}: no text")
        out += [f"question {q.get('id')}: unknown service {x}" for x in q.get("services", []) if x not in svc]
    for col in structure.get("overview") or []:
        out += [f"overview: unknown service {x}" for x in col.get("services", []) if x not in svc]
    if structure.get("default_question") not in {q.get("id") for q in structure.get("questions") or []}:
        out.append("default question unknown")
    return out


def clean_icon(svg: str) -> str:
    """Design-system icon as inline SVG that takes the surrounding text colour."""
    svg = re.sub(r"<\?xml[^>]*>|<!--.*?-->", "", svg, flags=re.S).strip()
    svg = re.sub(r'fill="#[0-9a-fA-F]{3,6}"', 'fill="currentColor"', svg)
    return svg.replace("<svg ", '<svg aria-hidden="true" focusable="false" ', 1)


def refresh(cache: Path = CACHE, base: str = FINDER) -> list[str]:
    """Copy the finder's English content and icons into cache; returns the problems (empty = updated)."""
    try:
        text = json.loads(_get(base + "content/en.json"))
        structure = json.loads(_get(base + "content/structure.json"))
        names = sorted({s.get("icon") for s in structure.get("services", {}).values() if s.get("icon")})
        icons = {n: clean_icon(_get(f"{base}assets/icons/{n}.svg").decode("utf-8")) for n in names}
    except Exception as e:  # network, JSON or HTTP error: keep the last good copy
        return [f"could not read the service finder: {e}"]
    issues = problems(text, structure, icons)
    if issues:
        return issues
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "en.json").write_text(json.dumps(text, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (cache / "structure.json").write_text(json.dumps(structure, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (cache / "icons.json").write_text(json.dumps(icons, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    return []


def load(cache: Path = CACHE) -> dict:
    """The last good copy: {'text': en.json, 'structure': structure.json, 'icons': {name: svg}}."""
    return {"text": json.loads((cache / "en.json").read_text(encoding="utf-8")),
            "structure": json.loads((cache / "structure.json").read_text(encoding="utf-8")),
            "icons": json.loads((cache / "icons.json").read_text(encoding="utf-8"))}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", metavar="DIR", default=str(CACHE))
    a = ap.parse_args()
    issues = refresh(Path(a.refresh))
    if issues:
        print("services: kept the last good copy:", "; ".join(issues[:10]), file=sys.stderr)
    else:
        print("services: copied from the service finder")
    return 0  # never block a sync because the finder is unreachable


if __name__ == "__main__":
    raise SystemExit(main())
