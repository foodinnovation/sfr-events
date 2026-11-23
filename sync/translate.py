"""English translation of event texts with the Claude API.

Each event is translated once and stored with a hash of its source text, so a
translation only reruns when someone edits the text on monday. Texts already in
English come back unchanged.
"""
from __future__ import annotations

import json
import os
import time

import requests

API = "https://api.anthropic.com/v1/messages"
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")

SYSTEM = """You translate event listings of Swiss Food Research into English for its website.
Rules:
- Return JSON only, with exactly the keys you were given.
- If a value is already English, return it unchanged.
- Keep names of people, organisations, places, products and event brands as they are.
- Keep the meaning and the register; do not add, summarise or embellish.
- Plain text, no markdown. No em dashes.
- Common terms: "Innovationsgruppe" = "Innovation Group", "Treffen" = "Meeting",
  "Zukunftsgerichtete Landwirtschaft" = "Future Proof Farming"."""


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def translate(fields: dict[str, str | None]) -> dict[str, str | None]:
    """fields: {key: text}. Empty values are passed through untouched."""
    todo = {k: v for k, v in fields.items() if v and v.strip()}
    if not todo:
        return dict(fields)
    body = {
        "model": MODEL,
        "max_tokens": 4000,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": json.dumps(todo, ensure_ascii=False)}],
    }
    headers = {
        "x-api-key": os.environ["ANTHROPIC_API_KEY"],
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    for attempt in range(4):
        r = requests.post(API, json=body, headers=headers, timeout=120)
        if r.status_code in (429, 500, 502, 503, 529):
            time.sleep(5 * (attempt + 1))
            continue
        r.raise_for_status()
        text = "".join(b.get("text", "") for b in r.json()["content"])
        text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        out = json.loads(text)
        result = dict(fields)
        for k in todo:
            if isinstance(out.get(k), str) and out[k].strip():
                result[k] = out[k].strip()
        return result
    raise RuntimeError("translation API: too many retries")
