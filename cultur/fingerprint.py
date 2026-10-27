"""Build a Qloo-derived cultural fingerprint from resolved anchor entity IDs. Parsing is defensive;
unrecognised shapes produce empty lists, never invented values."""
import asyncio
from typing import Optional

from .qloo import QlooClient, ent_id, entities_of, tags_of

CATEGORIES = ["urn:entity:artist", "urn:entity:brand", "urn:entity:person", "urn:entity:place"]


def _ent(e: dict, rank: int) -> dict:
    tags = []
    for t in e.get("tags") or []:
        tid = isinstance(t, dict) and (t.get("tag_id") or t.get("id") or t.get("name"))
        if tid:
            tags.append({"id": tid, "name": t.get("name") or tid})
    q = e.get("query") if isinstance(e.get("query"), dict) else {}
    return {"id": ent_id(e), "name": e.get("name"), "rank": rank,
            "affinity_raw": q.get("affinity", e.get("affinity", e.get("score"))),  # scale unverified: preserved as-is
            "popularity": e.get("popularity"), "tags": tags,
            "audience_growth": (q.get("measurements") or {}).get("audience_growth") if isinstance(q.get("measurements"), dict) else None}


def _audience(data) -> dict:
    """Verified: results.demographics[0].query = {age:{bucket:signed score}, gender:{...}} (aggregated audience)."""
    res = data.get("results") if isinstance(data, dict) else None
    items = res.get("demographics") if isinstance(res, dict) else None
    if isinstance(items, list) and items and isinstance(items[0], dict) and isinstance(items[0].get("query"), dict):
        qd = items[0]["query"]
        return {k: v for k, v in qd.items() if k in ("age", "gender") and isinstance(v, dict)}
    return {}


async def build(q: QlooClient, anchors: list[str], take: int = 10) -> dict:
    """Returns {entities:{cat:[...]}, tags:[...], audience:[...], calls:[{ref,freshness,ok,error,what}]}."""
    calls = []
    jobs = [q.insights(anchors, c, take, fresh=True) for c in CATEGORIES]
    jobs.append(q.insights(anchors, "urn:tag", take, fresh=True))
    jobs.append(q.insights(anchors, "urn:demographics", take, fresh=True))
    res = await asyncio.gather(*jobs, return_exceptions=True)
    out = {"entities": {}, "tags": [], "audience": {}, "momentum": {}, "calls": calls}
    labels = CATEGORIES + ["urn:tag", "urn:demographics"]
    for label, r in zip(labels, res):
        if isinstance(r, Exception):
            calls.append({"what": label, "ok": False, "error": type(r).__name__, "ref": "", "freshness": "n/a"})
            continue
        calls.append({"what": label, "ok": r.ok, "error": r.error, "ref": r.ref, "freshness": r.freshness, "ts": r.fetched_at})
        if not r.ok:
            continue
        if label == "urn:tag":
            out["tags"] = [{"id": t.get("tag_id") or t.get("id") or t.get("name"), "name": t.get("name"),
                            "affinity_raw": (t.get("query") or {}).get("affinity") if isinstance(t.get("query"), dict) else t.get("affinity")}
                           for t in tags_of(r.data)][:take]
        elif label == "urn:demographics":
            out["audience"] = _audience(r.data)
        else:
            ents = [_ent(e, i) for i, e in enumerate(entities_of(r.data)) if ent_id(e)]
            if ents:
                out["entities"][label.split(":")[-1]] = ents
                growth = [e["audience_growth"] for e in ents if isinstance(e.get("audience_growth"), (int, float))]
                if growth:
                    out["momentum"][label.split(":")[-1]] = {"audience_growth_values": growth[:10],
                        "note": "Raw query.measurements.audience_growth of associated entities; meaning/scale not interpreted."}
    return out


def weight_map(fp: dict, popularity_weight) -> tuple[dict, dict]:
    """Rank-based weights (scale-free): w = 1/(1+rank), discounted for very popular items."""
    ents, tags = {}, {}
    for cat, items in fp.get("entities", {}).items():
        for e in items:
            ents[e["id"]] = max(ents.get(e["id"], 0.0), popularity_weight(e.get("popularity")) / (1 + e["rank"]))
            for t in e.get("tags", []):
                tags[t["id"]] = max(tags.get(t["id"], 0.0), 0.5 / (1 + e["rank"]))
    for i, t in enumerate(fp.get("tags", [])):
        if t.get("id"):
            tags[t["id"]] = max(tags.get(t["id"], 0.0), 1.0 / (1 + i))
    return ents, tags
