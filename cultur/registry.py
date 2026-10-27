import json
import re
from functools import lru_cache
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / "registry" / "cases.json"


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


@lru_cache(maxsize=1)
def load() -> list[dict]:
    return json.loads(PATH.read_text(encoding="utf-8"))["cases"]


def names_of(case: dict) -> list[str]:
    return list(case["names"]) + [a["name"] for a in case.get("aliases", [])]


def find_by_name(text: str) -> list[dict]:
    n = norm(text)
    return [c for c in load() if n and n in {norm(x) for x in names_of(c)}]


def find_by_wallet(addr: str) -> list[dict]:
    a = addr.lower()
    return [c for c in load() if any(w.get("address", "").lower() == a for w in c.get("wallets", []))]


def by_id(id_: str):
    return next((c for c in load() if c["id"] == id_), None)
